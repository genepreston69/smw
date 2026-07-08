-- =============================================================================
-- Actual job costs from QuickBooks
--
-- Bills and purchases in QuickBooks can tag each line to a customer/job,
-- and time entries tag hours to a job. The sync imports every cost line and
-- time entry tagged to a known job so the app can show actual cost per job
-- and estimate-vs-actual on plans. Time entries are valued at the internal
-- labor cost rate. Each sync fully refreshes a company's rows
-- (delete + insert), so QuickBooks edits and deletions are always reflected.
-- =============================================================================

create table public.job_costs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) default public.default_org_id(),
  realm_id text not null,
  job_id uuid not null references public.jobs (id) on delete cascade,
  qb_txn_type text not null,          -- Bill | Purchase | TimeActivity
  qb_txn_id text not null,
  qb_line_id text not null,
  txn_date date,
  vendor_name text,                    -- vendor, or employee for time entries
  description text,
  category text,                       -- QuickBooks account or item name
  amount numeric not null default 0,
  hours numeric,                       -- time entries only
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  unique (org_id, realm_id, qb_txn_type, qb_txn_id, qb_line_id)
);

create index job_costs_job_idx on public.job_costs (job_id);
create index job_costs_realm_idx on public.job_costs (org_id, realm_id);

-- Read-only for signed-in users; written by the sync (service role).
alter table public.job_costs enable row level security;
create policy job_costs_select on public.job_costs
  for select to authenticated using (true);

-- Per-job rollup for lists.
create view public.job_cost_totals
with (security_invoker = true)
as
select job_id,
       sum(amount)  as total_amount,
       sum(hours)   as total_hours,
       count(*)     as line_count,
       max(txn_date) as latest_txn_date
from public.job_costs
group by job_id;
