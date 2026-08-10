-- =============================================================================
-- Freeze pre-2025 general-ledger history
--
-- The books are fully audited through 2024-12-31, so the QuickBooks sync now
-- imports only transactions dated 2025-01-01 or later (FINANCIALS_START_DATE
-- / JOB_COSTS_START_DATE in src/lib/quickbooks.ts). Already-imported ledger
-- lines dated before the cutoff must persist as-is — but under migration
-- 0013's generation scheme every sync publishes a brand-new generation and
-- prunes the old one, which would silently drop them. This migration parks
-- that history outside the generation scheme:
--
--   * gl_lines grows an `archived` flag;
--   * the currently-visible generation's pre-2025 rows are marked archived
--     (they keep their sync_id, which becomes irrelevant);
--   * gl_line_facts shows archived rows unconditionally, and applies the
--     generation filter only to rows on/after the cutoff — so even a sync
--     run from pre-freeze code that re-imports 2023-2024 data cannot double
--     up the frozen history;
--   * prune_gl_lines never deletes archived rows.
--
-- job_costs / job_invoices need no schema change: their sync deletes are now
-- scoped to txn_date >= 2025-01-01 in TypeScript, so pre-2025 rows simply
-- stop being refreshed.
--
-- Apply this migration before (or together with) deploying the code that
-- moves the import start dates; the hardened gl_line_facts filter makes the
-- ordering safe either way.
-- =============================================================================

alter table public.gl_lines
  add column if not exists archived boolean not null default false;

-- Archive the pre-cutoff rows readers currently see. Two cases, matching
-- gl_line_facts' visibility rule: the company's current generation, and —
-- for companies never synced since 0013 — legacy untagged rows.
update public.gl_lines l
set archived = true
from public.gl_sync_state s
where s.org_id = l.org_id
  and s.realm_id = l.realm_id
  and l.sync_id = s.current_sync_id
  and l.txn_date < '2025-01-01';

update public.gl_lines l
set archived = true
where l.sync_id is null
  and l.txn_date < '2025-01-01'
  and not exists (
    select 1
    from public.gl_sync_state s
    where s.org_id = l.org_id
      and s.realm_id = l.realm_id
  );

-- Same columns as 0013; archived rows are always visible, and the generation
-- filter now only governs rows inside the import window.
create or replace view public.gl_line_facts
with (security_invoker = true)
as
select l.id,
       l.org_id,
       l.realm_id,
       l.account_qb_id,
       coalesce(a.fully_qualified_name, a.name, l.account_name) as account_full_name,
       a.classification,
       a.account_type,
       a.account_sub_type,
       l.txn_date,
       date_trunc('month', l.txn_date)::date as month,
       l.txn_type,
       l.qb_txn_id,
       l.doc_number,
       l.entity_name,
       l.customer_name,
       l.vendor_name,
       l.memo,
       l.split_account,
       l.class_name,
       l.department_name,
       l.amount
from public.gl_lines l
left join public.gl_sync_state s
  on s.org_id = l.org_id
 and s.realm_id = l.realm_id
left join public.gl_accounts a
  on a.org_id = l.org_id
 and a.realm_id = l.realm_id
 and a.qb_id = l.account_qb_id
where l.archived
   or (l.txn_date >= '2025-01-01'
       and ((s.current_sync_id is null and l.sync_id is null)
            or l.sync_id = s.current_sync_id));

-- Superseded-generation cleanup must leave frozen history alone.
create or replace function public.prune_gl_lines(
  p_org_id uuid,
  p_realm_id text,
  p_limit integer default 10000
) returns integer
language plpgsql
set search_path = public
as $$
declare
  n integer;
begin
  delete from gl_lines
  where ctid in (
    select l.ctid
    from gl_lines l
    join gl_sync_state s
      on s.org_id = l.org_id
     and s.realm_id = l.realm_id
    where l.org_id = p_org_id
      and l.realm_id = p_realm_id
      and not l.archived
      and l.sync_id is distinct from s.current_sync_id
    limit p_limit
  );
  get diagnostics n = row_count;
  return n;
end;
$$;
