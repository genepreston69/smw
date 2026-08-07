-- =============================================================================
-- Barge Program: custom deck barge proforma configurations & quotes.
-- Source model: the Custom Deck Barge Proforma workbench (component takeoff
-- for the 150' × 54' × 8' TSG deck/crane barge and derivative quotes).
--
-- Follows the project_plans blueprint exactly:
--   * inputs live in tables, every derived number lives in SQL views,
--   * the same draft → submitted → approved/rejected/changes_requested state
--     machine, owned by security-definer functions,
--   * approval_thresholds / required_approvals_for are reused (evaluated
--     against the quote's sales price),
--   * content locks outside draft/changes_requested via guard triggers,
--   * every transition writes to audit_log (entity_type 'barge_quote').
-- =============================================================================

create type public.barge_section as enum
  ('plating', 'deck_framing', 'bottom_side_framing', 'trusses');

-- ---------------------------------------------------------------------------
-- Saved rough-quote configurations (the parametric generator's inputs).
-- Pure parameter sets — no workflow; quotes generated from one keep a
-- provenance link back to it.
-- ---------------------------------------------------------------------------
create table public.barge_configs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) default public.default_org_id(),
  name text not null,
  notes text,
  -- principal dimensions
  length_ft numeric not null check (length_ft > 0),
  beam_ft numeric not null check (beam_ft > 0),
  depth_ft numeric not null check (depth_ft > 0),
  spud_wells int not null default 4 check (spud_wells >= 0),
  -- structure (TSG-calibrated defaults)
  deck_plate_in numeric not null default 0.5 check (deck_plate_in > 0),
  side_plate_in numeric not null default 0.375 check (side_plate_in > 0),
  bhd_plate_in numeric not null default 0.3125 check (bhd_plate_in > 0),
  long_bhd_spacing_ft numeric not null default 11 check (long_bhd_spacing_ft > 0),
  wt_bhd_spacing_ft numeric not null default 30 check (wt_bhd_spacing_ft > 0),
  plate_allowance_pct numeric not null default 22 check (plate_allowance_pct >= 0),
  framing_pct numeric not null default 39 check (framing_pct >= 0),
  yield_pct numeric not null default 88 check (yield_pct > 0 and yield_pct <= 100),
  -- market rates
  steel_per_lb numeric not null default 0.55 check (steel_per_lb >= 0),
  hours_per_ton numeric not null default 30 check (hours_per_ton >= 0),
  labor_rate numeric not null default 45 check (labor_rate >= 0),
  blast_per_sqft numeric not null default 4 check (blast_per_sqft >= 0),
  spud_well_cost numeric not null default 18000 check (spud_well_cost >= 0),
  fittings_per_sqft numeric not null default 4.5 check (fittings_per_sqft >= 0),
  target_pct numeric not null default 25 check (target_pct >= 0 and target_pct < 100),
  created_by uuid not null references public.profiles (id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Barge quotes (scenarios). Inputs only — totals live in views below.
-- ---------------------------------------------------------------------------
create table public.barge_quotes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) default public.default_org_id(),
  config_id uuid references public.barge_configs (id) on delete set null,
  customer_id uuid references public.customers (id),
  name text not null,
  notes text,
  status public.plan_status not null default 'draft',
  version int not null default 1,
  labor_rate numeric not null default 45 check (labor_rate >= 0),
  blast_cost numeric not null default 0 check (blast_cost >= 0),
  spuds_cost numeric not null default 0 check (spuds_cost >= 0),
  hatches_cost numeric not null default 0 check (hatches_cost >= 0),
  overhead_pct numeric not null default 35 check (overhead_pct >= 0),
  contingency_pct numeric not null default 0 check (contingency_pct >= 0),
  target_pct numeric not null default 25 check (target_pct >= 0 and target_pct < 100),
  sales_price numeric not null default 0 check (sales_price >= 0),
  created_by uuid not null references public.profiles (id) default auth.uid(),
  submitted_at timestamptz,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index barge_quotes_status_idx on public.barge_quotes (status);
create index barge_quotes_customer_idx on public.barge_quotes (customer_id);

-- Steel takeoff, line by structural component.
create table public.barge_quote_steel_lines (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.barge_quotes (id) on delete cascade,
  section public.barge_section not null,
  sort_order int not null default 0,
  item text not null default '',
  unit text not null default 'ft' check (unit in ('ft', 'plates', 'lot', 'each')),
  qty numeric not null default 0 check (qty >= 0),
  unit_lb numeric not null default 0 check (unit_lb >= 0),
  yield_pct numeric not null default 90 check (yield_pct > 0 and yield_pct <= 100),
  price_per_lb numeric not null default 0.85 check (price_per_lb >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index barge_quote_steel_lines_quote_idx on public.barge_quote_steel_lines (quote_id);

-- Labor by build phase.
create table public.barge_quote_labor_phases (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.barge_quotes (id) on delete cascade,
  sort_order int not null default 0,
  name text not null default '',
  hours numeric not null default 0 check (hours >= 0),
  created_at timestamptz not null default now()
);

create index barge_quote_labor_phases_quote_idx on public.barge_quote_labor_phases (quote_id);

-- Approval records, one per approver per version (mirrors public.approvals).
create table public.barge_quote_approvals (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.barge_quotes (id) on delete cascade,
  quote_version int not null,
  approver_id uuid not null references public.profiles (id),
  decision public.approval_decision not null,
  comment text,
  created_at timestamptz not null default now(),
  unique (quote_id, quote_version, approver_id)
);

create index barge_quote_approvals_quote_idx on public.barge_quote_approvals (quote_id);

-- updated_at maintenance
create trigger touch_barge_configs before update on public.barge_configs
  for each row execute function public.touch_updated_at();
create trigger touch_barge_quotes before update on public.barge_quotes
  for each row execute function public.touch_updated_at();
create trigger touch_barge_quote_steel_lines before update on public.barge_quote_steel_lines
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Cost engine. Mirrored client-side in src/lib/barge.ts for live editing —
-- any change here must be reflected there (and vice versa).
--   net lbs     = qty × lb/unit
--   ordered lbs = net ÷ yield          (purchase yield per line)
--   steel cost  = ordered × $/lb
-- Direct basis excludes overhead (fixed yard costs absorbed by repair work);
-- fully-absorbed re-applies overhead on labor. Contingency applies on top of
-- whichever subtotal the basis produces.
-- ---------------------------------------------------------------------------
create or replace view public.barge_quote_steel_line_costs
with (security_invoker = true)
as
select
  l.id, l.quote_id, l.section, l.sort_order, l.item, l.unit,
  l.qty, l.unit_lb, l.yield_pct, l.price_per_lb,
  l.qty * l.unit_lb as net_lbs,
  l.qty * l.unit_lb / (l.yield_pct / 100.0) as ordered_lbs,
  l.qty * l.unit_lb / (l.yield_pct / 100.0) * l.price_per_lb as steel_cost
from public.barge_quote_steel_lines l;

create or replace view public.barge_quote_totals
with (security_invoker = true)
as
with steel as (
  select quote_id,
         sum(net_lbs) as net_lbs,
         sum(ordered_lbs) as ordered_lbs,
         sum(steel_cost) as steel_cost
  from public.barge_quote_steel_line_costs
  group by quote_id
),
labor as (
  select quote_id, sum(hours) as total_hours
  from public.barge_quote_labor_phases
  group by quote_id
),
base as (
  select
    q.id as quote_id,
    coalesce(s.net_lbs, 0) as net_lbs,
    coalesce(s.ordered_lbs, 0) as ordered_lbs,
    coalesce(s.steel_cost, 0) as steel_cost,
    coalesce(l.total_hours, 0) as total_hours,
    coalesce(l.total_hours, 0) * q.labor_rate as labor_cost,
    q.blast_cost + q.spuds_cost + q.hatches_cost as fitout_cost,
    coalesce(l.total_hours, 0) * q.labor_rate * q.overhead_pct / 100.0 as overhead_cost,
    q.contingency_pct,
    q.target_pct,
    q.sales_price
  from public.barge_quotes q
  left join steel s on s.quote_id = q.id
  left join labor l on l.quote_id = q.id
)
select
  quote_id,
  net_lbs,
  ordered_lbs,
  net_lbs / 2000.0 as net_tons,
  steel_cost,
  total_hours,
  labor_cost,
  fitout_cost,
  overhead_cost,
  case when net_lbs > 0 then total_hours / (net_lbs / 2000.0) else 0 end as hours_per_ton,
  (steel_cost + labor_cost + fitout_cost) * (1 + contingency_pct / 100.0) as direct_cost,
  (steel_cost + labor_cost + fitout_cost + overhead_cost) * (1 + contingency_pct / 100.0) as absorbed_cost,
  sales_price
    - (steel_cost + labor_cost + fitout_cost) * (1 + contingency_pct / 100.0) as direct_margin,
  sales_price
    - (steel_cost + labor_cost + fitout_cost + overhead_cost) * (1 + contingency_pct / 100.0) as absorbed_margin,
  case when sales_price > 0 then
    (sales_price - (steel_cost + labor_cost + fitout_cost) * (1 + contingency_pct / 100.0))
      / sales_price
  else 0 end as direct_margin_pct,
  (steel_cost + labor_cost + fitout_cost) * (1 + contingency_pct / 100.0)
    / (1 - target_pct / 100.0) as price_at_target
from base;

-- ---------------------------------------------------------------------------
-- Edit locking: quote content is only editable in draft / changes_requested.
-- Workflow functions set app.workflow to bypass the status-field guard —
-- the same setting the plan guards use.
-- ---------------------------------------------------------------------------
create or replace function public.assert_barge_quote_editable(p_quote_id uuid)
returns void
language plpgsql
as $$
declare
  s public.plan_status;
begin
  select status into s from public.barge_quotes where id = p_quote_id;
  if s is null then
    raise exception 'Barge quote % not found', p_quote_id;
  end if;
  if s not in ('draft', 'changes_requested') then
    raise exception 'Quote is % — takeoff and labor are locked', s;
  end if;
end;
$$;

create or replace function public.guard_barge_quote_children()
returns trigger
language plpgsql
as $$
begin
  perform public.assert_barge_quote_editable(coalesce(new.quote_id, old.quote_id));
  return coalesce(new, old);
end;
$$;

create trigger guard_barge_steel_lines
  before insert or update or delete on public.barge_quote_steel_lines
  for each row execute function public.guard_barge_quote_children();

create trigger guard_barge_labor_phases
  before insert or update or delete on public.barge_quote_labor_phases
  for each row execute function public.guard_barge_quote_children();

create or replace function public.guard_barge_quote_update()
returns trigger
language plpgsql
as $$
declare
  workflow boolean := coalesce(current_setting('app.workflow', true), '') = '1';
begin
  if not workflow and (
       new.status is distinct from old.status
    or new.version is distinct from old.version
    or new.submitted_at is distinct from old.submitted_at
    or new.approved_at is distinct from old.approved_at
  ) then
    raise exception 'Quote status can only change through submit/approve/reject/request_changes';
  end if;
  if not workflow and old.status not in ('draft', 'changes_requested') then
    raise exception 'Quote is % — fields are locked', old.status;
  end if;
  return new;
end;
$$;

create trigger guard_barge_quotes
  before update on public.barge_quotes
  for each row execute function public.guard_barge_quote_update();

-- ---------------------------------------------------------------------------
-- Workflow functions (security definer; they own status transitions).
-- Same rules as plans: creator (or admin) submits; approvers (never the
-- creator) decide; comments required to reject / request changes; approval
-- count comes from approval_thresholds evaluated against the sales price.
-- ---------------------------------------------------------------------------

create or replace function public.submit_barge_quote(p_quote_id uuid)
returns public.barge_quotes
language plpgsql security definer set search_path = public
as $$
declare
  quote public.barge_quotes;
  caller_role public.app_role := public.current_app_role();
begin
  select * into quote from public.barge_quotes where id = p_quote_id for update;
  if quote.id is null then
    raise exception 'Quote not found';
  end if;
  if caller_role not in ('estimator', 'admin') or (quote.created_by <> auth.uid() and caller_role <> 'admin') then
    raise exception 'Only the quote creator (or an admin) can submit this quote';
  end if;
  if quote.status not in ('draft', 'changes_requested') then
    raise exception 'Quote is % — only draft or changes-requested quotes can be submitted', quote.status;
  end if;
  if quote.sales_price <= 0 then
    raise exception 'A sales price is required before submitting';
  end if;
  if not exists (select 1 from public.barge_quote_steel_lines where quote_id = p_quote_id) then
    raise exception 'Quote has no steel takeoff lines';
  end if;
  if not exists (select 1 from public.barge_quote_labor_phases where quote_id = p_quote_id) then
    raise exception 'Quote has no labor phases';
  end if;

  perform set_config('app.workflow', '1', true);
  update public.barge_quotes
     set status = 'submitted',
         submitted_at = now(),
         version = case when status = 'changes_requested' then version + 1 else version end
   where id = p_quote_id
   returning * into quote;

  perform public.write_audit('barge_quote', p_quote_id, 'submitted',
    jsonb_build_object('version', quote.version));
  return quote;
end;
$$;

create or replace function public.approve_barge_quote(p_quote_id uuid, p_comment text default null)
returns public.barge_quotes
language plpgsql security definer set search_path = public
as $$
declare
  quote public.barge_quotes;
  caller_role public.app_role := public.current_app_role();
  needed int;
  granted int;
begin
  select * into quote from public.barge_quotes where id = p_quote_id for update;
  if quote.id is null then
    raise exception 'Quote not found';
  end if;
  if caller_role not in ('approver', 'admin') then
    raise exception 'Only approvers can approve quotes';
  end if;
  if quote.created_by = auth.uid() then
    raise exception 'You cannot approve your own quote';
  end if;
  if quote.status <> 'submitted' then
    raise exception 'Quote is % — only submitted quotes can be approved', quote.status;
  end if;

  insert into public.barge_quote_approvals (quote_id, quote_version, approver_id, decision, comment)
  values (p_quote_id, quote.version, auth.uid(), 'approved', p_comment);

  needed := public.required_approvals_for(quote.sales_price);
  select count(*) into granted
    from public.barge_quote_approvals
   where quote_id = p_quote_id and quote_version = quote.version and decision = 'approved';

  perform public.write_audit('barge_quote', p_quote_id, 'approval_granted',
    jsonb_build_object('version', quote.version, 'approvals', granted, 'required', needed,
                       'sales_price', quote.sales_price));

  if granted >= needed then
    perform set_config('app.workflow', '1', true);
    update public.barge_quotes
       set status = 'approved', approved_at = now()
     where id = p_quote_id
     returning * into quote;
    perform public.write_audit('barge_quote', p_quote_id, 'approved',
      jsonb_build_object('version', quote.version, 'sales_price', quote.sales_price));
  end if;
  return quote;
end;
$$;

create or replace function public.reject_barge_quote(p_quote_id uuid, p_comment text)
returns public.barge_quotes
language plpgsql security definer set search_path = public
as $$
declare
  quote public.barge_quotes;
  caller_role public.app_role := public.current_app_role();
begin
  if p_comment is null or btrim(p_comment) = '' then
    raise exception 'A comment is required when rejecting';
  end if;
  select * into quote from public.barge_quotes where id = p_quote_id for update;
  if quote.id is null then
    raise exception 'Quote not found';
  end if;
  if caller_role not in ('approver', 'admin') then
    raise exception 'Only approvers can reject quotes';
  end if;
  if quote.status <> 'submitted' then
    raise exception 'Quote is % — only submitted quotes can be rejected', quote.status;
  end if;

  insert into public.barge_quote_approvals (quote_id, quote_version, approver_id, decision, comment)
  values (p_quote_id, quote.version, auth.uid(), 'rejected', p_comment);

  perform set_config('app.workflow', '1', true);
  update public.barge_quotes set status = 'rejected' where id = p_quote_id
  returning * into quote;

  perform public.write_audit('barge_quote', p_quote_id, 'rejected',
    jsonb_build_object('version', quote.version, 'comment', p_comment));
  return quote;
end;
$$;

create or replace function public.request_barge_quote_changes(p_quote_id uuid, p_comment text)
returns public.barge_quotes
language plpgsql security definer set search_path = public
as $$
declare
  quote public.barge_quotes;
  caller_role public.app_role := public.current_app_role();
begin
  if p_comment is null or btrim(p_comment) = '' then
    raise exception 'A comment is required when requesting changes';
  end if;
  select * into quote from public.barge_quotes where id = p_quote_id for update;
  if quote.id is null then
    raise exception 'Quote not found';
  end if;
  if caller_role not in ('approver', 'admin') then
    raise exception 'Only approvers can request changes';
  end if;
  if quote.status <> 'submitted' then
    raise exception 'Quote is % — changes can only be requested on submitted quotes', quote.status;
  end if;

  insert into public.barge_quote_approvals (quote_id, quote_version, approver_id, decision, comment)
  values (p_quote_id, quote.version, auth.uid(), 'changes_requested', p_comment);

  perform set_config('app.workflow', '1', true);
  update public.barge_quotes set status = 'changes_requested' where id = p_quote_id
  returning * into quote;

  perform public.write_audit('barge_quote', p_quote_id, 'changes_requested',
    jsonb_build_object('version', quote.version, 'comment', p_comment));
  return quote;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row-level security (mirrors the plan policies)
-- ---------------------------------------------------------------------------
alter table public.barge_configs enable row level security;
alter table public.barge_quotes enable row level security;
alter table public.barge_quote_steel_lines enable row level security;
alter table public.barge_quote_labor_phases enable row level security;
alter table public.barge_quote_approvals enable row level security;

create policy barge_configs_select on public.barge_configs
  for select to authenticated using (true);
create policy barge_configs_insert on public.barge_configs
  for insert to authenticated
  with check (created_by = auth.uid() and public.current_app_role() in ('estimator', 'admin'));
create policy barge_configs_update on public.barge_configs
  for update to authenticated
  using (created_by = auth.uid() or public.is_admin())
  with check (created_by = auth.uid() or public.is_admin());
create policy barge_configs_delete on public.barge_configs
  for delete to authenticated
  using (created_by = auth.uid() or public.is_admin());

create policy barge_quotes_select on public.barge_quotes
  for select to authenticated using (true);
create policy barge_quotes_insert on public.barge_quotes
  for insert to authenticated
  with check (created_by = auth.uid() and public.current_app_role() in ('estimator', 'admin'));
create policy barge_quotes_update on public.barge_quotes
  for update to authenticated
  using (created_by = auth.uid() or public.is_admin())
  with check (created_by = auth.uid() or public.is_admin());
create policy barge_quotes_delete on public.barge_quotes
  for delete to authenticated
  using (public.is_admin() or (created_by = auth.uid() and status = 'draft'));

create policy barge_steel_lines_select on public.barge_quote_steel_lines
  for select to authenticated using (true);
create policy barge_steel_lines_write on public.barge_quote_steel_lines
  for all to authenticated
  using (exists (select 1 from public.barge_quotes q
                  where q.id = quote_id and (q.created_by = auth.uid() or public.is_admin())))
  with check (exists (select 1 from public.barge_quotes q
                       where q.id = quote_id and (q.created_by = auth.uid() or public.is_admin())));

create policy barge_labor_phases_select on public.barge_quote_labor_phases
  for select to authenticated using (true);
create policy barge_labor_phases_write on public.barge_quote_labor_phases
  for all to authenticated
  using (exists (select 1 from public.barge_quotes q
                  where q.id = quote_id and (q.created_by = auth.uid() or public.is_admin())))
  with check (exists (select 1 from public.barge_quotes q
                       where q.id = quote_id and (q.created_by = auth.uid() or public.is_admin())));

-- approvals: readable by all; written only via the workflow functions
create policy barge_quote_approvals_select on public.barge_quote_approvals
  for select to authenticated using (true);
