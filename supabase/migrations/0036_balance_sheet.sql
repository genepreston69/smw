-- =============================================================================
-- Balance sheet: QuickBooks' own month-end balances
--
-- gl_lines holds ledger *activity* (beginning-balance rows are never
-- imported), so on its own it can't say what a balance-sheet account held at
-- a month end — and QuickBooks' Retained Earnings and Net Income lines are
-- computed by QuickBooks, never posted. So the sync imports the QuickBooks
-- BalanceSheet report itself, summarized by month (syncBalanceSheet in
-- src/lib/quickbooks.ts), and stores every account's balance at every month
-- end here. The Balance Sheet page (/financials/balance-sheet) reads these
-- rows and nothing else, so it ties to QuickBooks to the cent by
-- construction.
--
--   * One row per company (realm) × month × account. `month` is the first
--     day of the month; the amount is the balance as of that month's last
--     day. Accounts at zero are not stored (missing = zero).
--   * account_key is the QuickBooks account id, or `row:<label>` for lines
--     QuickBooks computes rather than posts to (Net Income).
--   * section is where QuickBooks' report placed the line (Asset, Liability,
--     Equity); readers fall back to gl_accounts.classification.
--   * Amounts are natural signed, like gl_lines: positive is the account's
--     normal balance (debit for assets, credit for liabilities and equity),
--     so Total assets = Total liabilities + Total equity.
--
-- Month ends before 2025 are frozen audited history, the same rule as
-- gl_lines (migration 0020): replace_gl_balances writes each one once — the
-- first sync for a company loads them — and never replaces or deletes them.
-- Month ends from January 2025 on are replaced wholesale on every sync. To
-- reload a company's history, delete its rows with month < '2025-01-01' and
-- sync.
--
-- Admin-only like the rest of the ledger (migrations 0014/0015); the app
-- reads through the service-role client after requireAdmin().
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Nightly sync: a balance-sheet step per company (migration 0024)
-- ---------------------------------------------------------------------------

-- Its own step rather than part of general_ledger so a balance-sheet failure
-- never holds back the ledger import (and a big ledger never squeezes the
-- balance sheet out of its 300-second window). First in this file: the sync
-- only plans balance-sheet steps once gl_balances exists, so the step kind
-- must already be allowed by then.
alter table public.qb_sync_steps drop constraint qb_sync_steps_kind_check;
alter table public.qb_sync_steps add constraint qb_sync_steps_kind_check
  check (kind in ('customers_jobs', 'job_costs', 'general_ledger', 'balance_sheet'));

create table public.gl_balances (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) default public.default_org_id(),
  realm_id text not null,
  month date not null,                 -- first of the month; balance as of its last day
  account_key text not null,           -- account_qb_id, or 'row:<label>' for computed lines
  account_qb_id text,                  -- joins gl_accounts.qb_id within the realm
  account_name text not null,          -- line label as QuickBooks reported it
  section text check (section in ('Asset', 'Liability', 'Equity')),
  amount numeric not null,
  last_synced_at timestamptz not null default now(),
  unique (org_id, realm_id, month, account_key)
);

create index gl_balances_month_idx on public.gl_balances (org_id, month);

alter table public.gl_balances enable row level security;
create policy gl_balances_select on public.gl_balances
  for select to authenticated using ((select public.is_admin()));

-- ---------------------------------------------------------------------------
-- Writing a company's balances (service role only)
-- ---------------------------------------------------------------------------

-- p_rows: [{month: 'YYYY-MM-01', account_key, account_qb_id, account_name,
-- section, amount}, …] covering p_from..p_to (first-of-month dates). Replaces
-- the company's month ends in that range from 2025 on, in one transaction so
-- readers never see a half-written month; a pre-2025 month end is inserted
-- only when the company has nothing stored for it yet. Returns the number of
-- rows written.
create or replace function public.replace_gl_balances(
  p_org_id uuid,
  p_realm_id text,
  p_from date,
  p_to date,
  p_rows jsonb
) returns integer
language plpgsql
set search_path = public
as $$
declare
  v_frozen_before constant date := '2025-01-01';
  n integer;
begin
  -- A manual sync and the nightly step can overlap; serialize per company so
  -- the last writer wins wholesale.
  perform pg_advisory_xact_lock(hashtext('gl_balances:' || p_realm_id));

  delete from gl_balances
  where org_id = p_org_id
    and realm_id = p_realm_id
    and month >= greatest(p_from, v_frozen_before)
    and month <= p_to;

  insert into gl_balances (
    org_id, realm_id, month, account_key, account_qb_id, account_name, section, amount
  )
  select p_org_id,
         p_realm_id,
         (r ->> 'month')::date,
         r ->> 'account_key',
         nullif(r ->> 'account_qb_id', ''),
         r ->> 'account_name',
         nullif(r ->> 'section', ''),
         (r ->> 'amount')::numeric
  from jsonb_array_elements(p_rows) as r
  where (r ->> 'month')::date between p_from and p_to
    and ((r ->> 'month')::date >= v_frozen_before
         or not exists (select 1 from gl_balances h
                         where h.org_id = p_org_id
                           and h.realm_id = p_realm_id
                           and h.month = (r ->> 'month')::date));
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.replace_gl_balances(uuid, text, date, date, jsonb)
  from anon, authenticated, public;
grant execute on function public.replace_gl_balances(uuid, text, date, date, jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- Reading the balance sheet (service role only)
-- ---------------------------------------------------------------------------

-- Every stored balance for the given month ends and companies as one JSON
-- array of [realm_id, 'YYYY-MM', account_key, display name, section,
-- account_type, account_number, amount] — one round trip however many
-- companies and months are in view. The display name prefers the chart of
-- accounts' "Parent:Sub" path, which is also how the Income Statement keys
-- accounts, so consolidation merges the same accounts the same way.
create or replace function public.gl_balance_sheet(
  p_months date[],
  p_realm_ids text[]
) returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(
    jsonb_agg(jsonb_build_array(
      b.realm_id,
      to_char(b.month, 'YYYY-MM'),
      b.account_key,
      coalesce(a.fully_qualified_name, a.name, b.account_name),
      coalesce(b.section, a.classification),
      a.account_type,
      a.account_number,
      b.amount
    )),
    '[]'::jsonb)
  from gl_balances b
  left join gl_accounts a
    on a.org_id = b.org_id
   and a.realm_id = b.realm_id
   and a.qb_id = b.account_qb_id
  -- One org per deployment; scoping to it lets gl_balances_month_idx serve
  -- the month filter.
  where b.org_id = (select public.default_org_id())
    and b.month = any (p_months)
    and b.realm_id = any (p_realm_ids);
$$;

revoke all on function public.gl_balance_sheet(date[], text[])
  from anon, authenticated, public;
grant execute on function public.gl_balance_sheet(date[], text[])
  to service_role;
