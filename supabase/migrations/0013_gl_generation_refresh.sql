-- =============================================================================
-- Generation-based general-ledger refresh (replaces migration 0011's swap)
--
-- swap_gl_lines replaced a company's entire ledger in one delete+insert
-- transaction; at real ledger sizes that single statement outruns any
-- reasonable statement_timeout. This migration removes the long statement
-- entirely instead of stretching timeouts:
--
--   * every imported row carries the sync run's sync_id (a generation tag);
--   * the sync inserts new-generation rows directly into gl_lines in small
--     batches — invisible to readers until the run finishes;
--   * gl_sync_state records each company's current generation, and
--     gl_line_facts (the only path gl_pivot and gl_lines_detail read
--     through) filters to it, so readers always see exactly one complete
--     generation and never a mix;
--   * finishing a sync is a one-row pointer flip (finish_gl_sync) —
--     milliseconds, atomic, last completed sync wins wholesale;
--   * superseded generations are already invisible and are deleted lazily
--     in small batches (prune_gl_lines); an interrupted cleanup is finished
--     by the next sync.
-- =============================================================================

alter table public.gl_lines
  add column if not exists sync_id uuid;

-- For pruning superseded generations within a company.
create index if not exists gl_lines_generation_idx
  on public.gl_lines (org_id, realm_id, sync_id);

create table public.gl_sync_state (
  org_id uuid not null references public.organizations (id) default public.default_org_id(),
  realm_id text not null,
  current_sync_id uuid not null,
  updated_at timestamptz not null default now(),
  primary key (org_id, realm_id)
);

-- Readers join this through the security-invoker gl_line_facts view, so
-- authenticated needs select; writes stay service-role only.
alter table public.gl_sync_state enable row level security;
create policy gl_sync_state_select on public.gl_sync_state
  for select to authenticated using (true);

-- Same columns as before, now scoped to the current generation. Before a
-- company's first generation-tagged sync completes there is no state row:
-- legacy rows (sync_id null) stay visible and in-progress inserts stay
-- hidden, so the cutover needs no backfill.
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
where (s.current_sync_id is null and l.sync_id is null)
   or l.sync_id = s.current_sync_id;

-- Publish a completed sync run: a single-row upsert, so the flip is atomic
-- and instant no matter how many lines the generation holds.
create or replace function public.finish_gl_sync(
  p_org_id uuid,
  p_realm_id text,
  p_sync_id uuid
) returns void
language sql
set search_path = public
as $$
  insert into gl_sync_state (org_id, realm_id, current_sync_id, updated_at)
  values (p_org_id, p_realm_id, p_sync_id, now())
  on conflict (org_id, realm_id)
  do update set current_sync_id = excluded.current_sync_id,
                updated_at = excluded.updated_at;
$$;

-- Delete one small batch of superseded-generation rows (they are already
-- invisible to readers); returns how many went so the caller can loop.
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
      and l.sync_id is distinct from s.current_sync_id
    limit p_limit
  );
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Only the service-role sync may flip or prune (functions default to PUBLIC
-- execute).
revoke all on function public.finish_gl_sync(uuid, text, uuid)
  from public, anon, authenticated;
revoke all on function public.prune_gl_lines(uuid, text, integer)
  from public, anon, authenticated;

-- Retire the 0011 staging swap.
drop function if exists public.swap_gl_lines(uuid, text, uuid);
drop table if exists public.gl_lines_staging;
