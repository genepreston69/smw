-- =============================================================================
-- Invoiced revenue from QuickBooks
--
-- Invoices in QuickBooks are billed to a customer or job (sub-customer).
-- The sync imports every invoice billed to a known job so the app can show
-- invoiced revenue next to actual cost, and so invoices count as activity
-- when deciding whether a job has recent transactions. Like job_costs, each
-- sync fully refreshes a company's rows (delete + insert) and only imports
-- invoices dated on or after JOB_COSTS_START_DATE.
-- =============================================================================

create table public.job_invoices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) default public.default_org_id(),
  realm_id text not null,
  job_id uuid not null references public.jobs (id) on delete cascade,
  qb_invoice_id text not null,
  doc_number text,
  txn_date date,
  amount numeric not null default 0,
  balance numeric,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  unique (org_id, realm_id, qb_invoice_id)
);

create index job_invoices_job_idx on public.job_invoices (job_id);
create index job_invoices_realm_idx on public.job_invoices (org_id, realm_id);

-- Read-only for signed-in users; written by the sync (service role).
alter table public.job_invoices enable row level security;
create policy job_invoices_select on public.job_invoices
  for select to authenticated using (true);

-- Per-job rollup for lists.
create view public.job_invoice_totals
with (security_invoker = true)
as
select job_id,
       sum(amount)   as total_invoiced,
       count(*)      as invoice_count,
       max(txn_date) as latest_invoice_date
from public.job_invoices
group by job_id;
