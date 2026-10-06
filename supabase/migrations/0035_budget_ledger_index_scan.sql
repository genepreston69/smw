-- =============================================================================
-- Budget: read only the budget's months of the ledger
--
-- budget_ledger_summary (migrations 0027 / 0034) filtered gl_line_facts by
-- date and company (realm) alone, but gl_lines' indexes all lead with org_id
-- (gl_lines_date_idx: org_id, txn_date), so without an org condition the
-- planner sequentially scans the whole ledger — every year, every superseded
-- sync generation — before keeping the twelve baseline months (or the
-- year-to-date actuals). Every Budget page load and export pays for that, and
-- the scan grows with the ledger. Scoping to the organization lets the date
-- index range-scan just the window — the same fix migration 0033 made for
-- the Already Capitalized schedule. Same output as 0034.
--
-- Apply after 0034 (it only replaces that function).
-- =============================================================================

create or replace function public.budget_ledger_summary(
  p_start date,
  p_end date,
  p_realm_ids text[],
  p_customers boolean default false
) returns jsonb
language sql
stable
set search_path = public
as $$
  with facts as materialized (
    select f.realm_id,
           f.classification,
           f.account_type,
           f.account_full_name,
           to_char(f.month, 'YYYY-MM') as month,
           coalesce(nullif(f.class_name, ''), '(no class)') as class_name,
           coalesce(nullif(f.customer_name, ''), nullif(f.entity_name, ''), '(no customer)') as customer,
           f.amount
    from public.gl_line_facts f
    -- One org per deployment; the subselect is evaluated once, so the date
    -- index can range-scan (org_id, txn_date).
    where f.org_id = (select public.default_org_id())
      and f.txn_date >= p_start
      and f.txn_date <= p_end
      and f.realm_id = any (p_realm_ids)
      and f.classification in ('Revenue', 'Expense')
  ),
  accounts as (
    select realm_id, classification, account_type, account_full_name, month, class_name,
           sum(amount) as amount
    from facts
    group by 1, 2, 3, 4, 5, 6
  ),
  customers as (
    select realm_id, customer, month, sum(amount) as amount
    from facts
    where p_customers and classification = 'Revenue'
    group by 1, 2, 3
  )
  select jsonb_build_object(
    'accounts', coalesce(
      (select jsonb_agg(jsonb_build_array(
         realm_id, classification, account_type, account_full_name, month, amount, class_name))
       from accounts),
      '[]'::jsonb),
    'customers', coalesce(
      (select jsonb_agg(jsonb_build_array(realm_id, customer, month, amount))
       from customers),
      '[]'::jsonb)
  );
$$;

revoke all on function public.budget_ledger_summary(date, date, text[], boolean) from anon, authenticated, public;
grant execute on function public.budget_ledger_summary(date, date, text[], boolean) to service_role;
