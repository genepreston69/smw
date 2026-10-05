-- =============================================================================
-- Already Capitalized: every journal entry that moved labor to an asset
--
-- The Capitalized Labor dashboard (migration 0030) works from job-tagged
-- journal lines in job_costs. Its new companion schedule,
-- /capitalized-labor/already-capitalized, lists the capitalization entries
-- themselves from the general ledger, so an entry counts even when its
-- labor credit carries no job tag:
--
--   a journal entry that debits a capital asset (Fixed Asset / Other Asset —
--   the asset varies by equipment and job, so by account type, never name)
--   and, net, credits labor (wages or the employer's share of payroll taxes).
--
-- The labor-account rule now lives in one function, cap_labor_account(),
-- used both by the schedule and by cap_labor_lines (re-pointed here with the
-- same columns and the same rows as migration 0030).
--
-- capitalized_labor_entries(p_from, p_to) returns every line of those entries
-- dated in the window as one JSON row (the PostgREST row cap can't cut it
-- short), each tagged asset / labor / other. GL data is admin-only: the page
-- and its export check the role and then read through the service-role
-- client (as every Financials read does), so only service_role gets execute.
-- =============================================================================

-- Wages and the employer's share of payroll taxes, on the expense side.
-- Withholdings and every other payroll liability never count; payroll
-- service fees are an expense but not labor. An account whose classification
-- is unknown is judged by name, rejecting balance-sheet payroll names.
create or replace function public.cap_labor_account(p_name text, p_classification text)
returns boolean
language sql
immutable
as $$
  select coalesce(p_name, '') ~*
           '(labor|payroll|wage|salar|employer|fica|futa|suta|medicare|social security|unemployment)'
     and coalesce(p_name, '') !~* '\mfees?\M'
     and case
           when p_classification is not null then p_classification = 'Expense'
           else coalesce(p_name, '') !~* '(liabilit|payable|withh|w/h|accrued|deduction|garnish)'
         end
$$;

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
  and public.cap_labor_account(jc.category, jc.account_classification);

-- Returns { "lines": [[realm_id, qb_txn_id, txn_date, doc_number, account,
--                      account_type, kind, customer_name, memo, amount,
--                      classification], …] }
-- kind: 'asset' (a Fixed Asset / Other Asset line), 'labor'
-- (cap_labor_account), or 'other'. Amounts are natural-signed: an asset debit
-- and a labor debit are positive, a labor credit negative.
create or replace function public.capitalized_labor_entries(p_from date, p_to date)
returns jsonb
language sql
stable
set search_path = public
as $$
  with lines as (
    select f.realm_id,
           f.qb_txn_id,
           f.txn_date,
           f.doc_number,
           f.account_full_name as account,
           f.classification,
           f.account_type,
           case
             when f.classification = 'Asset'
                  and f.account_type in ('Fixed Asset', 'Other Asset') then 'asset'
             when public.cap_labor_account(f.account_full_name, f.classification) then 'labor'
             else 'other'
           end as kind,
           f.customer_name,
           f.memo,
           f.amount
    from public.gl_line_facts f
    where f.txn_type ilike 'journal%entry'
      and f.qb_txn_id is not null
      and f.txn_date between p_from and p_to
  ),
  entries as (
    select realm_id, qb_txn_id
    from lines
    group by 1, 2
    having bool_or(kind = 'asset' and amount > 0)
       and coalesce(sum(amount) filter (where kind = 'labor'), 0) < 0
  )
  select jsonb_build_object(
    'lines', coalesce(
      (select jsonb_agg(
                jsonb_build_array(l.realm_id, l.qb_txn_id, l.txn_date, l.doc_number,
                                  l.account, l.account_type, l.kind, l.customer_name,
                                  l.memo, l.amount, l.classification)
                order by l.txn_date desc, l.realm_id, l.qb_txn_id, l.kind, l.account)
         from lines l
         join entries e using (realm_id, qb_txn_id)),
      '[]'::jsonb));
$$;

revoke all on function public.capitalized_labor_entries(date, date) from anon, authenticated, public;
grant execute on function public.capitalized_labor_entries(date, date) to service_role;
