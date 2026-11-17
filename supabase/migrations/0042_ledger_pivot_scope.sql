-- =============================================================================
-- Financials pivot: scan the date window, once
--
-- Two costs made every Financials page, the Income Ratios page, the ledger
-- drill-down, the Reconciliation tie-out and the Financials export slower as
-- the ledger grew:
--
--   1. gl_pivot and gl_lines_detail filtered by date and company but not by
--      org. Every gl_lines index leads with org_id (gl_lines_date_idx is
--      (org_id, txn_date)), so without an org condition Postgres could not
--      range-scan the window and read the whole ledger instead — archived
--      history and superseded generations included. Migrations 0033 and 0035
--      fixed the same thing for the Already Capitalized and Budget reads; this
--      does it for the two functions that never got it.
--
--   2. The app read gl_pivot through the API's 1000-row pages, and each page
--      re-ran the whole aggregation. gl_pivot_cells returns every cell as one
--      JSON value, so a pivot is one scan however many cells it has (the fix
--      budget_ledger_summary made for the Budget page in 0027).
--
-- The results are unchanged: the app has one org, so the org condition removes
-- no rows. Both functions keep their signatures and grants.
-- =============================================================================

create or replace function public.gl_pivot(
  p_start date,
  p_end date,
  p_row_dim text,                      -- account | class | customer | vendor | txn_type | month
  p_col_dim text,                      -- month | quarter | year | class | company | total
  p_realm_id text default null,        -- null = all companies
  p_classifications text[] default null -- null = all account classifications
) returns table (
  classification text,
  account_type text,
  row_key text,
  col_key text,
  amount numeric,
  line_count bigint
)
language sql
stable
set search_path = public
as $$
  select
    f.classification,
    f.account_type,
    case p_row_dim
      when 'account'  then f.account_full_name
      when 'class'    then coalesce(nullif(f.class_name, ''), '(no class)')
      when 'customer' then coalesce(nullif(f.customer_name, ''), nullif(f.entity_name, ''), '(no customer)')
      when 'vendor'   then coalesce(nullif(f.vendor_name, ''), nullif(f.entity_name, ''), '(no vendor)')
      when 'txn_type' then coalesce(nullif(f.txn_type, ''), '(none)')
      when 'month'    then to_char(f.month, 'YYYY-MM')
      else '(all)'
    end as row_key,
    case p_col_dim
      when 'month'   then to_char(f.month, 'YYYY-MM')
      when 'quarter' then to_char(date_trunc('quarter', f.txn_date), 'YYYY-"Q"Q')
      when 'year'    then to_char(f.txn_date, 'YYYY')
      when 'class'   then coalesce(nullif(f.class_name, ''), '(no class)')
      when 'company' then f.realm_id
      else 'total'
    end as col_key,
    sum(f.amount) as amount,
    count(*) as line_count
  from public.gl_line_facts f
  -- The org condition is what lets gl_lines_date_idx range-scan the window.
  where f.org_id = (select public.default_org_id())
    and f.txn_date >= p_start
    and f.txn_date <= p_end
    and (p_realm_id is null or f.realm_id = p_realm_id)
    and (p_classifications is null or f.classification = any (p_classifications))
  group by 1, 2, 3, 4
$$;

-- Dimension CASE expressions must stay identical to gl_pivot's.
create or replace function public.gl_lines_detail(
  p_start date,
  p_end date,
  p_realm_id text default null,
  p_classifications text[] default null,
  p_row_dim text default null,
  p_row_key text default null,
  p_col_dim text default null,
  p_col_key text default null
) returns table (
  id uuid,
  realm_id text,
  account_full_name text,
  classification text,
  txn_date date,
  txn_type text,
  doc_number text,
  entity_name text,
  customer_name text,
  vendor_name text,
  memo text,
  split_account text,
  class_name text,
  department_name text,
  amount numeric
)
language sql
stable
set search_path = public
as $$
  select f.id,
         f.realm_id,
         f.account_full_name,
         f.classification,
         f.txn_date,
         f.txn_type,
         f.doc_number,
         f.entity_name,
         f.customer_name,
         f.vendor_name,
         f.memo,
         f.split_account,
         f.class_name,
         f.department_name,
         f.amount
  from public.gl_line_facts f
  where f.org_id = (select public.default_org_id())
    and f.txn_date >= p_start
    and f.txn_date <= p_end
    and (p_realm_id is null or f.realm_id = p_realm_id)
    and (p_classifications is null or f.classification = any (p_classifications))
    and (p_row_key is null or p_row_key = case p_row_dim
      when 'account'  then f.account_full_name
      when 'class'    then coalesce(nullif(f.class_name, ''), '(no class)')
      when 'customer' then coalesce(nullif(f.customer_name, ''), nullif(f.entity_name, ''), '(no customer)')
      when 'vendor'   then coalesce(nullif(f.vendor_name, ''), nullif(f.entity_name, ''), '(no vendor)')
      when 'txn_type' then coalesce(nullif(f.txn_type, ''), '(none)')
      when 'month'    then to_char(f.month, 'YYYY-MM')
      else '(all)'
    end)
    and (p_col_key is null or p_col_key = case p_col_dim
      when 'month'   then to_char(f.month, 'YYYY-MM')
      when 'quarter' then to_char(date_trunc('quarter', f.txn_date), 'YYYY-"Q"Q')
      when 'year'    then to_char(f.txn_date, 'YYYY')
      when 'class'   then coalesce(nullif(f.class_name, ''), '(no class)')
      when 'company' then f.realm_id
      else 'total'
    end)
$$;

-- Every gl_pivot cell as one JSON array, in a stable order. Runs as the
-- caller, so the gl_* tables' admin-only RLS applies exactly as it does to
-- gl_pivot.
create or replace function public.gl_pivot_cells(
  p_start date,
  p_end date,
  p_row_dim text,
  p_col_dim text,
  p_realm_id text default null,
  p_classifications text[] default null
) returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(
    jsonb_agg(to_jsonb(c) order by c.row_key, c.col_key, c.classification, c.account_type),
    '[]'::jsonb
  )
  from public.gl_pivot(p_start, p_end, p_row_dim, p_col_dim, p_realm_id, p_classifications) c
$$;

revoke all on function public.gl_pivot_cells(date, date, text, text, text, text[]) from public, anon;
grant execute on function public.gl_pivot_cells(date, date, text, text, text, text[]) to authenticated, service_role;

insert into public.schema_migrations (filename)
values ('0042_ledger_pivot_scope.sql') on conflict do nothing;
