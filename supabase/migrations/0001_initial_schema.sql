-- =============================================================================
-- SMW Job Plan & Approval Platform — initial schema
-- Design source: docs/PLANNING.md and docs/SPREADSHEET_REVIEW.md
-- =============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.app_role as enum ('admin', 'estimator', 'approver', 'viewer');
create type public.plan_status as enum ('draft', 'submitted', 'approved', 'rejected', 'changes_requested');
create type public.material_basis as enum ('per_lb', 'per_each', 'per_sf', 'lump_sum');
create type public.approval_decision as enum ('approved', 'rejected', 'changes_requested');

-- ---------------------------------------------------------------------------
-- Organizations (single-tenant today; org_id kept everywhere for the future)
-- ---------------------------------------------------------------------------
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  qb_realm_id text,
  created_at timestamptz not null default now()
);

insert into public.organizations (name) values ('Superior Marine');

create or replace function public.default_org_id()
returns uuid
language sql stable
as $$
  select id from public.organizations order by created_at limit 1
$$;

-- ---------------------------------------------------------------------------
-- Profiles & roles
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  org_id uuid not null references public.organizations (id) default public.default_org_id(),
  email text,
  full_name text,
  role public.app_role not null default 'estimator',
  created_at timestamptz not null default now()
);

-- First user to sign up becomes admin; everyone after starts as estimator.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  existing int;
begin
  select count(*) into existing from public.profiles;
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    case when existing = 0 then 'admin'::public.app_role else 'estimator'::public.app_role end
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.current_app_role()
returns public.app_role
language sql stable security definer set search_path = public
as $$
  select role from public.profiles where id = auth.uid()
$$;

create or replace function public.is_admin()
returns boolean
language sql stable
as $$
  select public.current_app_role() = 'admin'
$$;

-- ---------------------------------------------------------------------------
-- QuickBooks connection (tokens: service-role access only — RLS deny-all)
-- ---------------------------------------------------------------------------
create table public.qb_connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) default public.default_org_id(),
  realm_id text not null,
  access_token text not null,
  refresh_token text not null,
  access_token_expires_at timestamptz not null,
  refresh_token_expires_at timestamptz,
  connected_by uuid references public.profiles (id),
  status text not null default 'connected',   -- connected | revoked | error
  last_sync_at timestamptz,
  last_sync_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id)
);

-- ---------------------------------------------------------------------------
-- Customers & Jobs (read-only mirrors of QuickBooks Online)
-- ---------------------------------------------------------------------------
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) default public.default_org_id(),
  qb_id text not null,
  display_name text not null,
  company_name text,
  email text,
  phone text,
  billing_address jsonb,
  active boolean not null default true,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, qb_id)
);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) default public.default_org_id(),
  qb_id text not null,
  customer_id uuid references public.customers (id) on delete set null,
  name text not null,
  fully_qualified_name text,
  active boolean not null default true,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, qb_id)
);

create index jobs_customer_idx on public.jobs (customer_id);

-- ---------------------------------------------------------------------------
-- Project plans (job cost estimates)
-- Parameters mirror the Excel engine (SPREADSHEET_REVIEW.md §6.1):
--   labor_cost_rate default 37.15, default bill rate 102, consumables 15%,
--   overhead_pool manual + required at submit.
-- ---------------------------------------------------------------------------
create table public.project_plans (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) default public.default_org_id(),
  customer_id uuid references public.customers (id),
  job_id uuid references public.jobs (id),
  title text not null,
  description text,
  department text,
  project_manager text,
  contact_name text,
  contact_phone text,
  contact_email text,
  start_date date,
  end_date date,
  payment_terms_days int,
  notes text,
  status public.plan_status not null default 'draft',
  version int not null default 1,
  labor_cost_rate numeric not null default 37.15 check (labor_cost_rate >= 0),
  default_labor_bill_rate numeric not null default 102.00 check (default_labor_bill_rate >= 0),
  consumables_pct numeric not null default 0.15 check (consumables_pct >= 0 and consumables_pct <= 1),
  overhead_pool numeric check (overhead_pool >= 0),  -- required at submit (enforced in submit_plan)
  created_by uuid not null references public.profiles (id) default auth.uid(),
  submitted_at timestamptz,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index project_plans_status_idx on public.project_plans (status);
create index project_plans_customer_idx on public.project_plans (customer_id);

create table public.plan_phases (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.project_plans (id) on delete cascade,
  name text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create index plan_phases_plan_idx on public.plan_phases (plan_id);

-- Line items: inputs only. Every derived number lives in views (§6.3) so the
-- spreadsheet's manual-copy drift class of bugs cannot exist here.
create table public.plan_line_items (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.project_plans (id) on delete cascade,
  phase_id uuid references public.plan_phases (id) on delete set null,
  sort_order int not null default 0,
  description text not null default '',
  priority smallint not null default 1 check (priority in (1, 2, 3)),
  is_tbd boolean not null default false,
  -- labor inputs (Excel cols C, D, E, Q)
  events numeric not null default 0 check (events >= 0),
  hours_per_piece numeric not null default 0 check (hours_per_piece >= 0),
  quantity numeric not null default 1 check (quantity >= 0),
  labor_bill_rate numeric check (labor_bill_rate >= 0),  -- null -> plan default
  -- material inputs (Excel cols G, I, K, L, M)
  material_basis public.material_basis not null default 'per_each',
  length_per_piece numeric not null default 0 check (length_per_piece >= 0),
  weight_per_lf numeric not null default 0 check (weight_per_lf >= 0),
  unit_cost numeric not null default 0 check (unit_cost >= 0),
  lump_sum_cost numeric not null default 0 check (lump_sum_cost >= 0),
  material_markup_pct numeric not null default 0 check (material_markup_pct >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index plan_line_items_plan_idx on public.plan_line_items (plan_id);
create index plan_line_items_phase_idx on public.plan_line_items (phase_id);

-- ---------------------------------------------------------------------------
-- Approval configuration & records
-- ---------------------------------------------------------------------------
create table public.approval_thresholds (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) default public.default_org_id(),
  min_amount numeric not null check (min_amount >= 0),
  max_amount numeric,  -- null = no upper bound
  required_approvals int not null check (required_approvals >= 1),
  label text not null,
  created_at timestamptz not null default now(),
  check (max_amount is null or max_amount > min_amount)
);

insert into public.approval_thresholds (min_amount, max_amount, required_approvals, label) values
  (0,      25000,  1, '1 approver'),
  (25000,  100000, 2, '2 approvers'),
  (100000, null,   3, '2 approvers + finance/owner');

create or replace function public.required_approvals_for(p_amount numeric)
returns int
language sql stable
as $$
  select coalesce(
    (select required_approvals
       from public.approval_thresholds
      where p_amount >= min_amount and (max_amount is null or p_amount < max_amount)
      order by min_amount desc
      limit 1),
    1)
$$;

create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.project_plans (id) on delete cascade,
  plan_version int not null,
  approver_id uuid not null references public.profiles (id),
  decision public.approval_decision not null,
  comment text,
  created_at timestamptz not null default now(),
  unique (plan_id, plan_version, approver_id)
);

create index approvals_plan_idx on public.approvals (plan_id);

-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) default public.default_org_id(),
  entity_type text not null,
  entity_id uuid,
  action text not null,
  actor_id uuid,
  details jsonb,
  created_at timestamptz not null default now()
);

create index audit_log_entity_idx on public.audit_log (entity_type, entity_id);

create or replace function public.write_audit(
  p_entity_type text, p_entity_id uuid, p_action text, p_details jsonb default null
)
returns void
language sql security definer set search_path = public
as $$
  insert into public.audit_log (entity_type, entity_id, action, actor_id, details)
  values (p_entity_type, p_entity_id, p_action, auth.uid(), p_details)
$$;

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger touch_qb_connections before update on public.qb_connections
  for each row execute function public.touch_updated_at();
create trigger touch_customers before update on public.customers
  for each row execute function public.touch_updated_at();
create trigger touch_jobs before update on public.jobs
  for each row execute function public.touch_updated_at();
create trigger touch_project_plans before update on public.project_plans
  for each row execute function public.touch_updated_at();
create trigger touch_plan_line_items before update on public.plan_line_items
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- The cost engine (SPREADSHEET_REVIEW.md §6.3) — single source of truth
-- ---------------------------------------------------------------------------
create or replace view public.plan_line_item_costs
with (security_invoker = true)
as
with base as (
  select
    li.id, li.plan_id, li.phase_id, li.sort_order, li.description, li.priority,
    li.is_tbd, li.events, li.hours_per_piece, li.quantity, li.labor_bill_rate,
    li.material_basis, li.length_per_piece, li.weight_per_lf, li.unit_cost,
    li.lump_sum_cost, li.material_markup_pct,
    p.labor_cost_rate,
    coalesce(li.labor_bill_rate, p.default_labor_bill_rate) as effective_bill_rate,
    p.consumables_pct,
    coalesce(p.overhead_pool, 0) as overhead_pool,
    li.length_per_piece * li.quantity as total_length,
    li.hours_per_piece * li.quantity * li.events as total_hours
  from public.plan_line_items li
  join public.project_plans p on p.id = li.plan_id
),
mat as (
  select
    base.*,
    weight_per_lf * total_length as weight_est,
    case material_basis
      when 'per_lb'   then unit_cost * weight_per_lf * total_length
      when 'per_each' then unit_cost * quantity
      when 'per_sf'   then unit_cost * total_length
      when 'lump_sum' then lump_sum_cost
    end as material_cost,
    labor_cost_rate * total_hours as labor_cost,
    effective_bill_rate * total_hours as labor_price
  from base
),
alloc as (
  select
    mat.*,
    material_cost * (1 + material_markup_pct) as material_price,
    consumables_pct * labor_price as consumables,
    case
      when sum(labor_cost + material_cost) over (partition by plan_id) > 0
        then (labor_cost + material_cost)
             / sum(labor_cost + material_cost) over (partition by plan_id)
             * overhead_pool
      else 0
    end as overhead_alloc
  from mat
)
select
  id, plan_id, phase_id, sort_order, description, priority, is_tbd,
  events, hours_per_piece, quantity, material_basis, length_per_piece,
  weight_per_lf, unit_cost, lump_sum_cost, material_markup_pct,
  labor_bill_rate, effective_bill_rate, total_length, total_hours, weight_est,
  material_cost, material_price, labor_cost, labor_price, consumables,
  overhead_alloc,
  labor_cost + material_cost + consumables + overhead_alloc as line_cost,
  labor_price + material_price + consumables + overhead_alloc as line_price,
  (labor_price + material_price + consumables + overhead_alloc)
    - (labor_cost + material_cost + consumables + overhead_alloc) as profit
from alloc;

create or replace view public.plan_totals
with (security_invoker = true)
as
select
  plan_id,
  count(*)                 as line_count,
  count(*) filter (where is_tbd) as tbd_count,
  sum(total_hours)         as total_hours,
  sum(material_cost)       as material_cost,
  sum(material_price)      as material_price,
  sum(labor_cost)          as labor_cost,
  sum(labor_price)         as labor_price,
  sum(consumables)         as consumables,
  sum(overhead_alloc)      as overhead,
  sum(line_cost)           as total_cost,
  sum(line_price)          as total_price,
  sum(line_price) - sum(line_cost) as profit,
  case when sum(line_price) > 0
    then (sum(line_price) - sum(line_cost)) / sum(line_price)
    else 0 end             as profit_pct
from public.plan_line_item_costs
group by plan_id;

create or replace view public.plan_priority_totals
with (security_invoker = true)
as
select
  plan_id,
  priority,
  count(*)       as line_count,
  sum(line_cost)  as total_cost,
  sum(line_price) as total_price
from public.plan_line_item_costs
group by plan_id, priority;

-- ---------------------------------------------------------------------------
-- Edit locking: plan content is only editable in draft / changes_requested.
-- Workflow functions set app.workflow to bypass the status-field guard.
-- ---------------------------------------------------------------------------
create or replace function public.assert_plan_editable(p_plan_id uuid)
returns void
language plpgsql
as $$
declare
  s public.plan_status;
begin
  select status into s from public.project_plans where id = p_plan_id;
  if s is null then
    raise exception 'Plan % not found', p_plan_id;
  end if;
  if s not in ('draft', 'changes_requested') then
    raise exception 'Plan is % — line items and phases are locked', s;
  end if;
end;
$$;

create or replace function public.guard_plan_children()
returns trigger
language plpgsql
as $$
begin
  perform public.assert_plan_editable(coalesce(new.plan_id, old.plan_id));
  return coalesce(new, old);
end;
$$;

create trigger guard_line_items
  before insert or update or delete on public.plan_line_items
  for each row execute function public.guard_plan_children();

create trigger guard_phases
  before insert or update or delete on public.plan_phases
  for each row execute function public.guard_plan_children();

create or replace function public.guard_plan_update()
returns trigger
language plpgsql
as $$
declare
  workflow boolean := coalesce(current_setting('app.workflow', true), '') = '1';
begin
  -- Status machinery may only move through the workflow functions.
  if not workflow and (
       new.status is distinct from old.status
    or new.version is distinct from old.version
    or new.submitted_at is distinct from old.submitted_at
    or new.approved_at is distinct from old.approved_at
  ) then
    raise exception 'Plan status can only change through submit/approve/reject/request_changes';
  end if;
  -- Content fields are locked outside draft / changes_requested.
  if not workflow and old.status not in ('draft', 'changes_requested') then
    raise exception 'Plan is % — fields are locked', old.status;
  end if;
  return new;
end;
$$;

create trigger guard_project_plans
  before update on public.project_plans
  for each row execute function public.guard_plan_update();

-- ---------------------------------------------------------------------------
-- Workflow functions (security definer; they own status transitions)
-- ---------------------------------------------------------------------------

-- Submit: overhead required, customer required, at least one line item.
create or replace function public.submit_plan(p_plan_id uuid)
returns public.project_plans
language plpgsql security definer set search_path = public
as $$
declare
  plan public.project_plans;
  caller_role public.app_role := public.current_app_role();
begin
  select * into plan from public.project_plans where id = p_plan_id for update;
  if plan.id is null then
    raise exception 'Plan not found';
  end if;
  if caller_role not in ('estimator', 'admin') or (plan.created_by <> auth.uid() and caller_role <> 'admin') then
    raise exception 'Only the plan creator (or an admin) can submit this plan';
  end if;
  if plan.status not in ('draft', 'changes_requested') then
    raise exception 'Plan is % — only draft or changes-requested plans can be submitted', plan.status;
  end if;
  if plan.overhead_pool is null then
    raise exception 'Overhead is required before submitting (enter 0 if none)';
  end if;
  if plan.customer_id is null then
    raise exception 'A customer must be selected before submitting';
  end if;
  if not exists (select 1 from public.plan_line_items where plan_id = p_plan_id) then
    raise exception 'Plan has no line items';
  end if;

  perform set_config('app.workflow', '1', true);
  update public.project_plans
     set status = 'submitted',
         submitted_at = now(),
         version = case when status = 'changes_requested' then version + 1 else version end
   where id = p_plan_id
   returning * into plan;

  perform public.write_audit('project_plan', p_plan_id, 'submitted',
    jsonb_build_object('version', plan.version));
  return plan;
end;
$$;

-- Approve: TBD gate (hard block), threshold check, creator cannot self-approve.
create or replace function public.approve_plan(p_plan_id uuid, p_comment text default null)
returns public.project_plans
language plpgsql security definer set search_path = public
as $$
declare
  plan public.project_plans;
  caller_role public.app_role := public.current_app_role();
  tbd int;
  total numeric;
  needed int;
  granted int;
begin
  select * into plan from public.project_plans where id = p_plan_id for update;
  if plan.id is null then
    raise exception 'Plan not found';
  end if;
  if caller_role not in ('approver', 'admin') then
    raise exception 'Only approvers can approve plans';
  end if;
  if plan.created_by = auth.uid() then
    raise exception 'You cannot approve your own plan';
  end if;
  if plan.status <> 'submitted' then
    raise exception 'Plan is % — only submitted plans can be approved', plan.status;
  end if;

  select count(*) into tbd from public.plan_line_items where plan_id = p_plan_id and is_tbd;
  if tbd > 0 then
    raise exception 'Approval blocked: % TBD line item(s) must be priced or removed first', tbd;
  end if;

  insert into public.approvals (plan_id, plan_version, approver_id, decision, comment)
  values (p_plan_id, plan.version, auth.uid(), 'approved', p_comment);

  select coalesce(total_price, 0) into total from public.plan_totals where plan_id = p_plan_id;
  needed := public.required_approvals_for(coalesce(total, 0));
  select count(*) into granted
    from public.approvals
   where plan_id = p_plan_id and plan_version = plan.version and decision = 'approved';

  perform public.write_audit('project_plan', p_plan_id, 'approval_granted',
    jsonb_build_object('version', plan.version, 'approvals', granted, 'required', needed, 'total_price', total));

  if granted >= needed then
    perform set_config('app.workflow', '1', true);
    update public.project_plans
       set status = 'approved', approved_at = now()
     where id = p_plan_id
     returning * into plan;
    perform public.write_audit('project_plan', p_plan_id, 'approved',
      jsonb_build_object('version', plan.version, 'total_price', total));
  end if;
  return plan;
end;
$$;

create or replace function public.reject_plan(p_plan_id uuid, p_comment text)
returns public.project_plans
language plpgsql security definer set search_path = public
as $$
declare
  plan public.project_plans;
  caller_role public.app_role := public.current_app_role();
begin
  if p_comment is null or btrim(p_comment) = '' then
    raise exception 'A comment is required when rejecting';
  end if;
  select * into plan from public.project_plans where id = p_plan_id for update;
  if plan.id is null then
    raise exception 'Plan not found';
  end if;
  if caller_role not in ('approver', 'admin') then
    raise exception 'Only approvers can reject plans';
  end if;
  if plan.status <> 'submitted' then
    raise exception 'Plan is % — only submitted plans can be rejected', plan.status;
  end if;

  insert into public.approvals (plan_id, plan_version, approver_id, decision, comment)
  values (p_plan_id, plan.version, auth.uid(), 'rejected', p_comment);

  perform set_config('app.workflow', '1', true);
  update public.project_plans set status = 'rejected' where id = p_plan_id
  returning * into plan;

  perform public.write_audit('project_plan', p_plan_id, 'rejected',
    jsonb_build_object('version', plan.version, 'comment', p_comment));
  return plan;
end;
$$;

create or replace function public.request_changes(p_plan_id uuid, p_comment text)
returns public.project_plans
language plpgsql security definer set search_path = public
as $$
declare
  plan public.project_plans;
  caller_role public.app_role := public.current_app_role();
begin
  if p_comment is null or btrim(p_comment) = '' then
    raise exception 'A comment is required when requesting changes';
  end if;
  select * into plan from public.project_plans where id = p_plan_id for update;
  if plan.id is null then
    raise exception 'Plan not found';
  end if;
  if caller_role not in ('approver', 'admin') then
    raise exception 'Only approvers can request changes';
  end if;
  if plan.status <> 'submitted' then
    raise exception 'Plan is % — changes can only be requested on submitted plans', plan.status;
  end if;

  insert into public.approvals (plan_id, plan_version, approver_id, decision, comment)
  values (p_plan_id, plan.version, auth.uid(), 'changes_requested', p_comment);

  perform set_config('app.workflow', '1', true);
  update public.project_plans set status = 'changes_requested' where id = p_plan_id
  returning * into plan;

  perform public.write_audit('project_plan', p_plan_id, 'changes_requested',
    jsonb_build_object('version', plan.version, 'comment', p_comment));
  return plan;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
alter table public.organizations enable row level security;
alter table public.profiles enable row level security;
alter table public.qb_connections enable row level security;  -- no policies: service role only
alter table public.customers enable row level security;
alter table public.jobs enable row level security;
alter table public.project_plans enable row level security;
alter table public.plan_phases enable row level security;
alter table public.plan_line_items enable row level security;
alter table public.approval_thresholds enable row level security;
alter table public.approvals enable row level security;
alter table public.audit_log enable row level security;

-- organizations
create policy org_select on public.organizations
  for select to authenticated using (true);
create policy org_update on public.organizations
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- profiles: everyone signed in can see names; user edits own row; admin edits any.
create policy profiles_select on public.profiles
  for select to authenticated using (true);
create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

-- Role changes are admin-only even when a user updates their own row.
create or replace function public.guard_profile_update()
returns trigger
language plpgsql
as $$
begin
  if new.role is distinct from old.role and not public.is_admin() then
    raise exception 'Only admins can change roles';
  end if;
  if new.org_id is distinct from old.org_id and not public.is_admin() then
    raise exception 'Only admins can change organization';
  end if;
  return new;
end;
$$;

create trigger guard_profiles before update on public.profiles
  for each row execute function public.guard_profile_update();

-- customers / jobs: readable by all users; written by the sync (service role) or admin.
create policy customers_select on public.customers
  for select to authenticated using (true);
create policy customers_admin_write on public.customers
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy jobs_select on public.jobs
  for select to authenticated using (true);
create policy jobs_admin_write on public.jobs
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- project plans
create policy plans_select on public.project_plans
  for select to authenticated using (true);
create policy plans_insert on public.project_plans
  for insert to authenticated
  with check (created_by = auth.uid() and public.current_app_role() in ('estimator', 'admin'));
create policy plans_update on public.project_plans
  for update to authenticated
  using (created_by = auth.uid() or public.is_admin())
  with check (created_by = auth.uid() or public.is_admin());
create policy plans_delete on public.project_plans
  for delete to authenticated
  using (public.is_admin() or (created_by = auth.uid() and status = 'draft'));

-- phases & line items follow their plan's ownership
create policy phases_select on public.plan_phases
  for select to authenticated using (true);
create policy phases_write on public.plan_phases
  for all to authenticated
  using (exists (select 1 from public.project_plans p
                  where p.id = plan_id and (p.created_by = auth.uid() or public.is_admin())))
  with check (exists (select 1 from public.project_plans p
                       where p.id = plan_id and (p.created_by = auth.uid() or public.is_admin())));

create policy items_select on public.plan_line_items
  for select to authenticated using (true);
create policy items_write on public.plan_line_items
  for all to authenticated
  using (exists (select 1 from public.project_plans p
                  where p.id = plan_id and (p.created_by = auth.uid() or public.is_admin())))
  with check (exists (select 1 from public.project_plans p
                       where p.id = plan_id and (p.created_by = auth.uid() or public.is_admin())));

-- thresholds: read by all, managed by admin
create policy thresholds_select on public.approval_thresholds
  for select to authenticated using (true);
create policy thresholds_admin_write on public.approval_thresholds
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- approvals: readable by all; written only via workflow functions (no insert policy)
create policy approvals_select on public.approvals
  for select to authenticated using (true);

-- audit log: readable by all signed-in users; written only via write_audit
create policy audit_select on public.audit_log
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Safe status view of the QB connection (no tokens) for the settings page
-- ---------------------------------------------------------------------------
create view public.qb_connection_status as
select org_id, realm_id, status, last_sync_at, last_sync_error, created_at, updated_at
from public.qb_connections;

revoke all on public.qb_connection_status from anon;
grant select on public.qb_connection_status to authenticated;
