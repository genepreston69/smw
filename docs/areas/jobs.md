# Jobs dashboard and benefit allocation

`/jobs`. Code: `src/lib/jobViews.ts`, `src/lib/enterprise.ts`, `src/lib/benefitAllocation.ts`, `src/app/(app)/jobs/`.

## The five views

- `src/lib/jobViews.ts` buckets every job into exactly one of five views (Customer Jobs, Transportation, Intercompany, Non-Billable, No Transactions).
- The dashboard tabs (`src/app/(app)/jobs/`) and the Excel workbook export (`src/app/api/export/jobs-workbook/`) must bucket identically, so the rules live only here:
- Job-number suffix `LH`/`HS`/`FL`/`BC` → Transportation; prefix `EQP` → Non-Billable; jobs in the Precision Paint QB company under the `PPS` customer → Non-Billable (internal self-work).
- Sister-company customers (fuzzy name matching in `src/lib/enterprise.ts`) → Intercompany.
  - The list of sister companies is a setting (`intercompany`, Settings → Business rules). `isEnterpriseName`, `classifyJobView` and `capLaborBucket` take it as a **required** argument, so every screen and export that buckets jobs must load it (`loadAppSettings`) and they cannot disagree.
- No cost/invoice activity since `NO_TXN_CUTOFF` (`src/lib/businessRules.ts`) → No Transactions (US Army Corps of Engineers jobs are exempt and stay under Customer Jobs).

## Benefit allocation column

- The dashboards' Benefit allocation column (Jobs and Capitalized Jobs, plus their workbook exports) comes from the `job_benefit_allocation_months` view (migrations `0021`/`0022`; `job_benefit_allocation_totals` is its all-time/YTD/MTD rollup): per QB company × month it computes the employee-benefits allocation — Employee Benefits × Direct Labor ÷ (Direct Labor + Salaries & Wages), matched via `gl_accounts.category` and account names — and distributes it across that company's jobs pro-rata by direct-labor cost.
- It once mirrored an Income Statement reclassification that has since been removed, so this view is now the allocation's only definition; the views are intentionally **not** `security_invoker` so they can aggregate the admin-only `gl_lines` while exposing only per-job dollars to all signed-in users.
- Deriving the allocation is far too slow for a page load — even one evaluation blows the authenticated role's statement timeout, and a bigger timeout is not available to browser-facing roles (`statement_timeout` is armed before a function's own `SET` applies, see migration `0012`) — so **nothing reads it live**: migration `0025` materializes the month view as `job_benefit_allocation_cache` and points every reader at it (`job_benefit_allocation_totals` for the Jobs dashboard; the Capitalized Jobs page and its workbook read the cache's job × month rows for the selected period directly, through `loadCapJobs` — `job_benefit_allocation_summary(p_from, p_to)` from `0024_capitalized_labor_page_load.sql` also reads the cache but is no longer called by the app).
- The cache is rebuilt by `refresh_job_benefit_allocation()` — granted to `service_role` only, wrapped by `refreshBenefitAllocation()` in `src/lib/benefitAllocation.ts` — at the moments its inputs move: a manual jobs/costs sync, a manual ledger sync, the nightly run's last step (`benefit_allocation`, which uses the throwing `rebuildBenefitAllocation()` so a failure is retried and visible), and an account's category changing.
- Anything else that can change those inputs must refresh it too, or the dashboards go stale.
