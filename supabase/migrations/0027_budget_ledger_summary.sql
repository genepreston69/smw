-- =============================================================================
-- Keep the Budget page inside the function timeout
--
-- /financials/budget (migration 0026) needs, per company, twelve months of
-- account × month activity (the baseline) and revenue customer × month
-- activity (for the intercompany eliminations). It was reading them through
-- gl_pivot with the paged API reader — one account and one customer pivot per
-- company, all at once — and PostgREST's 1000-row cap re-runs the full
-- aggregation for every page. The customer × month slice alone spans many
-- pages, so a page load stacked up dozens of full ledger scans and timed out.
-- (Same failure mode and same fix as migration 0024.)
--
-- budget_ledger_summary() scans gl_line_facts once for the window and returns
-- both shapes as one JSON row, so the row cap can't split it across round
-- trips. The facts CTE is referenced twice, so it is materialized and the
-- ledger is read exactly once. Keys match gl_pivot exactly (account full
-- name, its customer CASE branch, YYYY-MM months), so the page's statement
-- and elimination logic is unchanged.
--
-- Returns:
--   { "accounts":  [[realm_id, classification, account_type, account, month, amount], …],
--     "customers": [[realm_id, customer, month, amount], …] }   -- Revenue only
-- "customers" is empty unless p_customers is true.
--
-- SECURITY: gl_line_facts is security_invoker over the admin-only gl_* tables.
-- The app calls this through the service-role client after requireAdmin(),
-- like every other Financials read, so only service_role gets execute.
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
           coalesce(nullif(f.customer_name, ''), nullif(f.entity_name, ''), '(no customer)') as customer,
           f.amount
    from public.gl_line_facts f
    where f.txn_date >= p_start
      and f.txn_date <= p_end
      and f.realm_id = any (p_realm_ids)
      and f.classification in ('Revenue', 'Expense')
  ),
  accounts as (
    select realm_id, classification, account_type, account_full_name, month,
           sum(amount) as amount
    from facts
    group by 1, 2, 3, 4, 5
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
         realm_id, classification, account_type, account_full_name, month, amount))
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
