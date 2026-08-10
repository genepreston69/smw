# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## What this app is

SMW Job Plans: job cost estimating with a multi-step approval workflow, sitting as a middle layer in front of QuickBooks Online. Customers, jobs, actual costs, and invoices are imported from QuickBooks (read-only); plans are estimated, submitted, and approved here. Stack: Next.js 16 (App Router, deployed on Vercel) + Supabase (Postgres, Auth, RLS) + Tailwind CSS 4 + TypeScript (strict). Design docs: `docs/PLANNING.md` (product/architecture plan) and `docs/SPREADSHEET_REVIEW.md` (the Excel workbook the cost engine replicates, reverse-engineered column by column).

## Commands

```bash
npm install
npm run dev      # local dev server (needs .env.local — see README)
npm run build    # production build; also the de-facto type check
npm run lint     # eslint (flat config, eslint-config-next)
```

There is no test suite. `npm run build` is the main verification step.

Database migrations are plain SQL in `supabase/migrations/`, applied by pasting into the Supabase SQL editor or `supabase db push`. They are numbered and append-only: never edit an already-applied migration — add a new `NNNN_description.sql`.

## Architecture

### The database owns the business logic

Postgres is the source of truth for everything that matters; the UI is a thin layer over it:

- **Cost engine**: all derived numbers (weight, material/labor cost and price, consumables, overhead allocation, profit) are computed in SQL views — `plan_line_item_costs`, `plan_totals`, `plan_priority_totals` in `supabase/migrations/0001_initial_schema.sql`. Saved totals are never computed in TypeScript.
- **`src/lib/costing.ts` is a deliberate client-side mirror** of the `plan_line_item_costs` view so the plan editor (`src/components/plan/PlanWorkspace.tsx`) can show live totals while typing. Any change to the SQL cost math must be mirrored there (and vice versa) — they are verified to produce identical numbers.
- **Approval workflow**: the state machine (draft → submitted → approved/rejected/changes-requested) lives in SQL functions `submit_plan`, `approve_plan`, `reject_plan`, `request_changes`. These own the rules: TBD lines block approval, overhead is required before submit, creators can't approve their own plans, content locks outside draft states (`assert_plan_editable` + guard triggers), and every transition writes to `audit_log`. Server actions just call these RPCs.
- **Roles** (`admin`, `estimator`, `approver`, `viewer`) are enforced by RLS policies, not just the UI. The first user to sign up becomes admin (`handle_new_user`).
- **Approval thresholds are data**, not code (`approval_thresholds` table; default <$25k = 1 approval, $25k–$100k = 2, >$100k = 3).

### Three Supabase clients — pick the right one

- `src/lib/supabase/server.ts` — anon key + user cookies, for Server Components and server actions (RLS applies).
- `src/lib/supabase/client.ts` — browser client for client components.
- `src/lib/supabase/service.ts` — service role, **bypasses RLS**, `import "server-only"`. Used by the QuickBooks sync/OAuth routes — it's the only thing that can touch `qb_connections` (RLS deny-all) and write imported QB data — and by the admin-gated Financials reads (see General ledger below).

### Auth flow

`src/proxy.ts` (Next 16's successor to `middleware.ts`) refreshes the Supabase session on every request and redirects unauthenticated users to `/login`. Public paths are listed in `PUBLIC_PATHS` there. Pages under `src/app/(app)/` additionally call `requireUser()` from `src/lib/auth.ts` to get `{ supabase, user, profile }`.

### Route/mutation conventions

- Authenticated UI lives in the `src/app/(app)/` route group; `/login`, `/eula`, `/privacy` are public.
- Mutations are server actions in a colocated `actions.ts` per route (e.g. `src/app/(app)/plans/actions.ts`), validated with Zod, returning `{ ok: true } | { ok: false; error }`. Postgres `raise exception` messages are stripped to a user-facing string via the shared `fail()` helper pattern.
- File exports (CSV, Excel via `exceljs`) are route handlers under `src/app/api/export/`.

### QuickBooks integration

- `src/lib/quickbooks.ts` — OAuth2 (token exchange/refresh) and all import logic. Route handlers under `src/app/api/qb/` (connect, callback, sync, disconnect).
- **Multi-company**: one connection per QB company (realm); imported rows are tagged with `realm_id` because QB record IDs are only unique within a realm (migration `0003`).
- Actual costs (`job_costs`: Bill/Purchase lines + TimeActivity valued at the internal labor rate) and invoiced revenue (`job_invoices`) are imported per job. The books are audited through 2024-12-31, so each sync **refreshes only the import window (delete + insert scoped to `txn_date >= JOB_COSTS_START_DATE`, currently `2025-01-01`)** in `src/lib/quickbooks.ts` — rows dated earlier are frozen history that persists in Supabase and is never deleted or re-fetched.
- That import window must reach back at least as far as `NO_TXN_CUTOFF` in `src/lib/jobViews.ts` — the "No Transactions" dashboard view depends on it.
- **General ledger**: `syncGeneralLedger` imports the chart of accounts (`gl_accounts`) and every posted ledger line (`gl_lines`) via the QBO GeneralLedger *report* API (quarter-sized windows since `FINANCIALS_START_DATE`, currently `2025-01-01`), so QuickBooks does the double-entry expansion — never reconstruct postings from raw entities. Pre-2025 ledger lines are frozen audited history: migration `0020` marks them `archived`, `gl_line_facts` shows them outside the sync's generation scheme, and `prune_gl_lines` skips them, so syncs can't drop or duplicate them. Amounts are natural-signed (positive increases an account in its normal direction). The Financials page (`src/app/(app)/financials/`) slices them through the `gl_pivot` SQL function (migration `0009`); aggregation stays in Postgres. Cell drill-downs list raw lines via `gl_lines_detail` (migration `0010`), whose dimension CASE expressions must stay in lockstep with `gl_pivot`; shared dimension/scope vocabulary lives in `src/lib/financials.ts`. GL data is admin-only: the Financials pages/export verify the caller with `requireAdmin()` and then read via the service-role client — RLS on `gl_accounts`/`gl_lines`/`gl_sync_state` checks `is_admin()` (migrations `0014`/`0015`) to block direct API access, but its qual makes `gl_pivot`-sized queries blow the statement timeout, so the app's own read path bypasses it after the role check. The Chart of Accounts page (`/financials/accounts`) assigns a user-owned `category` per account (migration `0019` — the sync upsert's column list never touches it), which the expandable Income Statement (`/financials/statement`, assembled by `buildCategoryStatement` in `src/lib/financials.ts`) uses to group Revenue/Expense accounts. The Reconciliation page (`/financials/reconciliation`) verifies the imported ledger ties to QuickBooks: upload the consolidated P&L Excel export (monthly columns) and `src/lib/reconciliation.ts` parses it (`parsePlWorkbook`), truncates it at the last complete month (`omitMonthsAfter` — the in-progress month is omitted across all Financials views and never enters the tie-out), and diffs it account × month against `gl_pivot` cells (`buildReconciliation`) — both sides natural-signed, so amounts compare with no sign flipping. The same intercompany eliminations as the Financials/Income Statement pages (`buildEliminations`) are applied to the GL side below the account tie-out — on the net-income line only, since eliminations are customer-keyed and can't be attributed to accounts — so a consolidated export that nets out intercompany activity ties to "Net income after eliminations". The page action and the Excel export (`/api/export/reconciliation`, a POST that re-uploads the same file) share the file → result pipeline in `src/lib/reconcileServer.ts`.

### Barge Program

New-build deck barge quoting (`src/app/(app)/barge/`) reuses the plan blueprint one-for-one: inputs live in `barge_configs` / `barge_quotes` / `barge_quote_steel_lines` / `barge_quote_labor_phases`, all derived numbers live in the SQL views `barge_quote_steel_line_costs` and `barge_quote_totals` (migration `0017`), and the same draft → submitted → approved workflow runs through `submit_barge_quote` / `approve_barge_quote` / `reject_barge_quote` / `request_barge_quote_changes` — sharing `approval_thresholds` (evaluated against the quote's **sales price**), guard-trigger edit locking, and `audit_log` (`entity_type = 'barge_quote'`). `src/lib/barge.ts` is the deliberate client-side mirror of those views (same contract as `costing.ts`) and also holds the parametric rough-quote model (geometry → plate weight, TSG-calibrated allowance/framing factors) and the two reference takeoff templates. The quote workbench saves content wholesale (header update + delete/re-insert of lines and phases) rather than per-row.

### Jobs dashboard classification

`src/lib/jobViews.ts` buckets every job into exactly one of five views (Customer Jobs, Transportation, Intercompany, Non-Billable, No Transactions). The dashboard tabs (`src/app/(app)/jobs/`) and the Excel workbook export (`src/app/api/export/jobs-workbook/`) must bucket identically, so the rules live only here:

- Job-number suffix `LH`/`HS`/`FL`/`BC` → Transportation; prefix `EQP` → Non-Billable; jobs in the Precision Paint QB company under the `PPS` customer → Non-Billable (internal self-work).
- Sister-company customers (fuzzy name matching in `src/lib/enterprise.ts`) → Intercompany.
- No cost/invoice activity since `NO_TXN_CUTOFF` → No Transactions (US Army Corps of Engineers jobs are exempt and stay under Customer Jobs).

The dashboard's Benefit allocation column (also in the workbook export) comes from the `job_benefit_allocation_totals` view (migration `0021`): per QB company × month it computes the Income Statement's employee-benefits allocation — Employee Benefits × Direct Labor ÷ (Direct Labor + Salaries & Wages), matched via `gl_accounts.category` and account names — and distributes it across that company's jobs pro-rata by direct-labor cost. Its matching/math is a deliberate SQL mirror of `allocateBenefits` in `src/lib/financials.ts` (same lockstep contract as `costing.ts`); the view is intentionally **not** `security_invoker` so it can aggregate the admin-only `gl_lines` while exposing only per-job dollars to all signed-in users.

## Conventions

- Path alias `@/*` → `./src/*`.
- Shared row/domain types are in `src/lib/types.ts`; small shared UI primitives in `src/components/ui.tsx`.
- Env access goes through `src/lib/env.ts` (accepts both `NEXT_PUBLIC_SUPABASE_*` and the Vercel Marketplace add-on's `SUPABASE_*` names). QuickBooks env vars: `QB_CLIENT_ID`, `QB_CLIENT_SECRET`, `QB_ENVIRONMENT` (`production` is the default — sandbox must be explicit), `NEXT_PUBLIC_APP_URL` (OAuth redirect).
- Server-only modules that hold secrets start with `import "server-only"`.
