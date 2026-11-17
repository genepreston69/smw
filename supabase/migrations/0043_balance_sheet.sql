-- =============================================================================
-- Balance Sheet snapshots, and the month-end pull that fills them
--
-- The Balance Sheet page shows each company's balance sheet as of the end of
-- the prior month. It is not summed from gl_lines: the imported ledger starts
-- at the import window and has no opening balances, so balances built from it
-- would be short by everything posted earlier. Each company's BalanceSheet
-- report is pulled from QuickBooks instead and kept here, one row per company
-- per month end, so it ties to QuickBooks and earlier month ends stay
-- available.
--
-- Two things fill the table, both through the sync queue (migration 0024):
--
--   * a 'month_end' run, started by the cron worker in the first hours of the
--     1st (local time) — the month closed at midnight, so the page rolls over
--     to it then rather than at the 4 AM sync;
--   * a 'balance_sheet' step per company in every nightly run, which re-pulls
--     the same month end so entries posted to it during the close show up.
--
-- Apply this before deploying the code that plans these. (If the order slips,
-- the nightly run starts without the balance sheet steps, the month-end run
-- is skipped, and the page says this migration is missing.)
-- =============================================================================

create table if not exists public.balance_sheet_snapshots (
  org_id uuid not null references public.organizations (id) default public.default_org_id(),
  realm_id text not null,
  -- The month end the balances are as of.
  as_of date not null,
  -- The parsed report: { "nodes": [ … ] } (BsNode in src/lib/balanceSheet.ts).
  report jsonb not null,
  total_assets numeric(16, 2) not null,
  total_liabilities_equity numeric(16, 2) not null,
  fetched_at timestamptz not null default now(),
  primary key (org_id, realm_id, as_of)
);

create index if not exists balance_sheet_snapshots_as_of
  on public.balance_sheet_snapshots (org_id, as_of desc);

-- Admin-only, like the ledger (migration 0014). Written only by the sync
-- through the service-role client: there is no insert or update policy.
alter table public.balance_sheet_snapshots enable row level security;

drop policy if exists balance_sheet_snapshots_select on public.balance_sheet_snapshots;
create policy balance_sheet_snapshots_select on public.balance_sheet_snapshots
  for select to authenticated using ((select public.is_admin()));

revoke all on public.balance_sheet_snapshots from anon;
revoke insert, update, delete, truncate on public.balance_sheet_snapshots from authenticated;

-- The new step kind.
alter table public.qb_sync_steps
  drop constraint if exists qb_sync_steps_kind_check;

alter table public.qb_sync_steps
  add constraint qb_sync_steps_kind_check
  check (kind in ('customers_jobs', 'job_costs', 'general_ledger', 'benefit_allocation', 'balance_sheet'));

-- The new run trigger. Like a scheduled run its steps are retried by the cron
-- worker; unlike one it does not count as "the nightly sync" (the Settings
-- card and the sync-health banner read trigger = 'scheduled').
alter table public.qb_sync_runs
  drop constraint if exists qb_sync_runs_trigger_check;

alter table public.qb_sync_runs
  add constraint qb_sync_runs_trigger_check
  check (trigger in ('scheduled', 'manual', 'month_end'));

-- One month-end run per org per local date: every tick in the rollover window
-- after the first gets null from begin_qb_sync_run and just drains the queue.
create unique index if not exists qb_sync_runs_one_month_end_per_day
  on public.qb_sync_runs (org_id, local_date)
  where trigger = 'month_end';

insert into public.schema_migrations (filename)
values ('0043_balance_sheet.sql') on conflict do nothing;
