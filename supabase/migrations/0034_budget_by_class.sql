-- =============================================================================
-- Budget by QuickBooks class (/financials/budget)
--
-- The budget is now built per class and rolls up: class → company →
-- consolidated. Every input carries the QuickBooks class it belongs to, keyed
-- exactly as gl_pivot keys its class dimension (migration 0009):
-- coalesce(nullif(class_name, ''), '(no class)').
--
--   * budget_ledger_summary() (migration 0027) returns each account × month
--     cell split by class: a seventh element on every "accounts" tuple, so a
--     caller that reads only the first six still gets the same totals.
--   * budget_account_overrides (migration 0031) is keyed by class: a typed
--     figure replaces one account × class × month. Figures typed before this
--     migration covered the whole account; each is split across the classes
--     that account-month's baseline has activity in, in proportion to that
--     activity (absolute amounts, so shares stay between 0 and 1), rounded to
--     cents with the remainder on the largest share — every class becomes
--     typed and the parts add up to the original figure, so no account,
--     company, or consolidated total moves. A month with no baseline activity
--     goes to '(no class)'. (Growth is one rate per company and category,
--     the same for every class, so splitting by baseline is splitting by the
--     grown budget.)
--   * set_budget_account_overrides() replaces one account × class's set.
--   * budget_initiatives gain a class. Existing initiatives are '(no class)';
--     like the timing (migration 0029), the class decides where the money
--     lands, so it may change only while the initiative is proposed.
--
-- Apply before deploying the code that reads class_name.
-- =============================================================================

-- --- Ledger summary by class -------------------------------------------------

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
    where f.txn_date >= p_start
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

-- --- Typed figures by class --------------------------------------------------

alter table public.budget_account_overrides add column class_name text;

alter table public.budget_account_overrides drop constraint budget_account_overrides_pkey;

-- Split every existing (whole-account) figure across its classes.
--
-- One read of the ledger: gl_lines' date index leads with org_id
-- (gl_lines_date_idx: org_id, txn_date), so the baseline window is scoped to
-- the organization with bounds evaluated once (the subselects), letting the
-- index range-scan just those months — not the whole ledger, every year and
-- every superseded sync generation (the lesson of migration 0033).
insert into public.budget_account_overrides
  (org_id, budget_year, realm_id, account, class_name, classification, month, amount,
   updated_by, updated_at)
with todo as (
  select *
  from public.budget_account_overrides
  where class_name is null
),
keys as (
  select distinct realm_id, account from todo
),
bounds as (
  select min(budget_year) as first_year, max(budget_year) as last_year from todo
),
-- Baseline activity per account × class × ledger month inside the baseline
-- windows (the twelve months ending June 30 of the year before each budget
-- year — src/lib/budget.ts, baselineRange), for the accounts typed over.
base as (
  select f.realm_id,
         f.account_full_name as account,
         f.month,
         coalesce(nullif(f.class_name, ''), '(no class)') as class_name,
         sum(f.amount) as amount
  from public.gl_line_facts f
  where f.org_id = (select public.default_org_id())
    and f.txn_date >= (select make_date(first_year - 2, 7, 1) from bounds)
    and f.txn_date < (select make_date(last_year - 1, 7, 1) from bounds)
    and (f.realm_id, f.account_full_name) in (select realm_id, account from keys)
  group by 1, 2, 3, 4
  having abs(sum(f.amount)) >= 0.005
),
shares as (
  select o.org_id, o.budget_year, o.realm_id, o.account, o.classification, o.month,
         o.amount as typed, o.updated_by, o.updated_at,
         coalesce(b.class_name, '(no class)') as class_name,
         case
           when b.class_name is null then 1
           else abs(b.amount) / sum(abs(b.amount)) over (
             partition by o.org_id, o.budget_year, o.realm_id, o.account, o.month)
         end as share
  from todo o
  -- Budget month m comes from the same calendar month of the baseline:
  -- July–December of budget_year − 2, January–June of budget_year − 1.
  left join base b
    on b.realm_id = o.realm_id
   and b.account = o.account
   and b.month = make_date(
         case when o.month >= 7 then o.budget_year - 2 else o.budget_year - 1 end,
         o.month, 1)
),
rounded as (
  select s.*,
         round(s.typed * s.share, 2) as part,
         row_number() over (
           partition by s.org_id, s.budget_year, s.realm_id, s.account, s.month
           order by s.share desc, s.class_name) as rn
  from shares s
)
select org_id, budget_year, realm_id, account, class_name, classification, month,
       part + case
                when rn = 1 then typed - sum(part) over (
                  partition by org_id, budget_year, realm_id, account, month)
                else 0
              end,
       updated_by, updated_at
from rounded;

delete from public.budget_account_overrides where class_name is null;

alter table public.budget_account_overrides
  alter column class_name set not null,
  add constraint budget_account_overrides_class_name_check
    check (length(trim(class_name)) > 0),
  add primary key (org_id, budget_year, realm_id, account, class_name, month);

comment on column public.budget_account_overrides.class_name is
  'QuickBooks class the typed figure budgets, keyed as gl_pivot keys class (''(no class)'' when none).';

-- p_months: [{"month": 1-12, "amount": numeric}, …] — the account × class's
-- complete set of typed months; months left out return to the growth default.
drop function public.set_budget_account_overrides(int, text, text, text, jsonb, uuid);

create function public.set_budget_account_overrides(
  p_budget_year int,
  p_realm_id text,
  p_account text,
  p_class_name text,
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
     and t.class_name = p_class_name
     and not exists (
       select 1
         from jsonb_to_recordset(coalesce(p_months, '[]'::jsonb)) as n (month int)
        where n.month = t.month);

  insert into public.budget_account_overrides as t
    (org_id, budget_year, realm_id, account, class_name, classification, month, amount, updated_by)
  select v_org, p_budget_year, p_realm_id, p_account, p_class_name, p_classification,
         n.month, n.amount, p_updated_by
    from jsonb_to_recordset(coalesce(p_months, '[]'::jsonb))
      as n (month int, amount numeric)
  on conflict (org_id, budget_year, realm_id, account, class_name, month) do update
    set amount = excluded.amount,
        classification = excluded.classification,
        updated_by = excluded.updated_by
    where t.amount is distinct from excluded.amount
       or t.classification is distinct from excluded.classification;
end;
$$;

revoke all on function public.set_budget_account_overrides(int, text, text, text, text, jsonb, uuid)
  from anon, authenticated, public;
grant execute on function public.set_budget_account_overrides(int, text, text, text, text, jsonb, uuid)
  to service_role;

-- --- Initiatives by class ----------------------------------------------------

alter table public.budget_initiatives
  add column class_name text not null default '(no class)'
    check (length(trim(class_name)) > 0);

comment on column public.budget_initiatives.class_name is
  'QuickBooks class the initiative budgets, keyed as gl_pivot keys class (''(no class)'' when none).';

-- The class decides which class budget carries the money, so it locks with
-- the amounts and the months (migrations 0026 / 0029).
create or replace function public.budget_initiatives_timing_guard()
returns trigger
language plpgsql
as $$
begin
  if old.status <> 'proposed'
     and (new.start_month, new.end_month, new.class_name)
         is distinct from (old.start_month, old.end_month, old.class_name) then
    raise exception 'Initiative is %; return it to proposed before changing its months or class', old.status;
  end if;
  return new;
end;
$$;
