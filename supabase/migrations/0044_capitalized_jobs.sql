-- =============================================================================
-- Capitalized Jobs: labor and the other direct costs of a capital job, on one
-- page
--
-- Capitalized Labor (migrations 0030/0032) reviewed the payroll posted to
-- non-billable and intercompany jobs; Capitalized Materials (0036) listed the
-- other expenses on non-billable jobs separately. Capitalizing a job needs
-- its whole direct cost in one place, so /capitalized-jobs replaces both: one
-- row per job with a column for each Direct Cost account —
--
--   710 Labor Cost        'labor'
--   720 Contract Service  'contract'
--   839 Fuel & Oil        'fuel'
--   705 Material Cost     'materials'
--   837 Freight           'freight'
--
-- — then the amount already capitalized and what still awaits review.
--
-- cap_job_lines is the one definition of which job-cost lines count and
-- which column each lands in. The page, its line drill-down and both exports
-- read it. Expenses on any other account are not a direct cost of the job and
-- are not counted.
--
-- Apply before deploying the code that reads cap_job_lines. Nothing is
-- dropped: cap_labor_lines and cap_material_lines stay so the pages they
-- served keep working until the new code is live; nothing reads them after.
-- =============================================================================

-- Which Direct Cost column an account belongs to, or null. The account
-- number decides (QuickBooks' account number, or the number a name starts
-- with — "710 Labor Cost"); a chart that numbers its accounts differently is
-- matched by the name alone.
create or replace function public.cap_job_account_kind(p_number text, p_name text)
returns text
language sql
immutable
as $$
  select coalesce(
    case coalesce(substring(btrim(coalesce(p_number, '')) from '^\d+'),
                  substring(btrim(coalesce(p_name, '')) from '^\d+'))
      when '710' then 'labor'
      when '720' then 'contract'
      when '839' then 'fuel'
      when '705' then 'materials'
      when '837' then 'freight'
    end,
    case
      when nm ~ '^labor costs?$' then 'labor'
      when nm ~ '^contract services?$' then 'contract'
      when nm ~ '^fuel (&|and) oil$' then 'fuel'
      when nm ~ '^materials? costs?$' then 'materials'
      when nm ~ '^freight$' then 'freight'
    end)
  from (
    select lower(btrim(regexp_replace(coalesce(p_name, ''), '^\s*[\d.]*[\s\-–·]*', ''))) as nm
  ) x
$$;

-- The same test for a line whose account couldn't be matched to the chart
-- (renamed or deleted since the frozen history was imported): its category
-- is the account's "Parent:Sub" name, so the deepest matching segment decides.
create or replace function public.cap_job_category_kind(p_category text)
returns text
language sql
immutable
as $$
  select public.cap_job_account_kind(null, s.seg)
  from unnest(string_to_array(coalesce(p_category, ''), ':')) with ordinality as s(seg, n)
  where public.cap_job_account_kind(null, s.seg) is not null
  order by s.n desc
  limit 1
$$;

revoke all on function public.cap_job_account_kind(text, text) from public, anon;
revoke all on function public.cap_job_category_kind(text) from public, anon;
grant execute on function public.cap_job_account_kind(text, text) to authenticated, service_role;
grant execute on function public.cap_job_category_kind(text) to authenticated, service_role;

-- Every account in the chart with its Direct Cost column: its own, or its
-- nearest parent's — a sub-account of 710 Labor Cost is labor. Null when
-- neither it nor any parent is a Direct Cost account.
--
-- The chart of accounts is admin-only (migration 0014) but Capitalized Jobs
-- is open to every signed-in user, so this view is intentionally NOT
-- security_invoker — like the benefit allocation views (0021). It exposes
-- only an account's id and its column, never a name or a balance; with the
-- caller's rights a non-admin would read no accounts and silently lose every
-- line that is placed by its account.
create or replace view public.cap_job_accounts
with (security_invoker = false)
as
with recursive chain as (
  select a.org_id,
         a.realm_id,
         a.qb_id,
         a.parent_qb_id,
         public.cap_job_account_kind(a.account_number, a.name) as kind,
         0 as depth
  from public.gl_accounts a
  union all
  select c.org_id,
         c.realm_id,
         c.qb_id,
         p.parent_qb_id,
         public.cap_job_account_kind(p.account_number, p.name),
         c.depth + 1
  from chain c
  join public.gl_accounts p
    on p.org_id = c.org_id
   and p.realm_id = c.realm_id
   and p.qb_id = c.parent_qb_id
  where c.kind is null
    and c.depth < 10
)
select org_id, realm_id, qb_id, max(kind) as kind
from chain
group by org_id, realm_id, qb_id;

revoke all on public.cap_job_accounts from anon, public;
grant select on public.cap_job_accounts to authenticated, service_role;

-- The one definition of which job-cost lines the Capitalized Jobs page, its
-- line drill-down, and both exports count, and how. Bills, purchases, vendor
-- credits and journal entries count; time entries never do (they value hours
-- at the internal rate and post nothing to the ledger). Amounts are signed as
-- job cost: a charge is positive; a refund, vendor credit, reversal or
-- capitalizing credit is negative.
--
--   kind — the Direct Cost column, decided in this order:
--     1. the line's account in the chart (cap_job_accounts);
--     2. for an account the chart no longer has, the account name the line
--        carries (cap_job_category_kind);
--     3. a journal line on a wage or employer-payroll-tax expense account
--        booked outside 710 (cap_labor_account, migration 0032) is labor —
--        the rule Capitalized Labor always used, so no payroll drops out;
--     4. an item line that can't be traced to an account (frozen pre-2025
--        history) is purchased goods: materials.
--     Lines that match none are not counted. A line on a balance-sheet
--     account never counts: withholdings and other payroll liabilities, or a
--     purchase straight into inventory or a fixed asset.
--
--   treatment = 'capitalized' — a journal line whose entry debits a capital
--               asset (Fixed Asset / Other Asset): cost moved onto the
--               balance sheet (job_costs.je_debits_asset, migration 0030)
--   treatment = 'posted'      — everything else, net of refunds, credits and
--               reversals
create or replace view public.cap_job_lines
with (security_invoker = true)
as
select jc.id,
       jc.org_id,
       jc.realm_id,
       jc.job_id,
       jc.qb_txn_type,
       jc.qb_txn_id,
       jc.qb_doc_number,
       jc.txn_date,
       jc.vendor_name,
       jc.description,
       jc.category,
       jc.amount,
       k.kind,
       case
         when jc.qb_txn_type = 'JournalEntry' and jc.je_debits_asset then 'capitalized'
         else 'posted'
       end as treatment
from public.job_costs jc
left join public.cap_job_accounts a
  on a.org_id = jc.org_id
 and a.realm_id = jc.realm_id
 and a.qb_id = jc.qb_account_id
cross join lateral (
  select coalesce(
    a.kind,
    case
      when a.qb_id is null
       and (jc.qb_txn_type = 'JournalEntry' or jc.cost_type <> 'materials')
        then public.cap_job_category_kind(jc.category)
    end,
    case
      when jc.qb_txn_type = 'JournalEntry'
       and public.cap_labor_account(jc.category, jc.account_classification)
        then 'labor'
    end,
    case
      when jc.qb_txn_type <> 'JournalEntry'
       and jc.cost_type = 'materials'
       and jc.qb_account_id is null
        then 'materials'
    end) as kind
) k
where jc.qb_txn_type in ('Bill', 'Purchase', 'VendorCredit', 'JournalEntry')
  and coalesce(jc.account_classification, 'Expense') = 'Expense'
  and k.kind is not null;

revoke all on public.cap_job_lines from anon, public;
grant select on public.cap_job_lines to authenticated, service_role;

-- Readers fetch the lines of the candidate jobs only, a chunk of job ids at a
-- time over the period, which job_costs_job_date_idx (job_id, txn_date desc;
-- migration 0005) serves — no new index needed.

insert into public.schema_migrations (filename)
values ('0044_capitalized_jobs.sql') on conflict do nothing;
