-- =============================================================================
-- Month-grain job benefit allocation, for the Capitalized Labor dashboard
--
-- Migration 0021 introduced job_benefit_allocation_totals with fixed
-- all-time / YTD / MTD rollups for the Jobs dashboard. The Capitalized Labor
-- dashboard also shows the allocation, but its time filter includes an
-- arbitrary from/to month range, which fixed rollups can't serve. This
-- migration moves the allocation math into a month-grain view —
-- job_benefit_allocation_months, one row per job × month — and rebuilds
-- job_benefit_allocation_totals as a plain rollup of it, so the math lives
-- in exactly one place. Behavior of the totals view is unchanged.
--
-- The allocation logic is identical to 0021 (and stays in lockstep with
-- allocateBenefits in src/lib/financials.ts — see 0021's header for the
-- matching rules): per QB company × month, the Income Statement's allocated
-- employee-benefits pool is distributed across that company's jobs pro-rata
-- by direct-labor cost.
--
-- SECURITY: same posture as 0021 — deliberately NOT security_invoker so the
-- view can aggregate the admin-only gl_lines while exposing only per-job
-- aggregate dollars; anon gets no grant.
-- =============================================================================

create view public.job_benefit_allocation_months as
with gl_months as (
  -- Company-level monthly totals for the three allocation inputs, Expense
  -- accounts only (the statement's direct-cost + opex sections).
  select f.org_id,
         f.realm_id,
         f.month,
         coalesce(sum(f.amount) filter (where
           public.gl_normalize_label(a.category) = 'employee benefits'), 0) as benefits,
         coalesce(sum(f.amount) filter (where
           public.gl_normalize_label(a.category) = 'salaries and wages'), 0) as salaries,
         coalesce(sum(f.amount) filter (where
           public.gl_normalize_label(a.category) = 'direct labor'
           or public.gl_normalize_label(f.account_full_name) like '%direct labor%'
           or public.gl_normalize_label(f.account_full_name) like '%710 labor cost%'), 0) as labor
  from public.gl_line_facts f
  left join public.gl_accounts a
    on a.org_id = f.org_id
   and a.realm_id = f.realm_id
   and a.qb_id = f.account_qb_id
  where f.classification = 'Expense'
  group by 1, 2, 3
),
pools as (
  select org_id,
         realm_id,
         month,
         benefits * least(1, labor / (labor + salaries)) as allocated
  from gl_months
  where labor > 0 and labor + salaries > 0 and benefits <> 0
),
job_labor as (
  -- Only jobs with positive net labor in the month participate in that
  -- month's distribution.
  select c.org_id,
         c.realm_id,
         date_trunc('month', c.txn_date)::date as month,
         c.job_id,
         sum(c.amount) as labor
  from public.job_costs c
  where c.cost_type = 'labor' and c.txn_date is not null
  group by 1, 2, 3, 4
  having sum(c.amount) > 0
)
select jl.job_id,
       jl.month,
       p.allocated * jl.labor
         / sum(jl.labor) over (partition by jl.org_id, jl.realm_id, jl.month)
         as amount
from job_labor jl
join pools p
  on p.org_id = jl.org_id
 and p.realm_id = jl.realm_id
 and p.month = jl.month;

revoke all on public.job_benefit_allocation_months from anon, public;
grant select on public.job_benefit_allocation_months to authenticated, service_role;

-- Same columns and results as 0021's definition, now a rollup of the
-- month-grain view.
create or replace view public.job_benefit_allocation_totals as
select job_id,
       sum(amount) as total_amount,
       sum(amount) filter (where month >= date_trunc('year',  current_date)) as ytd_amount,
       sum(amount) filter (where month >= date_trunc('month', current_date)) as mtd_amount
from public.job_benefit_allocation_months
group by job_id;
