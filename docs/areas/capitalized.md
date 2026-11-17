# Capitalized Labor and Materials

`/capitalized-labor`, `/capitalized-labor/already-capitalized`, `/capitalized-materials`.

Code: `src/lib/capitalizedLabor.ts`, `src/lib/alreadyCapitalized.ts`, `src/lib/capitalizedMaterials.ts`, `src/lib/capitalizedMaterialsServer.ts`.

## Capitalized Labor

- `/capitalized-labor` lists journal-entry labor on non-billable (EQP) and intercompany jobs (job bucketing: `capLaborBucket` in `src/lib/capitalizedLabor.ts`).
- It is viewed for **one period at a time — a calendar year, a single month, or a from/to month range** (default: the current year to date; history back to Jan 2023; UTC dates, never past today).
- The URL is the state (`?year=2025`, `?month=2026-03`, `?from=2025-07&to=2026-06`; a range beats a month beats a year, anything invalid falls back to the default), and `capLaborPeriod` in `src/lib/capitalizedLabor.ts` is the one parser: the page, its job drill-down (the server action re-parses the page's params), both exports (`capLaborPeriodFromSearch`; download links carry the same params via `capLaborHref`), and the Already Capitalized page and export all filter by the window it returns, so screen and file always match.
- `PeriodPicker` (`src/app/(app)/capitalized-labor/`) is the shared year-pills / month / range control (plain links and GET forms).
- For multi-month periods both pages show a **By month** card and their workbooks a *By Month* sheet — `capLaborByMonth` (dashboard; follows the active tab on screen, all candidates in the file) and `capScheduleByMonth` (Already Capitalized) — and each month row links to that month alone.
- The benefit allocation column is read straight from `job_benefit_allocation_cache` for the period's months (month-grain, so a partial month counts in full).
- Which journal lines count, and how, lives only in the SQL view `cap_labor_lines` (migration `0030`), which the page, its line drill-down, and both exports read: **wages and the employer's share of payroll taxes count; withholdings from the employee's check — and every other payroll liability — never do** (expense-side accounts only, judged by `job_costs.account_classification`; lines whose account doesn't match the chart fall back to a name test).
- A counted line is *capitalized* only when its journal entry debits a Fixed Asset / Other Asset account (`job_costs.je_debits_asset`) — the asset varies by equipment and job, so detection is by account type, never name; everything else is *labor posted*, net of reversals.
- `syncJobCosts` stores those account facts per journal line (`isCapitalAssetAccount` in `src/lib/quickbooks.ts`); migration `0030` backfilled frozen pre-2025 rows from `gl_accounts` / `gl_line_facts` with the same rule.
- The labor-account test itself is one SQL function, `cap_labor_account(name, classification)` (migration `0032`), used by `cap_labor_lines` and by the **Already Capitalized** schedule (`/capitalized-labor/already-capitalized`, sidebar Capitalized Labor → Already Capitalized, admin-only because it reads the ledger): `capitalized_labor_entries(p_from, p_to)` (migration `0032`; `0033` scopes it to the org so `gl_lines_date_idx` range-scans just the window instead of the whole ledger) returns, as one JSON row, every general-ledger line of the journal entries that debit a Fixed Asset / Other Asset account and, net, credit labor — so it also catches capitalization credits with no job tag — and `src/lib/alreadyCapitalized.ts` shapes them into entries and a by-asset rollup (labor split pro-rata when an entry debits several assets) for both the page and its export (`/api/export/already-capitalized`, shared loader `loadCapSchedule`).
- It takes the same period selection as the dashboard (`capLaborPeriod`); a long range reads more of the ledger, and a timeout renders as a banner via `capScheduleErrorMessage`.

## Capitalized Materials

- `/capitalized-materials` (sidebar Capitalized Labor → Capitalized Materials, all signed-in users) lists everything **expensed on non-billable jobs in every QuickBooks company** — EQP equipment jobs and Precision Paint's own PPS jobs, the Jobs dashboard's Non-Billable rule minus its recency test (`capMaterialBucket` in `src/lib/capitalizedMaterials.ts`; transportation never qualifies).
- Which lines count lives only in the SQL view `cap_material_lines` (migration `0036`): bill, purchase and vendor-credit lines whose account is on the expense side (unknown counts — frozen item lines can't be traced), plus journal lines on a non-payroll expense account (`cap_material_account` = expense and **not** `cap_labor_account`, so no dollar is on both Capitalized pages); time entries never count.
- A journal line is *capitalized* when its entry debits a Fixed Asset / Other Asset account (`je_debits_asset`, same rule as labor), everything else *expensed*; awaiting review = expensed − capitalized.
- Expensed splits into Materials (item lines), Outside labor (bill/purchase on a labor item/account), and Other (`capMaterialKind`).
- It takes Capitalized Labor's period (`capLaborPeriod`, `PeriodPicker`) and `?tab=equipment|internal`.
- The page, its job drill-down (`getCapMaterialLines`), the CSV (`/api/export/capitalized-materials`) and the workbook (`/api/export/capitalized-materials-workbook`: Jobs, By Company, By Month, Expense Lines) all read through `loadCapMaterials` in `src/lib/capitalizedMaterialsServer.ts` — which reads lines only for the non-billable jobs, 100 job ids per request on `job_costs_job_date_idx` — and roll up with the helpers in `src/lib/capitalizedMaterials.ts`, so screen and file match.
- Pre-2025 frozen rows predate vendor-credit import and refund signing, so 2023–2024 figures are an upper bound (the page's methodology says so).
