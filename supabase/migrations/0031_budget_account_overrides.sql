-- =============================================================================
-- Budget: type over the budget per account × month (/financials/budget)
--
-- Growth assumptions (migrations 0026 / 0028) stay the default: every account
-- budgets its baseline month grown by its category's rate. An admin can now
-- type a figure straight into an account's month cell — or its annual total,
-- which re-spreads across the months in the shape they already have — on the
-- expanded budget statement. Each typed month is stored here and replaces the
-- growth-based amount for that account-month, so later growth edits no
-- longer move it. Approved initiatives still add on top (src/lib/budget.ts,
-- growBaselineCells). Clearing a cell deletes its row and the month returns
-- to the growth default.
--
-- Keyed by the account's full name exactly as the budget statement rows show
-- it (the same key budget_initiative_lines uses), per company and budget
-- year. classification is kept so a row still lands in the right section if
-- the account has no baseline activity. Amounts are natural-signed like the
-- ledger: a revenue or expense budget is normally positive.
--
-- set_budget_account_overrides() replaces one account's complete set in one
-- transaction — a month edit sends the account's months, a total edit all
-- twelve, a reset none. Same access model as 0026 / 0028: admin-only RLS, and
-- the app writes through an admin-gated server action with the service-role
-- client, so only service_role gets execute.
-- =============================================================================

create table public.budget_account_overrides (
  org_id uuid not null references public.organizations (id) default public.default_org_id(),
  budget_year int not null check (budget_year between 2000 and 2100),
  realm_id text not null,
  account text not null check (length(trim(account)) > 0),
  classification text not null check (classification in ('Revenue', 'Expense')),
  month int not null check (month between 1 and 12),
  amount numeric not null check (amount between -1000000000 and 1000000000),
  updated_by uuid references public.profiles (id),
  updated_at timestamptz not null default now(),
  primary key (org_id, budget_year, realm_id, account, month)
);

create trigger budget_account_overrides_touch
  before update on public.budget_account_overrides
  for each row execute function public.touch_updated_at();

alter table public.budget_account_overrides enable row level security;

create policy budget_account_overrides_admin on public.budget_account_overrides
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- p_months: [{"month": 1-12, "amount": numeric}, …] — the account's complete
-- set of typed months; months left out return to the growth default.
create or replace function public.set_budget_account_overrides(
  p_budget_year int,
  p_realm_id text,
  p_account text,
  p_classification text,
  p_months jsonb,
  p_updated_by uuid
) returns void
language plpgsql
set search_path = public
as $$
declare
  v_org uuid := public.default_org_id();
begin
  delete from public.budget_account_overrides t
   where t.org_id = v_org
     and t.budget_year = p_budget_year
     and t.realm_id = p_realm_id
     and t.account = p_account
     and not exists (
       select 1
         from jsonb_to_recordset(coalesce(p_months, '[]'::jsonb)) as n (month int)
        where n.month = t.month);

  insert into public.budget_account_overrides as t
    (org_id, budget_year, realm_id, account, classification, month, amount, updated_by)
  select v_org, p_budget_year, p_realm_id, p_account, p_classification,
         n.month, n.amount, p_updated_by
    from jsonb_to_recordset(coalesce(p_months, '[]'::jsonb))
      as n (month int, amount numeric)
  on conflict (org_id, budget_year, realm_id, account, month) do update
    set amount = excluded.amount,
        classification = excluded.classification,
        updated_by = excluded.updated_by
    where t.amount is distinct from excluded.amount
       or t.classification is distinct from excluded.classification;
end;
$$;

revoke all on function public.set_budget_account_overrides(int, text, text, text, jsonb, uuid)
  from anon, authenticated, public;
grant execute on function public.set_budget_account_overrides(int, text, text, text, jsonb, uuid)
  to service_role;
