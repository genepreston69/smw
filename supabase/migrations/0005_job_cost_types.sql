-- =============================================================================
-- Job cost transaction history: cost-type buckets + Jan 2026 window
--
-- Every imported cost line is classified into one of three direct-cost
-- buckets so the app can pool a job's transaction history by cost type:
--   materials — item-based bill/purchase lines (things bought for the job)
--   labor     — time entries, plus bill/purchase lines whose item/account
--               name indicates labor, payroll, or wages
--   other     — all remaining account-based direct costs
--
-- The sync only imports transactions dated on or after 2026-01-01
-- (JOB_COSTS_START_DATE in src/lib/quickbooks.ts); each sync fully
-- refreshes a company's rows, so pre-2026 rows disappear on the next run.
-- =============================================================================

-- Idempotent guards so re-running (e.g. pasted into the SQL editor twice)
-- is harmless.
alter table public.job_costs
  add column if not exists cost_type text not null default 'other'
  check (cost_type in ('materials', 'labor', 'other'));

-- Backfill what we can distinguish today; bill/purchase rows are corrected
-- on the next sync, which rebuilds the table from QuickBooks anyway.
update public.job_costs set cost_type = 'labor'
  where qb_txn_type = 'TimeActivity' and cost_type <> 'labor';

-- Transaction-history reads are per job, newest first.
create index if not exists job_costs_job_date_idx
  on public.job_costs (job_id, txn_date desc);

-- Extend the per-job rollup with per-bucket totals (new columns appended so
-- create-or-replace is allowed).
create or replace view public.job_cost_totals
with (security_invoker = true)
as
select job_id,
       sum(amount)  as total_amount,
       sum(hours)   as total_hours,
       count(*)     as line_count,
       max(txn_date) as latest_txn_date,
       sum(amount) filter (where cost_type = 'materials') as materials_amount,
       sum(amount) filter (where cost_type = 'labor')     as labor_amount,
       sum(amount) filter (where cost_type = 'other')     as other_amount
from public.job_costs
group by job_id;
