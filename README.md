# SMW Job Plans

Project plans (job cost estimates) with a multi-step approval workflow, sitting
as a middle layer in front of QuickBooks Online. Customers and jobs are
imported from QuickBooks; plans are estimated, submitted, and approved here.

Built with **Next.js** (Vercel) + **Supabase** (Postgres, Auth, RLS).
Design docs: [`docs/PLANNING.md`](docs/PLANNING.md) and
[`docs/SPREADSHEET_REVIEW.md`](docs/SPREADSHEET_REVIEW.md) (the Excel workbook
this app replaces, reverse-engineered column by column).

## What it does

- **Job cost estimating** that mirrors the shop's estimating engine:
  weight-based steel pricing ($/lb from dimensions), per-each / per-SF /
  lump-sum materials, per-line markup, dual labor rates (internal cost
  $37.15/hr vs billing $102/hr, per-line overrides), consumables as % of labor
  price (default 15%, editable), and a per-job overhead pool allocated
  pro-rata across lines. All derived numbers are computed in SQL views —
  nothing is hand-copied, so totals can never drift.
- **Phases** group line items; **Priority 1/2/3** tiers give scope-tier
  subtotals for quoting.
- **Approval workflow**: draft → submitted → approved / rejected /
  changes-requested. Dollar thresholds decide how many approvals are needed
  (default: <$25k = 1, $25k–$100k = 2, >$100k = 3). Approval is **blocked while
  any TBD line remains**. Overhead is **required** before submit. Creators
  can't approve their own plans. Content locks outside draft states. Every
  transition is audit-logged.
- **QuickBooks Online import** (read-only): customers and jobs/projects,
  via OAuth2, on-demand sync.
- **Roles**: `admin`, `estimator`, `approver`, `viewer` — enforced by
  Postgres row-level security, not just the UI. The **first user to sign up
  becomes admin**.

## Setup

### 1. Supabase (via the Vercel Marketplace add-on)

1. In your Vercel project: **Storage → Create Database → Supabase** (or
   Marketplace → Supabase). This provisions the project and injects the env
   vars into Vercel automatically (`NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, …).
2. Run the migrations in order: open the Supabase dashboard → **SQL Editor** →
   paste and run each file in `supabase/migrations/` in order (`0001_…`, `0002_…`, `0003_…`).
   (Or with the CLI: `supabase db push`.)
3. In Supabase **Authentication → Providers → Email**, decide whether to
   require email confirmation (off = users can sign in immediately).

### 2. QuickBooks Online app

1. Create an app at <https://developer.intuit.com> (type: QuickBooks Online
   and Payments → Accounting scope).
2. Add the redirect URI: `https://<your-domain>/api/qb/callback`.
3. Note the Client ID and Client Secret (use Production keys for your live
   company; Development keys work against the sandbox).

### 3. Vercel environment variables

The Supabase add-on covers the Supabase vars. Add these as well:

| Variable | Value |
|---|---|
| `QB_CLIENT_ID` | from the Intuit developer app |
| `QB_CLIENT_SECRET` | from the Intuit developer app |
| `QB_ENVIRONMENT` | `production` (or `sandbox` while testing) |
| `NEXT_PUBLIC_APP_URL` | `https://<your-domain>` (used for the OAuth redirect) |

### 4. Deploy & bootstrap

1. Push / import this repo into Vercel and deploy.
2. Sign up — the first account becomes **admin**.
3. Settings → **Connect QuickBooks** → authorize → **Sync customers & jobs**.
4. Add teammates; set their roles on the Settings page.

## Local development

```bash
npm install
# .env.local with the same variables as above
npm run dev
```

## Architecture notes

- `supabase/migrations/0001_initial_schema.sql` — the whole data model:
  tables, RLS policies, the cost-engine views (`plan_line_item_costs`,
  `plan_totals`, `plan_priority_totals`), and the workflow functions
  (`submit_plan`, `approve_plan`, `reject_plan`, `request_changes`) that own
  the state machine, TBD gate, and threshold logic.
- `src/lib/costing.ts` — client-side mirror of the SQL engine for live totals
  while editing (verified to produce identical numbers).
- `src/lib/quickbooks.ts` — OAuth2 token exchange/refresh and the
  customer/job import. Tokens live in `qb_connections`, which has RLS
  deny-all: only the service role (server-side API routes) can touch them.
- `src/proxy.ts` — Supabase session refresh + auth redirects.
- Approval thresholds are data (`approval_thresholds` table), not code —
  adjust them in SQL, the app picks them up immediately.
