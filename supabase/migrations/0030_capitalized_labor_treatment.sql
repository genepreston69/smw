-- =============================================================================
-- Capitalized Labor: count wages + employer taxes, never withholdings, and
-- detect capitalization by the asset it lands in
--
-- The dashboard used to take every job-tagged journal line whose account
-- name contained labor / payroll / wages and split it by sign: debits were
-- "labor posted", credits "already capitalized". A payroll journal entry
-- tags the job on its liability lines too, so the employee's withholdings
-- (Payroll Liabilities: federal / FICA / state …) — and the employer-tax
-- liabilities — landed as credits and read as capitalized, understating what
-- still awaits review. The rule is now:
--
--   * Only expense-side payroll accounts count: wages (labor / payroll /
--     wages / salaries) and the employer's share of payroll taxes (FICA,
--     FUTA, SUTA, Medicare, unemployment). Liability lines — withholdings
--     from the employee's check, employer-tax liabilities, accrued payroll —
--     never count, debit or credit.
--   * A counted line is "capitalized" only when its journal entry debits a
--     capital asset (Fixed Asset / Other Asset). The asset varies by
--     equipment and job, so detection goes by account type, never by name.
--     Every other counted line is labor posted (a reversal or correction nets
--     against it).
--
-- job_costs grows the account facts the rule needs, stored per journal line
-- by the sync (src/lib/quickbooks.ts, syncJobCosts):
--   qb_account_id          — the line's AccountRef id
--   account_classification — the account's QuickBooks classification
--                            (Asset | Liability | Equity | Revenue | Expense)
--   je_debits_asset        — the line's journal entry debits a Fixed Asset or
--                            Other Asset account (null = unknown)
--
-- Rows dated before 2025 are frozen history the sync never re-imports, so
-- this migration backfills them (and, until the next sync, the import window)
-- from the chart of accounts and the general ledger. Apply it before
-- deploying the code that reads cap_labor_lines and writes the new columns.
-- =============================================================================

alter table public.job_costs
  add column if not exists qb_account_id text,
  add column if not exists account_classification text,
  add column if not exists je_debits_asset boolean;

-- Account facts by the account's qualified "Parent:Sub" name — what a
-- journal line's AccountRef name carries ...
update public.job_costs jc
set qb_account_id = a.qb_id,
    account_classification = a.classification
from public.gl_accounts a
where jc.qb_txn_type = 'JournalEntry'
  and jc.qb_account_id is null
  and a.org_id = jc.org_id
  and a.realm_id = jc.realm_id
  and a.fully_qualified_name = jc.category;

-- ... falling back to the account's own name when it is unique in its
-- company. Lines that match neither (an account renamed or deleted since)
-- keep a null classification; cap_labor_lines judges those by name.
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
where jc.qb_txn_type = 'JournalEntry'
  and jc.qb_account_id is null
  and a.org_id = jc.org_id
  and a.realm_id = jc.realm_id
  and a.name = jc.category;

-- Capitalization entries: journal entries the ledger shows debiting a capital
-- asset (natural-signed, so a positive asset amount is a debit). Same rule as
-- isCapitalAssetAccount in src/lib/quickbooks.ts. gl_line_facts covers the
-- frozen pre-2025 history as well as the current import window. Entries the
-- ledger doesn't cover (a company whose ledger was never synced) stay null:
-- unknown, which reads as labor posted.
with ledger_entries as (
  select f.org_id,
         f.realm_id,
         f.qb_txn_id,
         coalesce(bool_or(f.classification = 'Asset'
                          and f.account_type in ('Fixed Asset', 'Other Asset')
                          and f.amount > 0), false) as debits_asset
  from public.gl_line_facts f
  where f.txn_type ilike 'journal%entry'
    and f.qb_txn_id is not null
  group by 1, 2, 3
)
update public.job_costs jc
set je_debits_asset = e.debits_asset
from ledger_entries e
where jc.qb_txn_type = 'JournalEntry'
  and e.org_id = jc.org_id
  and e.realm_id = jc.realm_id
  and e.qb_txn_id = jc.qb_txn_id;

-- The one definition of which journal lines the Capitalized Labor dashboard,
-- its line drill-down, and both exports count, and how. A line qualifies
-- when its account is a wage or employer-payroll-tax account on the expense
-- side; one whose account couldn't be matched to the chart of accounts is
-- judged by name, rejecting balance-sheet payroll names (liabilities,
-- payables, withholdings (incl. "W/H"), accruals, deductions, garnishments). Payroll
-- service fees are an expense but not labor, so they never count.
--
--   treatment = 'capitalized' — its entry debits a capital asset: labor
--               moved onto the balance sheet (a credit; stored negative)
--   treatment = 'posted'      — everything else: wages and employer taxes
--               posted to the job, net of reversals and corrections
create or replace view public.cap_labor_lines
with (security_invoker = true)
as
select jc.id,
       jc.org_id,
       jc.realm_id,
       jc.job_id,
       jc.qb_txn_id,
       jc.qb_doc_number,
       jc.txn_date,
       jc.description,
       jc.category,
       jc.account_classification,
       jc.amount,
       case when jc.je_debits_asset then 'capitalized' else 'posted' end as treatment
from public.job_costs jc
where jc.qb_txn_type = 'JournalEntry'
  and coalesce(jc.category, '') ~*
      '(labor|payroll|wage|salar|employer|fica|futa|suta|medicare|social security|unemployment)'
  and coalesce(jc.category, '') !~* '\mfees?\M'
  and case
        when jc.account_classification is not null
          then jc.account_classification = 'Expense'
        else coalesce(jc.category, '') !~*
          '(liabilit|payable|withh|w/h|accrued|deduction|garnish)'
      end;

revoke all on public.cap_labor_lines from anon, public;
grant select on public.cap_labor_lines to authenticated, service_role;

-- The dashboard and both exports page through every journal line (the rule
-- above no longer follows cost_type, so 0024's labor-only index can't serve
-- them); the drill-down reads one job's lines via job_costs_job_date_idx.
create index if not exists job_costs_journal_idx
  on public.job_costs (id)
  where qb_txn_type = 'JournalEntry';
