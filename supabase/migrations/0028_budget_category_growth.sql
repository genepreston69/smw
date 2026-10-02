-- =============================================================================
-- Budget growth by category (/financials/budget)
--
-- Migration 0026 gave each company two growth rates — revenue and expense —
-- applied to every baseline account by classification. This adds per-company
-- category rates: a growth % for one (classification, category) pair, where
-- category is the admin-assigned gl_accounts.category label (migration 0019)
-- that groups the Income Statement. An account grows at its own company's
-- rate for its category; a category with no rate, and any uncategorized
-- account, keeps using the company's revenue / expense rate in
-- budget_assumptions, which are now the defaults.
--
-- Keyed by the category label exactly as the statement groups it
-- (classification included, since the statement groups Revenue and Expense
-- accounts separately). A rate whose label no longer appears on any of the
-- company's accounts simply matches nothing.
--
-- save_budget_assumptions() writes one company's defaults and its whole set of
-- category rates in one transaction, so a save can't leave a company half
-- updated. Rates left out of the set are removed (the category falls back to
-- the default); unchanged ones keep their updated_by / updated_at. Same access
-- model as migration 0026: admin-only RLS, and the app writes through an
-- admin-gated server action with the service-role client, so only
-- service_role gets execute.
-- =============================================================================

create table public.budget_category_assumptions (
  org_id uuid not null references public.organizations (id) default public.default_org_id(),
  budget_year int not null check (budget_year between 2000 and 2100),
  realm_id text not null,
  classification text not null check (classification in ('Revenue', 'Expense')),
  category text not null check (length(trim(category)) > 0),
  growth_pct numeric not null check (growth_pct between -100 and 1000),
  updated_by uuid references public.profiles (id),
  updated_at timestamptz not null default now(),
  primary key (org_id, budget_year, realm_id, classification, category)
);

create trigger budget_category_assumptions_touch
  before update on public.budget_category_assumptions
  for each row execute function public.touch_updated_at();

alter table public.budget_category_assumptions enable row level security;

create policy budget_category_assumptions_admin on public.budget_category_assumptions
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- p_categories: [{"classification": "Revenue" | "Expense", "category": text,
--                 "growth_pct": numeric}, …] — the company's complete set.
create or replace function public.save_budget_assumptions(
  p_budget_year int,
  p_realm_id text,
  p_revenue_growth_pct numeric,
  p_expense_growth_pct numeric,
  p_categories jsonb,
  p_updated_by uuid
) returns void
language plpgsql
set search_path = public
as $$
declare
  v_org uuid := public.default_org_id();
begin
  insert into public.budget_assumptions
    (org_id, budget_year, realm_id, revenue_growth_pct, expense_growth_pct, updated_by)
  values
    (v_org, p_budget_year, p_realm_id, p_revenue_growth_pct, p_expense_growth_pct, p_updated_by)
  on conflict (org_id, budget_year, realm_id) do update
    set revenue_growth_pct = excluded.revenue_growth_pct,
        expense_growth_pct = excluded.expense_growth_pct,
        updated_by = excluded.updated_by;

  delete from public.budget_category_assumptions t
   where t.org_id = v_org
     and t.budget_year = p_budget_year
     and t.realm_id = p_realm_id
     and not exists (
       select 1
         from jsonb_to_recordset(coalesce(p_categories, '[]'::jsonb))
           as n (classification text, category text, growth_pct numeric)
        where n.classification = t.classification and n.category = t.category);

  insert into public.budget_category_assumptions as t
    (org_id, budget_year, realm_id, classification, category, growth_pct, updated_by)
  select v_org, p_budget_year, p_realm_id, n.classification, n.category, n.growth_pct, p_updated_by
    from jsonb_to_recordset(coalesce(p_categories, '[]'::jsonb))
      as n (classification text, category text, growth_pct numeric)
  on conflict (org_id, budget_year, realm_id, classification, category) do update
    set growth_pct = excluded.growth_pct,
        updated_by = excluded.updated_by
    where t.growth_pct is distinct from excluded.growth_pct;
end;
$$;

revoke all on function public.save_budget_assumptions(int, text, numeric, numeric, jsonb, uuid)
  from anon, authenticated, public;
grant execute on function public.save_budget_assumptions(int, text, numeric, numeric, jsonb, uuid)
  to service_role;
