// The migration files this build of the app expects the database to have.
//
// Migrations are applied by hand, so code can be deployed ahead of the
// database. public.schema_migrations (migration 0040) records what a database
// has; the app compares it with this list and tells admins what is missing
// (schemaStatus.ts → the layout's banner and the Settings page).
//
// ADD EVERY NEW MIGRATION FILE HERE, and end the file with its own
//   insert into public.schema_migrations (filename) values ('…') on conflict do nothing;
// The test suite fails if this list and supabase/migrations/ disagree.
export const EXPECTED_MIGRATIONS: readonly string[] = [
  "0001_initial_schema.sql",
  "0002_admin_deletes.sql",
  "0003_multi_company.sql",
  "0004_job_costs.sql",
  "0005_job_cost_types.sql",
  "0006_job_invoices.sql",
  "0007_job_period_totals.sql",
  "0008_capitalized_labor.sql",
  "0009_general_ledger.sql",
  "0010_gl_drilldown.sql",
  "0011_gl_lines_atomic_refresh.sql",
  "0012_service_role_statement_timeout.sql",
  "0013_gl_generation_refresh.sql",
  "0014_financials_admin_only.sql",
  "0015_financials_rls_initplan.sql",
  "0016_signup_domain_whitelist.sql",
  "0017_barge_program.sql",
  "0018_delete_guard_fixes.sql",
  "0019_account_category.sql",
  "0020_freeze_pre_2025_gl_history.sql",
  "0021_job_benefit_allocation.sql",
  "0022_job_benefit_allocation_months.sql",
  "0023_job_benefit_allocation_performance.sql",
  // Two files share 0024 (both long applied); rows are keyed by file name.
  "0024_capitalized_labor_page_load.sql",
  "0024_scheduled_qb_sync.sql",
  "0025_job_benefit_allocation_cache.sql",
  "0026_budget.sql",
  "0027_budget_ledger_summary.sql",
  "0028_budget_category_growth.sql",
  "0029_budget_initiative_end_month.sql",
  "0030_capitalized_labor_treatment.sql",
  "0031_budget_account_overrides.sql",
  "0032_already_capitalized.sql",
  "0033_already_capitalized_index_scan.sql",
  "0034_budget_by_class.sql",
  "0035_budget_ledger_index_scan.sql",
  "0036_capitalized_materials.sql",
  "0037_sync_benefit_allocation_step.sql",
  "0038_lock_down_audit_and_workflow.sql",
  "0039_sync_and_save_safeguards.sql",
  "0040_schema_migrations.sql",
  "0041_app_settings.sql",
  "0042_ledger_pivot_scope.sql",
];

/** The first migration that records itself; earlier ones are back-filled. */
export const TRACKING_MIGRATION = "0040_schema_migrations.sql";

/** Expected files the database has no record of, in order. */
export function missingMigrations(applied: Iterable<string>): string[] {
  const have = new Set(applied);
  return EXPECTED_MIGRATIONS.filter((f) => !have.has(f));
}
