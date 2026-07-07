# Project Plan & Approval Platform — Planning Document

> A middle-layer application that sits between your team and QuickBooks. Users build
> **project plans (job cost estimates)**, route them through an **approval workflow**,
> and — once approved — push the results into QuickBooks. Customers and jobs are
> **imported from QuickBooks** so estimates are always tied to real QB records.

- **Backend:** Supabase (Postgres, Auth, Row-Level Security, Storage, Edge Functions)
- **Hosting:** Vercel (Next.js App Router)
- **System of record for accounting:** QuickBooks
- **System of record for planning/approvals:** this application

---

## 1. Goals & Scope

### In scope (v1)
1. Import the **customer list** from QuickBooks.
2. Import **current jobs** from QuickBooks and link them to customers.
3. Create **project plans / job cost estimates** (labor, materials, subcontractor, other line items).
4. Route each plan through a **multi-step approval process** (draft → submitted → approved/rejected).
5. Keep a full **audit trail** (who changed what, when; who approved/rejected and why).
6. **Role-based access** (estimator, approver, admin, viewer).

### Likely v2+ (call out now, build later)
- Push approved estimates **back into QuickBooks** (as an Estimate, Purchase Order, or Budget).
- Actual-vs-estimate cost tracking (pull actuals from QB, compare to the plan).
- Change orders / revisions on an approved plan.
- Reporting dashboards and exports (PDF estimate, CSV).
- Email/Slack notifications on approval-state changes.

### Explicitly out of scope (v1)
- Payroll, invoicing, and payments (stay in QuickBooks).
- Mobile native app (responsive web only).

---

## 2. The Single Most Important Decision: **Which QuickBooks?**

Your wording ("current **jobs**") is QuickBooks **Desktop** terminology
(Customer:Job). QuickBooks **Online (QBO)** calls the same concept **Projects** or
**sub-customers**. This choice drives the entire integration architecture, so it must
be settled first.

| | **QuickBooks Online (QBO)** | **QuickBooks Desktop / Enterprise** |
|---|---|---|
| API | Modern REST API + OAuth 2.0 | QB Web Connector (SOAP/qbXML) or a 3rd-party bridge |
| Cloud-friendly | ✅ Native fit for Vercel + Supabase | ⚠️ Desktop app must be running; needs a connector service |
| "Jobs" | Modeled as Projects / sub-customers | Native Customer:Job |
| Webhooks | ✅ Supported (near-real-time sync) | ❌ Poll-only |
| Recommended for this stack | **✅ Strongly preferred** | Possible but adds a self-hosted sync agent |

**Recommendation:** Target **QuickBooks Online**. It is the only option that cleanly
matches a serverless Vercel + Supabase deployment. If you are on QuickBooks Desktop,
we need a plan for a small always-on sync agent (or a paid connector like Codat /
Rutter) — flagged in the Open Questions section.

> The rest of this document assumes **QBO** unless noted. If it turns out to be
> Desktop, the data model below is unchanged — only Section 5 (Sync) changes.

---

## 3. High-Level Architecture

```
┌─────────────┐     HTTPS      ┌──────────────────────┐
│   Browser   │ ─────────────► │  Next.js on Vercel   │
│ (React UI)  │ ◄───────────── │  - App Router pages  │
└─────────────┘                │  - Route handlers    │
                               │  - Server Actions    │
                               └──────┬─────────┬──────┘
                                      │         │
                        Supabase JS   │         │  QBO REST + OAuth2
                        (RLS-scoped)   ▼         ▼
                     ┌───────────────────┐   ┌───────────────────┐
                     │     Supabase      │   │   QuickBooks API   │
                     │  - Postgres + RLS │   │  (customers, jobs, │
                     │  - Auth           │   │   estimates)       │
                     │  - Storage        │   └─────────┬─────────┘
                     │  - Edge Functions │◄────────────┘
                     └───────────────────┘   webhooks / scheduled sync
```

- **Vercel / Next.js** — UI, server actions, and OAuth callback handling. Never expose
  QB tokens to the browser.
- **Supabase Postgres** — all app data + a mirror of imported QB customers/jobs.
- **Supabase Edge Functions (or Vercel Cron)** — scheduled + webhook-driven sync jobs.
- **Supabase Auth** — user identity and sessions; RLS enforces per-role/per-record access.

---

## 4. Data Model (Postgres)

Core tables. All tables get `id uuid pk`, `created_at`, `updated_at`, and (where
relevant) `created_by`. Multi-tenant fields (`org_id`) included so the app can support
more than one company later.

```
organizations
  id, name, qb_realm_id (company id), ...

qb_connections                         -- one QB company per org
  id, org_id, realm_id,
  access_token (encrypted), refresh_token (encrypted),
  token_expires_at, connected_by, status

customers                              -- mirror of QB customers
  id, org_id, qb_id, display_name, email, phone,
  billing_address (jsonb), active, last_synced_at

jobs                                   -- mirror of QB jobs/projects
  id, org_id, qb_id, customer_id (fk),
  name, status, start_date, last_synced_at

project_plans                          -- the core "job cost estimate"
  id, org_id, job_id (fk), customer_id (fk),
  title, description,
  status,                              -- draft | submitted | in_review | approved | rejected | changes_requested
  version, total_cost (computed/cached),
  created_by, current_approver_id

plan_line_items
  id, plan_id (fk),
  category,                            -- labor | material | subcontractor | equipment | other
  description, quantity, unit, unit_cost,
  markup_pct, line_total (computed), sort_order

approvals                              -- one row per approval step/action
  id, plan_id (fk), approver_id,
  step_order, decision,                -- pending | approved | rejected | changes_requested
  comment, decided_at

approval_workflows / approval_steps    -- (optional) configurable multi-step routing
  defines who must approve, in what order, and thresholds (e.g. > $50k needs 2 approvals)

audit_log
  id, org_id, entity_type, entity_id, action,
  actor_id, diff (jsonb), created_at

user_roles
  user_id, org_id, role                -- estimator | approver | admin | viewer
```

**Key relationships**
- A `customer` has many `jobs`; a `job` has many `project_plans`.
- A `project_plan` has many `plan_line_items` and many `approvals`.
- `qb_id` on `customers`/`jobs` is the join key back to QuickBooks (unique per org).

---

## 5. QuickBooks Sync Design

### 5.1 Connecting (OAuth 2.0, QBO)
1. Admin clicks **Connect QuickBooks** → redirect to Intuit OAuth consent.
2. Intuit redirects back to a Next.js route handler (`/api/qb/callback`).
3. Exchange the auth code for **access + refresh tokens** and the **realmId**.
4. Store tokens **encrypted** in `qb_connections` (server-side only — pgsodium /
   Supabase Vault, or app-level encryption). Never send them to the client.
5. Access tokens expire in ~1 hour; **refresh tokens** rotate — a scheduled job
   refreshes before expiry and persists the new pair.

### 5.2 Importing customers & jobs
- **Initial import:** paginated pull of all active customers, then all
  jobs/projects/sub-customers; upsert into `customers` / `jobs` keyed on `qb_id`.
- **Ongoing sync (choose one):**
  - **Webhooks (preferred, QBO):** Intuit notifies on Customer changes → enqueue a
    targeted re-fetch. Near-real-time, low quota use.
  - **Scheduled poll:** Vercel Cron or a Supabase scheduled Edge Function runs every
    N minutes and pulls records changed since `last_synced_at`.
- **Direction:** v1 is **read-only from QB → app** for customers/jobs. The app never
  edits QB customers/jobs in v1.

### 5.3 Pushing plans back to QB (v2)
Decide the mapping once you're ready: an approved `project_plan` most naturally becomes
a QB **Estimate** (with line items) or a **Budget**. Push is one-way (app → QB) and only
after final approval, to keep QuickBooks as the accounting system of record.

### 5.4 Guardrails
- Respect Intuit **rate limits** (throttle + backoff on 429).
- **Idempotent upserts** on `qb_id` so retries don't duplicate.
- Store `last_synced_at` and a `sync_status` per record for observability.
- Log every sync run to `audit_log` for debugging.

---

## 6. Approval Workflow

State machine for `project_plans.status`:

```
        submit                approve
draft ─────────► submitted ─────────────► approved ──(v2)──► pushed to QB
  ▲                 │  ▲                       
  │  changes_       │  │ request changes       
  └── requested ◄───┘  │                       
                       │ reject                
                       ▼                       
                    rejected                   
```

- **draft** — estimator builds line items; freely editable.
- **submitted / in_review** — locked for editing; visible to the assigned approver(s).
- **approved** — final; read-only; eligible for QB push (v2).
- **rejected** — terminal unless cloned into a new revision.
- **changes_requested** — returns to the estimator, who edits and resubmits (increment `version`).

**Configurable routing (optional but recommended):** approval thresholds by dollar
amount (e.g. plans over $50k require a second approver). Model via
`approval_workflows` / `approval_steps` so rules change without code deploys.

Every transition writes an `approvals` row and an `audit_log` entry.

---

## 7. Authentication, Roles & Security

- **Supabase Auth** for user login (email/password + optionally Google/Microsoft SSO).
- **Roles** (`user_roles`): `admin`, `estimator`, `approver`, `viewer`.
  - *estimator* — create/edit own drafts, submit.
  - *approver* — view submitted plans, approve/reject/request changes.
  - *admin* — manage users, QB connection, workflow config, all records.
  - *viewer* — read-only.
- **Row-Level Security (RLS)** on every table, scoped by `org_id` and role. This is the
  primary access-control mechanism — enforce it in the database, not just the UI.
- **Secrets:** QB tokens and client secret stored server-side only (Supabase Vault /
  env vars). OAuth callback and all QB calls run server-side (route handlers / Edge
  Functions), never in the browser.
- **Audit:** immutable `audit_log` for all state changes and approvals.

---

## 8. Tech Stack & Repo Layout

| Concern | Choice |
|---|---|
| Framework | Next.js (App Router) + TypeScript |
| UI | React, Tailwind CSS, shadcn/ui (recommended) |
| Data/Auth | `@supabase/supabase-js` + `@supabase/ssr` |
| DB migrations | Supabase CLI migrations (SQL in `supabase/migrations`) |
| Background sync | Supabase Edge Functions + Vercel Cron |
| QB SDK | `intuit-oauth` + `node-quickbooks` (or direct REST calls) |
| Validation | Zod |
| Hosting | Vercel (app) + Supabase (managed Postgres) |

```
/app                 Next.js routes (pages, server actions, /api handlers)
/components          React UI
/lib
  /supabase          client/server Supabase helpers
  /quickbooks        OAuth + API client, mappers
/supabase
  /migrations        SQL schema + RLS policies
  /functions         Edge Functions (sync, token refresh, webhooks)
/docs                this planning doc, ADRs
```

---

## 9. Delivery Roadmap (phased)

**Phase 0 — Foundations (setup)**
- Create Supabase project + Vercel project; wire env vars.
- Scaffold Next.js app, auth, base layout, roles + RLS skeleton.

**Phase 1 — QuickBooks connection & import**
- OAuth connect flow; encrypted token storage + refresh job.
- Import customers and jobs; list/detail UI; scheduled/webhook sync.

**Phase 2 — Project plans (job costing)**
- Create/edit plans with line items and live cost totals, linked to a job.
- Draft management, versioning.

**Phase 3 — Approval workflow**
- Submit → review → approve/reject/request-changes state machine.
- Approver queue, comments, audit trail. (Optional: threshold-based routing.)

**Phase 4 — Polish**
- Notifications, PDF export, dashboards, permissions hardening.

**Phase 5 (v2) — Push to QuickBooks**
- Map approved plans to QB Estimates/Budgets; one-way push after approval.

---

## 10. Open Questions / Decisions

**Decided 2026-07-07:**

1. ~~QuickBooks Online or Desktop?~~ → **QuickBooks Online.** The webhook + OAuth2 sync design in §5 applies as written.
2. ~~How many companies (QB realms)?~~ → **One enterprise** (single QB realm). Keep `org_id` columns for future-proofing but build single-tenant.
3. ~~What does an approved plan become in QB?~~ → **Nothing for now — plans stay app-only.** Phase 5 (push to QB) is deferred indefinitely.
4. ~~Approval routing rules?~~ → **Dollar thresholds with multiple approvers** (multi-step). See `SPREADSHEET_REVIEW.md` §6.5 for the proposed threshold table.
5. ~~Line-item categories / markup model?~~ → Defined by the current Excel workbook (see `SPREADSHEET_REVIEW.md`): weight-based steel, per-each, per-SF, and lump-sum material lines; per-line material markup; labor cost rate vs billing rate; consumables as % of labor price; job-level overhead pool allocated pro-rata; Priority 1/2/3 scope tiers; phase grouping.

**Also decided 2026-07-07 (second round):** consumables % editable per plan with 15% default; overhead pool manual entry and required; approval blocked while TBD lines remain; labor cost rate editable per plan with 37.15 default. Details in `SPREADSHEET_REVIEW.md` §6.1/§6.4/§8.

**Still open:**

6. **User count & roles** — how many users, and who approves?
7. **Actual-vs-estimate tracking** (pulling actual costs back from QB) — in the roadmap, or is estimating enough?
8. Approval threshold amounts (`SPREADSHEET_REVIEW.md` §6.5) — proceeding with the proposed tiers as admin-editable config until told otherwise.

---

*Next step: answer the remaining items above, then this becomes a concrete schema
(SQL migrations) + a scaffolded Next.js/Supabase repo. The line-item schema is
already drafted in `SPREADSHEET_REVIEW.md` §6.*
