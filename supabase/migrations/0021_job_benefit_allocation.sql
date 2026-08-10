-- =============================================================================
-- Per-job employee-benefit allocation for the Jobs dashboard
--
-- The Income Statement (src/lib/financials.ts, allocateBenefits) reclassifies
-- the direct-labor share of Employee Benefits into Direct Costs: per month,
-- moved = Employee Benefits × Direct Labor ÷ (Direct Labor + Salaries &
-- Wages). The Jobs dashboard shows the same dollars attributed to individual
-- jobs: each QB company's monthly allocated pool is distributed across that
-- company's jobs pro-rata by their direct-labor cost (job_costs,
-- cost_type = 'labor') in the same month, so the per-job column sums to the
-- statement's per-company "Employee Benefits (Allocated)" line for any month
-- where jobs carry labor.
--
-- Matching mirrors src/lib/financials.ts exactly and must stay in lockstep
-- with it (same contract as costing.ts vs plan_line_item_costs):
--   * labels are normalized like normalizeLabel (lowercase, "&" → " and ",
--     collapse whitespace) — gl_normalize_label below;
--   * Employee Benefits and Salaries & Wages are matched by the account's
--     user-assigned category (gl_accounts.category, migration 0019);
--   * Direct Labor is matched by account name ("710 Labor Cost" or any
--     account containing "direct labor") anywhere in the Expense sections,
--     or by membership in a category named "Direct Labor";
--   * ratio is clamped to [0, 1] and is 0 when Direct Labor ≤ 0.
--
-- Months where the pool has no positive job labor keep their allocation in
-- operating expenses (nothing to attribute), and job labor before the GL
-- import window gets no allocation — both sides simply drop out of the join.
--
-- SECURITY: unlike the other rollup views this one is deliberately NOT
-- security_invoker. gl_lines is admin-only (migration 0014), but this view
-- exposes only per-job aggregate dollars — the same sensitivity class as
-- job_cost_totals, which every authenticated user can already read — so it
-- runs with owner privileges to see the ledger. anon gets no grant.
-- =============================================================================

-- Mirror of normalizeLabel in src/lib/financials.ts.
create or replace function public.gl_normalize_label(label text)
returns text
language sql
immutable
as $$
  select btrim(regexp_replace(replace(lower(label), '&', ' and '), '\s+', ' ', 'g'))
$$;

create or replace view public.job_benefit_allocation_totals as
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
),
job_months as (
  select jl.job_id,
         jl.month,
         p.allocated * jl.labor
           / sum(jl.labor) over (partition by jl.org_id, jl.realm_id, jl.month)
           as amount
  from job_labor jl
  join pools p
    on p.org_id = jl.org_id
   and p.realm_id = jl.realm_id
   and p.month = jl.month
)
select job_id,
       sum(amount) as total_amount,
       sum(amount) filter (where month >= date_trunc('year',  current_date)) as ytd_amount,
       sum(amount) filter (where month >= date_trunc('month', current_date)) as mtd_amount
from job_months
group by job_id;

-- Owner-privilege view over admin-only ledger data: authenticated users may
-- read the per-job aggregates, anon may not.
revoke all on public.job_benefit_allocation_totals from anon, public;
grant select on public.job_benefit_allocation_totals to authenticated, service_role;
