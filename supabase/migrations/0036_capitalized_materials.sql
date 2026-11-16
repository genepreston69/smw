-- =============================================================================
-- Capitalized Materials: every expense posted to a non-billable job
--
-- Capitalized Labor (migrations 0030/0032) reviews the payroll allocated to
-- non-billable work. Its companion, /capitalized-materials, lists everything
-- else that was expensed on a non-billable job — materials, parts, outside
-- services, rentals, freight — across every QuickBooks company, so
-- accounting can decide what belongs in a capital account instead:
--
--   * Bills, purchases (checks, cash and credit-card charges) and vendor
--     credits tagged to the job, unless the line posted to a balance-sheet
--     account (a purchase straight into a fixed asset or inventory was never
--     expensed, so there is nothing to capitalize).
--   * Journal-entry lines tagged to the job on an expense account that is
--     not payroll — payroll (cap_labor_account) stays on Capitalized Labor,
--     so no dollar is counted on both pages.
--   * Time entries never count: they value hours at the internal labor rate
--     and post nothing to the ledger.
--
-- A counted line is "capitalized" when its journal entry debits a capital
-- asset (Fixed Asset / Other Asset) — the same signature cap_labor_lines
-- uses (job_costs.je_debits_asset); every other line is "expensed", net of
-- refunds, vendor credits and reversals.
--
-- Bill / purchase lines now carry their account facts too: the sync
-- (src/lib/quickbooks.ts, syncJobCosts) records qb_account_id and
-- account_classification for them — an account-based line's own account, an
-- item-based line's item purchase account (the inventory asset for stock
-- items, the expense account otherwise). It also imports vendor credits
-- (qb_txn_type 'VendorCredit', stored negative) and stores credit-card
-- credits (Purchase.Credit) negative; both used to be missing or counted as
-- cost. Rows dated before 2025 are frozen history the sync never re-imports,
-- so this migration backfills account-based lines (and, until the next sync,
-- the import window) from the chart of accounts, the same way 0030 did for
-- journal lines. Item-based frozen lines can't be traced to an account and
-- keep a null classification, which reads as expensed.
--
-- Apply before deploying the code that reads cap_material_lines.
-- =============================================================================

-- Account facts for account-based bill / purchase lines, by the account's
-- qualified "Parent:Sub" name — what a line's AccountRef name carries ...
-- (cost_type 'materials' marks an item-based line, whose category is an item
-- name, not an account.)
update public.job_costs jc
set qb_account_id = a.qb_id,
    account_classification = a.classification
from public.gl_accounts a
where jc.qb_txn_type in ('Bill', 'Purchase')
  and jc.cost_type <> 'materials'
  and jc.qb_account_id is null
  and a.org_id = jc.org_id
  and a.realm_id = jc.realm_id
  and a.fully_qualified_name = jc.category;

-- ... falling back to the account's own name when it is unique in its
-- company. Lines that match neither keep a null classification, which
-- cap_material_lines reads as expensed.
update public.job_costs jc
set qb_account_id = a.qb_id,
    account_classification = a.classification
from (
  select org_id,
         realm_id,
         name,
         min(qb_id) as qb_id,
         min(classification) as classification
  from public.gl_accounts
  group by 1, 2, 3
  having count(*) = 1
) a
where jc.qb_txn_type in ('Bill', 'Purchase')
  and jc.cost_type <> 'materials'
  and jc.qb_account_id is null
  and a.org_id = jc.org_id
  and a.realm_id = jc.realm_id
  and a.name = jc.category;

-- A journal line's account is a non-payroll expense. Payroll belongs to
-- Capitalized Labor (cap_labor_account). An account whose classification is
-- unknown (renamed since the frozen history was imported) is judged by name,
-- rejecting balance-sheet names.
create or replace function public.cap_material_account(p_name text, p_classification text)
returns boolean
language sql
immutable
as $$
  select not public.cap_labor_account(p_name, p_classification)
     and case
           when p_classification is not null then p_classification = 'Expense'
           else coalesce(p_name, '') !~*
             '(liabilit|payable|receivable|withh|w/h|accrued|deduction|garnish|asset|inventory|prepaid|deposit|loan|clearing|equity|retained|accumulated)'
         end
$$;

-- The one definition of which job-cost lines the Capitalized Materials page,
-- its line drill-down, and both exports count, and how. Amounts are signed
-- as job cost: a charge is positive; a refund, vendor credit, reversal or
-- capitalizing credit is negative.
--
--   treatment = 'capitalized' — a journal line whose entry debits a capital
--               asset: cost moved onto the balance sheet
--   treatment = 'expensed'    — everything else
create or replace view public.cap_material_lines
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
       jc.cost_type,
       jc.account_classification,
       jc.amount,
       case
         when jc.qb_txn_type = 'JournalEntry' and jc.je_debits_asset then 'capitalized'
         else 'expensed'
       end as treatment
from public.job_costs jc
where case
        when jc.qb_txn_type in ('Bill', 'Purchase', 'VendorCredit')
          then coalesce(jc.account_classification, 'Expense') = 'Expense'
        when jc.qb_txn_type = 'JournalEntry'
          then public.cap_material_account(jc.category, jc.account_classification)
        else false
      end;

revoke all on public.cap_material_lines from anon, public;
grant select on public.cap_material_lines to authenticated, service_role;

-- Readers fetch the lines of the non-billable jobs only, a chunk of job ids
-- at a time over the period, which job_costs_job_date_idx (job_id,
-- txn_date desc; migration 0005) serves — no new index needed.
