-- =============================================================================
-- Budget (/financials/budget)
--
-- The calendar-year budget is a baseline plus user inputs:
--   * Baseline: each account's actual ledger activity for the trailing twelve
--     months ending June 30 of the prior year (2027 budget ← Jul 2025–Jun 2026),
--     mapped to the same calendar month of the budget year. Derived at read
--     time from gl_lines via gl_pivot — nothing is stored.
--   * budget_assumptions: per company (realm) revenue and expense growth %
--     applied to that baseline.
--   * budget_initiatives / budget_initiative_lines: new initiatives per
--     company with expected annual revenue and expense by account. An
--     initiative is folded into the budget only once it is approved; while
--     proposed it is shown beside the budget but excluded from its totals.
--
-- Same access model as the ledger (migrations 0014/0015): admin-only RLS, and
-- the app writes through admin-gated server actions with the service-role
-- client. Initiative lines are locked unless the initiative is proposed, so an
-- approved initiative's numbers can't drift after approval — return it to
-- proposed to edit it. Status changes are written to audit_log
-- (entity_type = 'budget_initiative') by the server actions.
-- =============================================================================

create table public.budget_assumptions (
  org_id uuid not null references public.organizations (id) default public.default_org_id(),
  budget_year int not null check (budget_year between 2000 and 2100),
  realm_id text not null,
  revenue_growth_pct numeric not null default 0
    check (revenue_growth_pct between -100 and 1000),
  expense_growth_pct numeric not null default 0
    check (expense_growth_pct between -100 and 1000),
  updated_by uuid references public.profiles (id),
  updated_at timestamptz not null default now(),
  primary key (org_id, budget_year, realm_id)
);

create trigger budget_assumptions_touch before update on public.budget_assumptions
  for each row execute function public.touch_updated_at();

create table public.budget_initiatives (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) default public.default_org_id(),
  budget_year int not null check (budget_year between 2000 and 2100),
  realm_id text not null,
  name text not null check (length(trim(name)) > 0),
  description text,
  -- Amounts are spread evenly from this month through December.
  start_month int not null default 1 check (start_month between 1 and 12),
  status text not null default 'proposed'
    check (status in ('proposed', 'approved', 'rejected')),
  created_by uuid references public.profiles (id),
  approved_by uuid references public.profiles (id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index budget_initiatives_year_idx
  on public.budget_initiatives (org_id, budget_year, realm_id);

create trigger budget_initiatives_touch before update on public.budget_initiatives
  for each row execute function public.touch_updated_at();

create table public.budget_initiative_lines (
  id uuid primary key default gen_random_uuid(),
  initiative_id uuid not null references public.budget_initiatives (id) on delete cascade,
  -- gl_pivot's account row key (fully_qualified_name, else name), so the line
  -- lands in the same statement row and Category as the account's actuals.
  account_name text not null,
  classification text not null check (classification in ('Revenue', 'Expense')),
  annual_amount numeric not null,
  unique (initiative_id, account_name)
);

-- Lines may change only while their initiative is proposed. Deleting the
-- whole initiative (cascade) is still allowed in any status.
create or replace function public.budget_initiative_lines_guard()
returns trigger
language plpgsql
as $$
declare
  v_status text;
begin
  -- A cascade from deleting the initiative itself runs nested inside the FK
  -- trigger; let it through whatever the status was.
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  select status into v_status
    from public.budget_initiatives
   where id = coalesce(new.initiative_id, old.initiative_id);
  if v_status is not null and v_status <> 'proposed' then
    raise exception 'Initiative is %; return it to proposed before editing its amounts', v_status;
  end if;
  return coalesce(new, old);
end;
$$;

create trigger budget_initiative_lines_guard
  before insert or update or delete on public.budget_initiative_lines
  for each row execute function public.budget_initiative_lines_guard();

alter table public.budget_assumptions enable row level security;
alter table public.budget_initiatives enable row level security;
alter table public.budget_initiative_lines enable row level security;

create policy budget_assumptions_admin on public.budget_assumptions
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy budget_initiatives_admin on public.budget_initiatives
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy budget_initiative_lines_admin on public.budget_initiative_lines
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
