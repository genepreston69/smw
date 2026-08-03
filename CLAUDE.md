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
- `src/lib/supabase/service.ts` — service role, **bypasses RLS**, `import "server-only"`. Used only by the QuickBooks sync/OAuth routes; it's the only thing that can touch `qb_connections` (RLS deny-all) and write imported QB data.

### Auth flow

`src/proxy.ts` (Next 16's successor to `middleware.ts`) refreshes the Supabase session on every request and redirects unauthenticated users to `/login`. Public paths are listed in `PUBLIC_PATHS` there. Pages under `src/app/(app)/` additionally call `requireUser()` from `src/lib/auth.ts` to get `{ supabase, user, profile }`.

### Route/mutation conventions

- Authenticated UI lives in the `src/app/(app)/` route group; `/login`, `/eula`, `/privacy` are public.
- Mutations are server actions in a colocated `actions.ts` per route (e.g. `src/app/(app)/plans/actions.ts`), validated with Zod, returning `{ ok: true } | { ok: false; error }`. Postgres `raise exception` messages are stripped to a user-facing string via the shared `fail()` helper pattern.
- File exports (CSV, Excel via `exceljs`) are route handlers under `src/app/api/export/`.

### QuickBooks integration

- `src/lib/quickbooks.ts` — OAuth2 (token exchange/refresh) and all import logic. Route handlers under `src/app/api/qb/` (connect, callback, sync, disconnect).
- **Multi-company**: one connection per QB company (realm); imported rows are tagged with `realm_id` because QB record IDs are only unique within a realm (migration `0003`).
- Actual costs (`job_costs`: Bill/Purchase lines + TimeActivity valued at the internal labor rate) and invoiced revenue (`job_invoices`) are imported per job. Each sync **fully refreshes a company's rows (delete + insert)** and only imports transactions on or after `JOB_COSTS_START_DATE` in `src/lib/quickbooks.ts`.
- That import window must reach back at least as far as `NO_TXN_CUTOFF` in `src/lib/jobViews.ts` — the "No Transactions" dashboard view depends on it.
- **General ledger**: `syncGeneralLedger` imports the chart of accounts (`gl_accounts`) and every posted ledger line (`gl_lines`) via the QBO GeneralLedger *report* API (quarter-sized windows since `FINANCIALS_START_DATE`), so QuickBooks does the double-entry expansion — never reconstruct postings from raw entities. Amounts are natural-signed (positive increases an account in its normal direction). The Financials page (`src/app/(app)/financials/`) slices them through the `gl_pivot` SQL function (migration `0009`); aggregation stays in Postgres.

### Jobs dashboard classification

`src/lib/jobViews.ts` buckets every job into exactly one of five views (Customer Jobs, Transportation, Intercompany, Non-Billable, No Transactions). The dashboard tabs (`src/app/(app)/jobs/`) and the Excel workbook export (`src/app/api/export/jobs-workbook/`) must bucket identically, so the rules live only here:

- Job-number suffix `LH`/`HS`/`FL`/`BC` → Transportation; prefix `EQP` → Non-Billable.
- Sister-company customers (fuzzy name matching in `src/lib/enterprise.ts`) → Intercompany.
- No cost/invoice activity since `NO_TXN_CUTOFF` → No Transactions (US Army Corps of Engineers jobs are exempt and stay under Customer Jobs).

## Conventions

- Path alias `@/*` → `./src/*`.
- Shared row/domain types are in `src/lib/types.ts`; small shared UI primitives in `src/components/ui.tsx`.
- Env access goes through `src/lib/env.ts` (accepts both `NEXT_PUBLIC_SUPABASE_*` and the Vercel Marketplace add-on's `SUPABASE_*` names). QuickBooks env vars: `QB_CLIENT_ID`, `QB_CLIENT_SECRET`, `QB_ENVIRONMENT` (`production` is the default — sandbox must be explicit), `NEXT_PUBLIC_APP_URL` (OAuth redirect).
- Server-only modules that hold secrets start with `import "server-only"`.
