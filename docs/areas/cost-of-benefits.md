# Cost of Benefits

`/financials/benefits`. Code: `src/lib/benefitCost.ts`, `src/lib/benefitCostServer.ts`, `src/app/(app)/financials/benefits/`, `src/app/api/export/benefits/`.

- `/financials/benefits` (admin-only, sidebar Financials → Cost of Benefits) shows the benefit rate by month: **Employee Benefits ÷ the base accounts** — by default 710 Labor Cost + 935 Salaries & Wages + 934 Labor Maint.
- The base accounts are a setting (`benefitBaseAccounts`, edited under Settings → Business rules; see *Business rules* in `CLAUDE.md`). The page and export load it and pass it as `bases` to every function in `benefitCost.ts`; nothing there hard-codes an account.
- The numerator is every Expense account whose `gl_accounts.category` is Employee Benefits (looked up in each company's own chart); the labor accounts are found by account number on any segment of the account's full name, so their sub-accounts count, and an account categorized Employee Benefits is never also labor.
- The rules live only in `src/lib/benefitCost.ts` (`benefitLineFor`, `buildBenefitCost`); `loadBenefitCost` in `src/lib/benefitCostServer.ts` reads the ledger through `budget_ledger_summary` exactly as the Income Statement does, so every line ties to it.
- Ledger as booked, no allocation — this is separate from the job-level `job_benefit_allocation_*` views.
- The Total column is period benefits ÷ period labor, not an average of monthly rates.
- It shows one QuickBooks class at a time (`?class=`, default All classes, the Income Statement's `ClassSelect`) plus a **By class** table of period totals; a class's rate is its own booked benefits over its own booked labor, and the classes sum to All classes because both come from the same cells.
- `benefitCostState` parses the params for both the page and the Excel export (`/api/export/benefits`, link built by `benefitCostExportHref`: the on-screen view, a By Class sheet, and on All classes one by-month sheet per class via `costOf`), so the file matches the screen from a single ledger read.
