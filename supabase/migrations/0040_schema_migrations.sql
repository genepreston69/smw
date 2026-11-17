-- =============================================================================
-- Migration tracking
--
-- Migrations are applied by hand (pasted into the Supabase SQL editor), and
-- until now nothing recorded which ones a database had. Code that needed a
-- migration could be deployed ahead of it, and the only symptom was a feature
-- failing with "function not found".
--
-- public.schema_migrations is that record: one row per migration file, keyed
-- by FILE NAME (two early files share the number 0024, so numbers are not
-- keys). The app compares it with the files it was built from
-- (EXPECTED_MIGRATIONS in src/lib/schemaVersion.ts) and tells admins, on every
-- page, when the database is behind.
--
-- THE CONVENTION FROM HERE ON: every new migration file ends with
--
--   insert into public.schema_migrations (filename)
--   values ('NNNN_description.sql') on conflict do nothing;
--
-- and is added to EXPECTED_MIGRATIONS. The test suite fails if either is
-- missed, or if a new file reuses a number.
--
-- The files that predate this table can't record themselves. The six most
-- recent are recorded only if the object each creates is actually present, so
-- a database that skipped one shows it as missing. Everything older is
-- recorded as assumed (verified = false): this migration could not have been
-- reached without them, but nothing here proves each one ran.
-- =============================================================================

create table if not exists public.schema_migrations (
  filename text primary key,
  applied_at timestamptz not null default now(),
  -- true: recorded by the migration itself, or its objects were found.
  -- false: predates this table and is assumed applied.
  verified boolean not null default true
);

alter table public.schema_migrations enable row level security;

-- Admins can read it (the Settings page shows the database version); nobody
-- writes it through the API — only migrations do.
drop policy if exists schema_migrations_select on public.schema_migrations;
create policy schema_migrations_select on public.schema_migrations
  for select to authenticated using ((select public.is_admin()));

revoke all on public.schema_migrations from anon;
revoke insert, update, delete on public.schema_migrations from authenticated;

-- Older files: assumed.
insert into public.schema_migrations (filename, verified) values
  ('0001_initial_schema.sql', false),
  ('0002_admin_deletes.sql', false),
  ('0003_multi_company.sql', false),
  ('0004_job_costs.sql', false),
  ('0005_job_cost_types.sql', false),
  ('0006_job_invoices.sql', false),
  ('0007_job_period_totals.sql', false),
  ('0008_capitalized_labor.sql', false),
  ('0009_general_ledger.sql', false),
  ('0010_gl_drilldown.sql', false),
  ('0011_gl_lines_atomic_refresh.sql', false),
  ('0012_service_role_statement_timeout.sql', false),
  ('0013_gl_generation_refresh.sql', false),
  ('0014_financials_admin_only.sql', false),
  ('0015_financials_rls_initplan.sql', false),
  ('0016_signup_domain_whitelist.sql', false),
  ('0017_barge_program.sql', false),
  ('0018_delete_guard_fixes.sql', false),
  ('0019_account_category.sql', false),
  ('0020_freeze_pre_2025_gl_history.sql', false),
  ('0021_job_benefit_allocation.sql', false),
  ('0022_job_benefit_allocation_months.sql', false),
  ('0023_job_benefit_allocation_performance.sql', false),
  ('0024_capitalized_labor_page_load.sql', false),
  ('0024_scheduled_qb_sync.sql', false),
  ('0025_job_benefit_allocation_cache.sql', false),
  ('0026_budget.sql', false),
  ('0027_budget_ledger_summary.sql', false),
  ('0028_budget_category_growth.sql', false),
  ('0029_budget_initiative_end_month.sql', false),
  ('0030_capitalized_labor_treatment.sql', false),
  ('0031_budget_account_overrides.sql', false),
  ('0032_already_capitalized.sql', false),
  ('0033_already_capitalized_index_scan.sql', false)
on conflict do nothing;

-- The six most recent: recorded only where their objects exist.
insert into public.schema_migrations (filename)
select '0034_budget_by_class.sql'
where exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'budget_initiatives' and column_name = 'class_name')
on conflict do nothing;

insert into public.schema_migrations (filename)
select '0035_budget_ledger_index_scan.sql'
where coalesce((select pg_get_functiondef(p.oid) like '%default_org_id%' from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'budget_ledger_summary' limit 1), false)
on conflict do nothing;

insert into public.schema_migrations (filename)
select '0036_capitalized_materials.sql'
where to_regclass('public.cap_material_lines') is not null
on conflict do nothing;

insert into public.schema_migrations (filename)
select '0037_sync_benefit_allocation_step.sql'
where coalesce((select pg_get_constraintdef(c.oid) like '%benefit_allocation%' from pg_constraint c where c.conname = 'qb_sync_steps_kind_check' limit 1), false)
on conflict do nothing;

insert into public.schema_migrations (filename)
select '0038_lock_down_audit_and_workflow.sql'
where not has_function_privilege('authenticated', 'public.write_audit(text, uuid, text, jsonb)', 'execute')
on conflict do nothing;

insert into public.schema_migrations (filename)
select '0039_sync_and_save_safeguards.sql'
where to_regprocedure('public.cancel_qb_sync_run(uuid, text)') is not null
on conflict do nothing;

insert into public.schema_migrations (filename)
values ('0040_schema_migrations.sql') on conflict do nothing;
