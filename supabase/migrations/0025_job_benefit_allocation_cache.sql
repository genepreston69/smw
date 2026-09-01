-- =============================================================================
-- Precompute the job benefit allocation instead of deriving it per page load
--
-- 0024 cut the Capitalized Labor page down to a single statement, and that
-- single statement still times out on the authenticated role: one evaluation
-- of job_benefit_allocation_months re-derives the whole allocation from the
-- raw ledger (every Expense line of every benefits/salaries/labor account,
-- joined to a full aggregate of job_costs), which is more work than a browser
-- request has budget for. Nothing left to shave — 0023 already restructured
-- the matching, and a bigger timeout is not available to browser-facing roles
-- (statement_timeout is armed before a function's own SET applies, see 0012).
--
-- So stop deriving it on read. The inputs (gl_lines, job_costs,
-- gl_accounts.category) only change when a sync runs or an admin recategorizes
-- an account, so the allocation is cached in a materialized view and refreshed
-- at exactly those three moments, through refresh_job_benefit_allocation()
-- below. Page loads read the cache: an indexed scan of a few thousand rows.
--
-- job_benefit_allocation_months stays the definition of the math (and stays in
-- lockstep with allocateBenefits in src/lib/financials.ts — see 0021). The
-- cache is that view, materialized; both readers now go through the cache, so
-- the Jobs dashboard and the Capitalized Labor page cannot disagree.
--
-- SECURITY: same posture as the view it caches (0021) — it holds per-job
-- dollars only, never ledger detail, so authenticated users may read it; anon
-- gets no grant. Refreshing is server-side only: refresh_job_benefit_allocation
-- is security definer (it must own the view to refresh it) and is granted to
-- service_role alone, which the app only ever uses behind an admin check.
-- =============================================================================

-- Building the cache runs the expensive derivation once, under whatever role
-- applies this migration; give it room so the initial populate can't be cut
-- short. (Session-scoped: it does not change any role's default.)
set statement_timeout = '10min';

create materialized view public.job_benefit_allocation_cache as
select job_id, month, amount
from public.job_benefit_allocation_months;

-- Unique key: required by REFRESH ... CONCURRENTLY, which is what keeps the
-- dashboards readable while a sync refreshes the cache.
create unique index job_benefit_allocation_cache_key
  on public.job_benefit_allocation_cache (job_id, month);
create index job_benefit_allocation_cache_month_idx
  on public.job_benefit_allocation_cache (month);

revoke all on public.job_benefit_allocation_cache from anon, public;
grant select on public.job_benefit_allocation_cache to authenticated, service_role;

-- Called after a QuickBooks sync (jobs/costs or ledger) and after an account's
-- category changes — the only things that can move these numbers.
create or replace function public.refresh_job_benefit_allocation()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  refresh materialized view concurrently public.job_benefit_allocation_cache;
end;
$$;

revoke all on function public.refresh_job_benefit_allocation() from anon, authenticated, public;
grant execute on function public.refresh_job_benefit_allocation() to service_role;

-- Both readers now hit the cache. Shapes and numbers are unchanged; only the
-- moment the allocation is computed moves (sync time instead of page load).
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
    from public.job_benefit_allocation_cache
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

create or replace view public.job_benefit_allocation_totals as
select job_id,
       sum(amount) as total_amount,
       sum(amount) filter (where month >= date_trunc('year',  current_date)) as ytd_amount,
       sum(amount) filter (where month >= date_trunc('month', current_date)) as mtd_amount
from public.job_benefit_allocation_cache
group by job_id;
