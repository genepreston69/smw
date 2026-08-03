-- =============================================================================
-- Atomic general-ledger refresh
--
-- gl_lines has no unique key (report rows carry no stable per-line id), and
-- the sync's refresh used to be a non-atomic delete-then-insert running in
-- 500-row batches over several minutes. Two overlapping syncs for the same
-- company interleave: the later run's delete only removes what the earlier
-- run had committed so far, and everything the earlier run inserts afterwards
-- survives alongside the later run's full set — doubling the most recently
-- inserted quarters.
--
-- Fix: the sync now stages its rows in gl_lines_staging under a per-run
-- sync_id, then calls swap_gl_lines, which deletes and re-inserts a
-- company's rows in ONE transaction serialized by an advisory lock. However
-- requests overlap or retry, the last completed swap wins wholesale and
-- duplicates are impossible.
-- =============================================================================

-- Staging keeps gl_lines' shape (and future ALTERs must mirror both tables);
-- sync_id scopes each run's rows.
create table public.gl_lines_staging (
  like public.gl_lines including defaults,
  sync_id uuid not null
);

create index gl_lines_staging_sync_idx
  on public.gl_lines_staging (sync_id);

-- Deny-all: only the service-role sync writes or reads staging.
alter table public.gl_lines_staging enable row level security;

create or replace function public.swap_gl_lines(
  p_org_id uuid,
  p_realm_id text,
  p_sync_id uuid
) returns integer
language plpgsql
set search_path = public
as $$
declare
  n integer;
begin
  -- Serialize swaps per company. Two concurrent single-transaction swaps
  -- would still race under READ COMMITTED (the later delete can't see rows
  -- the earlier transaction hasn't committed yet); the lock makes the whole
  -- swap mutually exclusive instead.
  perform pg_advisory_xact_lock(hashtext(p_org_id::text || ':' || p_realm_id));

  delete from gl_lines
  where org_id = p_org_id
    and realm_id = p_realm_id;

  insert into gl_lines (
    org_id, realm_id, account_qb_id, account_name, txn_date, txn_type,
    qb_txn_id, doc_number, entity_name, customer_name, vendor_name, memo,
    split_account, class_name, department_name, amount, last_synced_at
  )
  select
    org_id, realm_id, account_qb_id, account_name, txn_date, txn_type,
    qb_txn_id, doc_number, entity_name, customer_name, vendor_name, memo,
    split_account, class_name, department_name, amount, last_synced_at
  from gl_lines_staging
  where sync_id = p_sync_id
    and org_id = p_org_id
    and realm_id = p_realm_id;
  get diagnostics n = row_count;

  -- This run's staging rows are consumed; also sweep rows left behind by
  -- runs that crashed before reaching their swap.
  delete from gl_lines_staging
  where sync_id = p_sync_id
     or created_at < now() - interval '1 day';

  return n;
end;
$$;

-- Only the service-role sync may swap (functions default to PUBLIC execute).
revoke all on function public.swap_gl_lines(uuid, text, uuid)
  from public, anon, authenticated;
