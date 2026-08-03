-- =============================================================================
-- Drill-down for the Financials pivot
--
-- Clicking an amount cell on the Financials page lists the raw ledger lines
-- behind it. gl_lines_detail filters gl_line_facts with the SAME dimension
-- expressions gl_pivot (migration 0009) groups by, so the lines listed always
-- reconcile with the cell that was clicked. If a dimension CASE changes in
-- one function it must change in the other — they are deliberate mirrors.
--
-- p_row_key / p_col_key are nullable: null skips that axis's filter (a row
-- total drills into every column at once).
-- =============================================================================

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
  where f.txn_date >= p_start
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

grant execute on function public.gl_lines_detail to authenticated;
