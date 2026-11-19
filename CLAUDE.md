# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## What this app is

SMW Job Plans: job cost estimating with a multi-step approval workflow, sitting as a middle layer in front of QuickBooks Online. Customers, jobs, actual costs, invoices and the general ledger are imported from QuickBooks (read-only); plans and barge quotes are estimated, submitted, and approved here, and the financial reports (income statement, balance sheet, budget, capitalized jobs, cost of benefits) are built on the imported ledger. Stack: Next.js 16 (App Router, deployed on Vercel) + Supabase (Postgres, Auth, RLS) + Tailwind CSS 4 + TypeScript (strict).

## How these docs are organized

This file holds only what applies everywhere. **Each area of the app has its own page under `docs/areas/` — read the page for the area you are about to change before changing it, and update it in the same change when behavior moves.**

| Area | Page |
|---|---|
| QuickBooks import, nightly sync, sync health | `docs/areas/quickbooks-sync.md` |
| General ledger import; Financials pivot, Income Statement, Balance Sheet, Ratios, Chart of Accounts, Reconciliation | `docs/areas/general-ledger.md` |
| Budget | `docs/areas/budget.md` |
| Cost of Benefits | `docs/areas/cost-of-benefits.md` |
| Barge Program | `docs/areas/barge.md` |
| Capitalized Jobs, Already Capitalized | `docs/areas/capitalized.md` |
| Jobs dashboard views, benefit allocation column | `docs/areas/jobs.md` |

Background: `docs/PLANNING.md` (product/architecture plan) and `docs/SPREADSHEET_REVIEW.md` (the Excel workbook the plan cost engine replicates).

## Commands

```bash
npm install
npm run dev        # local dev server (needs .env.local — see README)
npm run lint       # eslint (flat config, eslint-config-next)
npm run typecheck  # tsc --noEmit
npm test           # vitest: unit tests, plus database tests when TEST_DATABASE_URL is set
npm run build      # production build
```

CI (`.github/workflows/ci.yml`) runs all four checks on every pull request, with the database tests against a Postgres service. Run them before pushing. See `tests/README.md`.

## Architecture

### The database owns the business logic

Postgres is the source of truth for everything that matters; the UI is a thin layer over it.

- **Cost engine**: all derived plan numbers are computed in SQL views — `plan_line_item_costs`, `plan_totals`, `plan_priority_totals` (migration `0001`). Saved totals are never computed in TypeScript.
- **Client-side mirrors**: `src/lib/costing.ts` mirrors `plan_line_item_costs` so the plan editor (`src/components/plan/PlanWizard.tsx`) can show live totals; `src/lib/barge.ts` mirrors the barge views the same way. Any change to the SQL math must be made in the mirror too, and vice versa — `tests/db/costMirror.test.ts` runs the same inputs through both and fails if a single figure differs.
- **Approval workflow**: the state machine (draft → submitted → approved / rejected / changes-requested) lives in SQL functions (`submit_plan`, `approve_plan`, `reject_plan`, `request_changes`, and the barge equivalents). They own the rules: TBD lines block approval, overhead is required before submit, creators can't approve their own work, content locks outside draft states (guard triggers), and every transition writes to `audit_log`. Server actions just call these RPCs.
- **Roles** (`admin`, `estimator`, `approver`, `viewer`) are enforced by RLS policies, not just the UI. The first user to sign up becomes admin (`handle_new_user`).
- **Approval thresholds are data** (`approval_thresholds`; default <$25k = 1 approval, $25k–$100k = 2, >$100k = 3).
- **New functions need their own grants**: Postgres grants execute to everyone by default, so a new function gets an explicit `revoke … from public, anon` (and from `authenticated` unless it runs as the caller under RLS). `write_audit` is executable by no API role (migration `0038`).

### Three Supabase clients — pick the right one

- `src/lib/supabase/server.ts` — anon key + user cookies, for Server Components and server actions (RLS applies).
- `src/lib/supabase/client.ts` — browser client for client components.
- `src/lib/supabase/service.ts` — service role, **bypasses RLS**, `import "server-only"`. Used by the QuickBooks sync/OAuth routes and by the admin-only ledger reads. **Every use must sit behind an admin check** (`requireAdmin()` on pages, the role check in routes): the ledger tables' admin RLS is too slow for app-sized reads, so the app's own read path bypasses it after verifying the caller.

### Auth flow

`src/proxy.ts` (Next 16's successor to `middleware.ts`) refreshes the Supabase session on every request and redirects unauthenticated users to `/login`; public paths are listed in `PUBLIC_PATHS` there. Pages under `src/app/(app)/` additionally call `requireUser()` / `requireAdmin()` from `src/lib/auth.ts`.

### Routes and mutations

- Authenticated UI lives in the `src/app/(app)/` route group; `/login`, `/eula`, `/privacy` are public.
- Mutations are server actions in a colocated `actions.ts` per route, validated with Zod, returning `{ ok: true } | { ok: false; error }`.
- A save that replaces a set of rows goes through one SQL function so it is all-or-nothing (e.g. `replace_barge_quote_content`, `replace_budget_initiative_lines`, `save_budget_assumptions`) — never a delete followed by inserts as separate requests.
- File exports (CSV, Excel via `exceljs`) are route handlers under `src/app/api/export/`. **A page and its export share one loader and one param parser**, so the file always matches the screen; follow that pattern for anything new.

### Business rules: settings vs. code

- **Settings** (`public.app_settings`, migration `0041`; edited by admins under Settings → Business rules): the budget year, the Cost of Benefits base accounts, the sister-company list, and the Income Statement's EBITDA add-back accounts. `src/lib/appSettings.ts` owns the keys, shapes, validation and defaults (a setting with no row uses its default); `loadAppSettings` in `src/lib/appSettingsServer.ts` reads them. Code that depends on one takes it as an argument — never import a constant for these.
- **Code on purpose** (`src/lib/businessRules.ts`): the import-window and freeze dates. Moving one hides or deletes imported history, so it stays a reviewed code change; the file explains each constraint and the tests check them.
- A new rule the business will want to change on its own schedule belongs in settings: add a key and schema to `appSettings.ts`, a field to `BusinessRulesForm`, and thread it through as an argument.

### Migrations

- Plain SQL in `supabase/migrations/`, applied by pasting into the Supabase SQL editor. Numbered and append-only: never edit an applied migration; add a new `NNNN_description.sql` with the next unused number. (Two old files share `0024`; refer to them by full file name.)
- **Every new migration ends with** `insert into public.schema_migrations (filename) values ('NNNN_description.sql') on conflict do nothing;` **and is added to `EXPECTED_MIGRATIONS` in `src/lib/schemaVersion.ts`.** `tests/migrations.test.ts` fails if either is missed.
- `schema_migrations` (migration `0040`) is how the app knows the database is behind the code: `loadSchemaStatus` compares it with `EXPECTED_MIGRATIONS`, admins see a banner on every page, and Settings → Database version lists what is missing.
- Code can reach production before its migration is applied. Make new code fail safe in that window — fall back (as `loadPivotCells` and `loadAppSettings` do) or return a message that names the migration — and say in the pull request that a migration must be applied.
- Write migrations so re-running them is harmless (`create or replace`, `if not exists`, `drop … if exists`).

### Reading data

- A failed Supabase query resolves with `{ data: null, error }` instead of throwing, so code that reads only `data` shows an outage as empty data. Pass each query's `error` to `throwIfError` (`src/lib/supabase/throwIfError.ts`). The thrown error renders `src/app/(app)/error.tsx` inside the app shell (`loading.tsx` and `not-found.tsx` sit beside it; `src/app/error.tsx` covers the shell itself). The deliberate exceptions are role checks in API routes, which fail closed (403).
- The API silently caps any query at 1000 rows. Lists that must be complete page through `fetchAllRows` (`src/lib/supabase/fetchAll.ts`, which also throws on error) with a deterministic `.order()`.
- Ledger reads must be scoped to the org and a date window so `gl_lines_date_idx` can range-scan, and should return one JSON value rather than paged rows — see `docs/areas/general-ledger.md`.
- In this Next version the error boundary's retry prop is `unstable_retry`.

## Conventions

- Path alias `@/*` → `./src/*`.
- Shared row/domain types are in `src/lib/types.ts`; small shared UI primitives in `src/components/ui.tsx`.
- Pure logic goes in `src/lib/<area>.ts` (client-safe, unit-tested); its database reads go in `src/lib/<area>Server.ts`, which starts with `import "server-only"`.
- Env access goes through `src/lib/env.ts` (accepts both `NEXT_PUBLIC_SUPABASE_*` and the Vercel Marketplace add-on's `SUPABASE_*` names). QuickBooks env vars: `QB_CLIENT_ID`, `QB_CLIENT_SECRET`, `QB_ENVIRONMENT` (`production` is the default — sandbox must be explicit), `NEXT_PUBLIC_APP_URL` (OAuth redirect). The README lists the rest.
- Financial reports show the ledger as booked so they tie to QuickBooks: no eliminations, no allocations between categories.
- New behavior with a rule worth protecting gets a test in `tests/`; a change to SQL the app depends on gets a database test in `tests/db/`.
