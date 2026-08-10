-- =============================================================================
-- Make the job benefit allocation fast enough for page loads
--
-- 0022's job_benefit_allocation_months evaluated the label matchers
-- (gl_normalize_label, three calls per row) against EVERY Expense ledger
-- line and aggregated the whole ledger before filtering — on production
-- volumes that blows the authenticated role's statement timeout, 500ing the
-- Jobs and Capitalized Labor dashboards ("canceling statement due to
-- statement timeout").
--
-- Same numbers, restructured: classify ACCOUNTS first (gl_accounts is a few
-- hundred rows), then join only the matched accounts' lines through
-- gl_line_facts via the (org_id, realm_id, account_qb_id) index. This is
-- exactly equivalent to 0022's per-line matching: the old view's
-- classification = 'Expense' filter came from the joined account row, so a
-- line without an account row could never match anything — every matcher
-- (category or account-name) was decided entirely by the account row.
--
-- Matching still mirrors allocateBenefits in src/lib/financials.ts — see
-- 0021 for the rules and the lockstep contract. An account may match more
-- than one matcher (e.g. a benefits-category account whose name contains
-- "direct labor"), so the matchers are independent flags, not exclusive
-- branches, preserving 0021/0022 semantics.
--
-- job_benefit_allocation_totals needs no change — it rolls up this view and
-- picks up the new definition automatically.
-- =============================================================================

create or replace view public.job_benefit_allocation_months as
with accounts as (
  -- Classify the chart of accounts once, instead of re-matching per ledger
  -- line. account_full_name mirrors gl_line_facts' coalesce.
  select org_id,
         realm_id,
         qb_id,
         coalesce(public.gl_normalize_label(category) = 'employee benefits', false) as is_benefits,
         coalesce(public.gl_normalize_label(category) = 'salaries and wages', false) as is_salaries,
         coalesce(public.gl_normalize_label(category) = 'direct labor'
                  or public.gl_normalize_label(coalesce(fully_qualified_name, name)) like '%direct labor%'
                  or public.gl_normalize_label(coalesce(fully_qualified_name, name)) like '%710 labor cost%',
                  false) as is_labor
  from public.gl_accounts
  where classification = 'Expense'
),
matched as (
  select * from accounts
  where is_benefits or is_salaries or is_labor
),
gl_months as (
  -- Company-level monthly totals for the three allocation inputs, touching
  -- only the matched accounts' lines.
  select f.org_id,
         f.realm_id,
         f.month,
         coalesce(sum(f.amount) filter (where m.is_benefits), 0) as benefits,
         coalesce(sum(f.amount) filter (where m.is_salaries), 0) as salaries,
         coalesce(sum(f.amount) filter (where m.is_labor), 0) as labor
  from matched m
  join public.gl_line_facts f
    on f.org_id = m.org_id
   and f.realm_id = m.realm_id
   and f.account_qb_id = m.qb_id
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
