-- =============================================================================
-- Keep the Capitalized Labor dashboard inside the statement timeout
--
-- The page needs the employee-benefit allocation two ways: summed over the
-- selected period (a column and a stat tile) and split by calendar year (the
-- by-year breakdown). It was reading job_benefit_allocation_months row by
-- row — one row per job per month — through the paged API reader, and
-- PostgREST's 1000-row cap turns that into a dozen-plus round trips, each of
-- which re-runs the whole allocation (0023 made a single run fast, but not a
-- dozen). On production volumes that intermittently blew the authenticated
-- role's statement timeout and 500'd the page.
--
-- Two fixes, no change to any number the page shows:
--
-- 1. job_benefit_allocation_summary() — one statement, one evaluation of the
--    allocation, returning both shapes the page needs as JSON so it is not
--    subject to the row cap and cannot be split across round trips. The
--    non-recursive CTE is referenced twice, so Postgres materializes it and
--    the underlying view runs exactly once.
--
-- 2. A partial index for the page's other big read — every journal-entry
--    labor line — which had no index to work with and seq-scanned job_costs
--    once per page of results.
--
-- SECURITY: the function is a plain (invoker) function over
-- job_benefit_allocation_months, which is deliberately not security_invoker
-- so it can aggregate the admin-only gl_lines while exposing only per-job
-- dollars (see 0021). It therefore exposes exactly what the view already
-- exposes to authenticated users, in a cheaper shape. anon gets no grant.
-- =============================================================================

-- Returns:
--   { "years":  [[job_id, year, amount], …],     -- every year, all history
--     "period": [[job_id, amount], …] }          -- p_from..p_to (null = open)
-- p_from/p_to are month boundaries (first of the month); the period arm is
-- what the page's time filter sums, the years arm is its by-year breakdown.
create or replace function public.job_benefit_allocation_summary(
  p_from date default null,
  p_to date default null
) returns jsonb
language sql
stable
set search_path = public
as $$
  with months as (
    select job_id, month, amount
    from public.job_benefit_allocation_months
  ),
  years as (
    select job_id, extract(year from month)::int as year, sum(amount) as amount
    from months
    group by 1, 2
  ),
  period as (
    select job_id, sum(amount) as amount
    from months
    where (p_from is null or month >= p_from)
      and (p_to is null or month <= p_to)
    group by 1
  )
  select jsonb_build_object(
    'years', coalesce(
      (select jsonb_agg(jsonb_build_array(job_id, year, amount)) from years),
      '[]'::jsonb),
    'period', coalesce(
      (select jsonb_agg(jsonb_build_array(job_id, amount)) from period),
      '[]'::jsonb)
  );
$$;

revoke all on function public.job_benefit_allocation_summary(date, date) from anon, public;
grant execute on function public.job_benefit_allocation_summary(date, date) to authenticated, service_role;

-- The dashboard and both of its exports read every journal-entry labor line
-- (capitalized-labor candidates are journal entries only). Without this the
-- filter has no index and each page of results re-scans job_costs.
create index if not exists job_costs_journal_labor_idx
  on public.job_costs (org_id, id)
  where qb_txn_type = 'JournalEntry' and cost_type = 'labor';
