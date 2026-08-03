-- =============================================================================
-- Raw general-ledger data from QuickBooks for custom financials
--
-- The Financials page slices raw accounting activity by arbitrary dimensions
-- (account, class, customer, vendor, transaction type, period, company).
-- Two imported tables feed it:
--
--   gl_accounts — the chart of accounts (Account entity), giving each
--     account its classification (Asset/Liability/Equity/Revenue/Expense),
--     type, and hierarchy.
--
--   gl_lines — every posted ledger line, imported from the QuickBooks
--     GeneralLedger report (which does the double-entry expansion for every
--     transaction type, so nothing is missed). Amounts are "natural" signed:
--     positive increases the account in its normal direction (a debit for
--     assets/expenses, a credit for liabilities/equity/revenue), matching
--     QuickBooks' own account-history display. Net income is therefore
--     sum(Revenue) - sum(Expense).
--
-- Lines are imported from a fixed start date (FINANCIALS_START_DATE in
-- src/lib/quickbooks.ts), and beginning-balance rows are not imported, so
-- balance-sheet accounts show activity for the period — not ending balances.
-- Each sync fully refreshes a company's rows (delete + insert), same as
-- job_costs.
-- =============================================================================

create table public.gl_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) default public.default_org_id(),
  realm_id text not null,
  qb_id text not null,
  name text not null,
  fully_qualified_name text,           -- "Parent:Sub" path
  account_number text,
  classification text,                 -- Asset | Equity | Expense | Liability | Revenue
  account_type text,                   -- e.g. Income, Cost of Goods Sold, Fixed Asset
  account_sub_type text,
  parent_qb_id text,
  active boolean not null default true,
  current_balance numeric,             -- QuickBooks' balance at last sync (point in time)
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  unique (org_id, realm_id, qb_id)
);

create index gl_accounts_realm_idx on public.gl_accounts (org_id, realm_id);

alter table public.gl_accounts enable row level security;
create policy gl_accounts_select on public.gl_accounts
  for select to authenticated using (true);

create table public.gl_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) default public.default_org_id(),
  realm_id text not null,
  account_qb_id text,                  -- joins gl_accounts.qb_id within the realm
  account_name text not null,          -- account name as reported (fallback display)
  txn_date date not null,
  txn_type text,                       -- Bill, Invoice, Journal Entry, …
  qb_txn_id text,                      -- transaction id when the report links one
  doc_number text,
  entity_name text,                    -- the line's name column (customer/vendor/employee)
  customer_name text,
  vendor_name text,
  memo text,
  split_account text,
  class_name text,
  department_name text,
  amount numeric not null default 0,   -- natural signed amount (see header comment)
  last_synced_at timestamptz,
  created_at timestamptz not null default now()
);

-- Report rows carry no stable per-line id, so there is no unique key; the
-- sync's full refresh per (org, realm) keeps the table consistent.
create index gl_lines_realm_idx on public.gl_lines (org_id, realm_id);
create index gl_lines_date_idx on public.gl_lines (org_id, txn_date);
create index gl_lines_account_idx on public.gl_lines (org_id, realm_id, account_qb_id);

alter table public.gl_lines enable row level security;
create policy gl_lines_select on public.gl_lines
  for select to authenticated using (true);

-- Lines enriched with their account's classification, for filtering and
-- grouping. account_full_name prefers the chart of accounts' qualified path.
create view public.gl_line_facts
with (security_invoker = true)
as
select l.id,
       l.org_id,
       l.realm_id,
       l.account_qb_id,
       coalesce(a.fully_qualified_name, a.name, l.account_name) as account_full_name,
       a.classification,
       a.account_type,
       a.account_sub_type,
       l.txn_date,
       date_trunc('month', l.txn_date)::date as month,
       l.txn_type,
       l.qb_txn_id,
       l.doc_number,
       l.entity_name,
       l.customer_name,
       l.vendor_name,
       l.memo,
       l.split_account,
       l.class_name,
       l.department_name,
       l.amount
from public.gl_lines l
left join public.gl_accounts a
  on a.org_id = l.org_id
 and a.realm_id = l.realm_id
 and a.qb_id = l.account_qb_id;

-- Pivot aggregation for the Financials page: pick a row dimension and a
-- column dimension, get back one row per (classification, account_type,
-- row_key, col_key) cell. Aggregating here keeps slicing on one small query
-- instead of pulling every ledger line through the API. Classification and
-- account_type always come back so the UI can build statement sections and
-- compute net income (Revenue - Expense) for any slice.
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
  where f.txn_date >= p_start
    and f.txn_date <= p_end
    and (p_realm_id is null or f.realm_id = p_realm_id)
    and (p_classifications is null or f.classification = any (p_classifications))
  group by 1, 2, 3, 4
$$;

grant execute on function public.gl_pivot to authenticated;
