# Review: Current Excel Job Plan (`Caroline COI 626 Repair 05.26.26.xlsx`)

Detailed review of the estimating workbook currently in use (Superior Marine —
marine repair / dry dock work). This document reverse-engineers the costing
engine, records every formula and parameter, flags the problems the spreadsheet
has today, and maps everything onto the application's data model.

---

## 1. Workbook structure

| Sheet | Purpose | State |
|---|---|---|
| **Job Plan** | The estimating engine: ~90 line-item rows grouped into phases, 30 columns of inputs + computed costs/prices, totals row, priority buckets | Active, core |
| **Summary** | Internal cover document: company letterhead, customer/PM/dates, profitability breakdown, phase table, finance sign-off line | Active, partially manual |
| **hours** | Empty | Unused |

Header row (Job Plan row 1): Project Name, Customer, Date, Contact, Phone,
Email — plus **Priority 1 / 2 / 3** bucket headers (see §4).

---

## 2. The costing engine (Job Plan sheet)

### 2.1 Global parameters (row 4)

| Cell | Value | Meaning |
|---|---|---|
| `P4` | **37.15** | Internal labor **cost** rate ($/hr) — what an hour costs the company |
| `Q` (per line) | **102** (default) | Labor **billing** rate ($/hr); overridden per line (e.g. crane time = **310**) |
| `S4` | **0.15** | Consumables factor — 15% |
| `T4` | **5,000** | Total **overhead pool** for the job, allocated across lines |

### 2.2 Per-line columns & formulas

| Col | Header | Formula / meaning |
|---|---|---|
| A | Phase | Group label (only on the first row of each phase group) |
| B | Date | Mostly unused |
| C | events | Number of events/visits/days |
| D | HRs/PC | Hours per piece per event |
| E | QTY | Quantity |
| F | Description | Free text; uncertain items marked with `???` |
| G | LGTH / SF(ea) | Length or square footage per piece |
| H | TL/LTH | Total length — usually typed = G; two rows use `=G*E` (the intended formula) |
| I | WT/LF | Steel weight per linear foot |
| J | Weight Est | `= I × H` |
| K | Cost per Lbs/SF/Ea | Unit cost ($0.70/lb steel plate, $0.75/lb round bar, or $/each) |
| L | Material Cost | `= K × J` for weight-based rows; **typed directly** for lump sums ($12,000 pump truck) and per-each rows (`K × QTY`) |
| M | Material Mark Up | Fraction (0.3 = 30%); Dry Docking uses **6** (= 600%) |
| N | Material Price | `= L × (1 + M)` |
| O | Total HRS | `= D × E × C` (hrs/piece × qty × events) |
| P | Labor Cost | `= $P$4 × O` (37.15/hr) |
| Q | Labor Rate | Billing rate, per line (102 default; 310 crane) |
| R | Labor Price | `= Q × O` |
| S | Consumables | `= 0.15 × R` — **15% of labor *price***, added to both cost and price (no markup on consumables) |
| T | Overhead | `= (P + L) / (P95 + L95) × T4` — pro-rata share of the $5,000 pool, weighted by the line's labor+material **cost** |
| U | Cost | `= P + L + S + T` |
| V | Price | `= R + N + S + T` |
| W | Profit | `= V − U` |
| X | Profit % | `= W / V` (share of price) |
| Y–AD | Priority 1/2/3 Cost & Price | **Manually copied** values from U/V per line — see §4 |

### 2.3 Totals (row 95) and job numbers

- Total hours **1,728** · Labor cost **$64,195** · Labor price **$176,880**
- Material cost **$117,936** · Material price **$156,066**
- Consumables **$26,532** · Overhead **$5,000**
- **Total cost $213,663 · Total price $364,478 · Profit $150,815 (41.4%)**

### 2.4 Business rules worth preserving

1. **Two labor rates** — internal cost rate (37.15) vs. billing rate (102/310).
   Labor gross margin ≈ 63.6% at the default rate.
2. **Weight-based steel pricing** — dimensions → weight (lbs) → $/lb. This is
   the estimator's native workflow for hull steel and must be first-class in
   the app, not squeezed into a generic qty × unit-price line.
3. **Consumables as a % of labor price** — pass-through (same value on cost and
   price side).
4. **Overhead as a job-level pool allocated pro-rata** over each line's
   labor+material cost.
5. **Per-line billing-rate overrides** (crane time at $310/hr).
6. **Phases** group lines (Docking, Gas Free, Bow Void, Paint, FAB Prep,
   Gensets, …) — they mirror how the yard actually sequences work.

---

## 3. Summary sheet

Company letterhead (name/address/phone), then:

- Customer / Project Manager (linked from Job Plan header), Project Name
  ("Caroline"), Department ("Dock String"), Start 5/26/2026 → End 7/15/2026.
- **Profitability Break Down** — material/labor/consumables/overhead, cost vs
  price, labor hours, total profit and profit %.
- Payment terms, notes ("If any additional costs arise during build I will
  inform before moving forward.").
- **"Received by Finance Dept on: ____"** — today's manual approval step, and
  exactly what the app's approval workflow replaces.
- A Phase # / Phase Name / Labor / Materials / Total table (rows 37–54) that is
  wired up but **empty** — the phase-level rollup was wanted but never
  maintained by hand. The app gets this for free.

---

## 4. The Priority 1/2/3 mechanism

Each line's Cost/Price is hand-copied into one of three column pairs:
Priority 1 (Y/Z), Priority 2 (AA/AB), Priority 3 (AC/AD). Rows 97–98 total
them. This lets the yard quote the customer **scope tiers** (must-do now /
should-do / defer). It is the most fragile part of the workbook — see §5.

---

## 5. Problems found in the current workbook

These are the concrete failure modes the application eliminates:

1. **Broken formulas**: `D95`, `E95`, `J95` are `=SUM(#REF!)` — the totals for
   hrs/pc, qty, and weight are dead (rows were deleted at some point).
2. **Priority buckets drift from the engine.** The priority totals
   (cost **$213,902** / price **$364,818**, rows 97–98) do **not** equal the
   engine totals (**$213,663 / $364,478**) — off by ~$239 / ~$339, because the
   Y–AD values are manual copies that go stale when an input changes.
3. **Priority 3 columns are misaligned by rows.** E.g. the Genset numbers
   (~$92,589 / $119,589) sit on row 76 ("Strb Gen RR") instead of row 74
   ("Genset Replacement") — copy/paste shifted the block.
4. **Summary sheet mixes scopes and contains stale hand-typed numbers:**
   - "Total cost $86,639.65 / Total price $175,915" = **Priority 1 only**
     (equals Y95/Z95 exactly) — while "Overhead $5,000" pulls the whole-job
     `T95`. The summary silently reports a different scope than the job total.
   - "Total Profit **$89,639.65**" — arithmetic says 175,915 − 86,639.65 =
     **$89,275.35**. The typed value looks like a digit-slip of the cost figure.
   - "Profit % **0.28**" is hard-typed; the actual figure is ~50.7% of price.
5. **Formula overrides break rows**: row 90 has Material Price hard-typed to 0
   over the formula → the line shows **negative profit (−$77)** and a nonsense
   hard-typed profit % (−36.43). Row 88's weight formula is also pasted over.
6. **Inconsistent material-cost semantics** in column L: `K×J` (weight), `K×E`
   (per each), or a typed lump sum — same column, three meanings, no indicator.
7. **`???` markers** on unresolved items (GPS, fire system, Cooper windows,
   tow-knee handrails) have no workflow — nothing prevents submitting a plan
   full of unknowns.
8. **Ambiguous markup units**: header says `%`, values are fractions (0.3), and
   Dry Docking uses `6` (600%). Easy to fat-finger 30 instead of 0.3.
9. **No versioning, no audit trail, no lock after approval** — anyone can edit
   any cell at any time, including after finance sign-off.
10. Data hygiene: trailing spaces in every label, dates unused in column B,
    empty "hours" sheet.

None of these are criticisms of the estimator — they are exactly the failure
modes spreadsheets always develop at this complexity. They're the business
case for the app.

---

## 6. Mapping to the application data model

### 6.1 Plan-level parameters (`project_plans` gains a params block)

| Spreadsheet | App field | Behavior (decided) |
|---|---|---|
| `P4` labor cost rate | `labor_cost_rate` | Editable per plan, **defaults to 37.15** |
| `Q` default | `default_labor_bill_rate` | Editable per plan, defaults to 102.00; per-line override |
| `S4` | `consumables_pct` | **User-editable per plan, defaults to 15%** |
| `T4` | `overhead_pool` | **Manual entry, required** — a plan cannot be submitted without an overhead amount (0 is allowed but must be explicit) |
| Summary: start/end, department, PM, payment terms, notes | same-named plan fields | — |

### 6.2 Phases become a table

```
plan_phases
  id, plan_id (fk), name, sort_order
```

Replaces the column-A group labels; gives the Summary's phase rollup for free.

### 6.3 Line items (revised `plan_line_items`)

```
plan_line_items
  id, plan_id (fk), phase_id (fk), sort_order
  description        text
  priority           smallint      -- 1 | 2 | 3  (replaces columns Y–AD)
  is_tbd             boolean       -- replaces the '???' markers
  -- labor inputs
  events             numeric       -- col C
  hours_per_piece    numeric       -- col D
  quantity           numeric       -- col E
  labor_bill_rate    numeric       -- col Q (null → plan default)
  -- material inputs
  material_basis     text          -- 'per_lb' | 'per_each' | 'per_sf' | 'lump_sum'  (fixes §5.6)
  length_per_piece   numeric       -- col G
  weight_per_lf      numeric       -- col I
  unit_cost          numeric       -- col K
  lump_sum_cost      numeric       -- direct entry when basis = lump_sum
  material_markup_pct numeric      -- col M, stored as fraction, UI shows %
```

**Everything else is computed, never stored as user input** (generated columns
or a SQL view), exactly matching the engine:

```
total_length    = length_per_piece × quantity                    (col H, done right)
weight_est      = weight_per_lf × total_length                   (col J)
material_cost   = CASE basis: per_lb→unit_cost×weight_est | per_each→unit_cost×quantity
                              | per_sf→unit_cost×total_length | lump_sum→lump_sum_cost   (col L)
material_price  = material_cost × (1 + markup)                   (col N)
total_hours     = hours_per_piece × quantity × events            (col O)
labor_cost      = plan.labor_cost_rate × total_hours             (col P)
labor_price     = bill_rate × total_hours                        (col R)
consumables     = plan.consumables_pct × labor_price             (col S)
overhead_alloc  = (labor_cost + material_cost) / Σ(labor_cost + material_cost) × plan.overhead_pool  (col T)
line_cost       = labor_cost + material_cost + consumables + overhead_alloc   (col U)
line_price      = labor_price + material_price + consumables + overhead_alloc (col V)
profit / profit_pct derived                                     (cols W, X)
```

Because these are computed in one place, **§5 problems 1–5 become impossible**:
priority totals are a `GROUP BY priority`, the summary is generated from the
same rows it summarizes, and there are no hand-copied cells to drift.

### 6.4 Rules the app should add on top

- **Rounding**: store full precision, round only at display/PDF (the sheet's
  cent-rounding of the priority copies is one source of its drift).
- **TBD gate (decided)**: a plan with `is_tbd` lines can be saved and
  submitted for early visibility, but **approval is blocked while any TBD
  line remains** — every `???` must be resolved (priced or removed) before an
  approver can approve. Approvers see the TBD list and can still reject or
  request changes.
- **Markup entry in percent** in the UI ("30" → 0.30) with sanity warning above
  e.g. 200% (Dry Docking's 600% stays possible, just confirmed).
- **Lock on submit/approve** — line items become read-only outside `draft` /
  `changes_requested`; edits after approval require a new version.
- **Priority-tier quoting**: plan totals and the customer-facing PDF break out
  Priority 1/2/3 subtotals, replacing rows 97–98.

### 6.5 Approval thresholds (decision: dollar thresholds, multiple approvers)

The workflow engine keys off **`line_price` total** (the $364k number).
Suggested starting config (admin-editable, stored in `approval_steps`):

| Plan total price | Required approvals |
|---|---|
| < $25k | 1 approver |
| $25k – $100k | 2 approvers (sequential) |
| > $100k | 2 approvers + finance/owner sign-off |

(The Caroline job at ~$364k would take the full chain.) Thresholds evaluated at
submit time and re-evaluated on resubmit if the total changed.

### 6.6 Reports to generate (replacing the Summary sheet)

1. **Internal Job Plan Summary** (PDF) — letterhead, customer/PM/dates,
   profitability breakdown (cost vs price for material/labor/consumables/
   overhead), phase rollup, priority rollup, approval history (who/when) in
   place of "Received by Finance Dept on: ___".
2. **Customer-facing quote** (later phase) — prices only, by priority tier, no
   cost/margin columns.

---

## 7. Decisions locked in (2026-07-07)

| Question | Decision |
|---|---|
| QuickBooks edition | **QuickBooks Online** |
| Tenancy | **Single enterprise** (one QB realm; keep `org_id` columns for future-proofing, hardcode one org) |
| Push back to QB | **No — app-only for now** (plans live and finish in the app) |
| Approval routing | **Dollar thresholds with multiple approvers** (§6.5) |

## 8. Open items from this review

**Decided 2026-07-07:**

1. ~~Consumables base~~ → **Percentage is user-editable per plan, default 15%**
   (base stays labor price, matching the current sheet).
2. ~~Overhead pool~~ → **Manual entry per plan, required field.**
4. ~~TBD gate~~ → **Approval is blocked while TBD lines remain.**
5. ~~Labor cost rate~~ → **Single rate, editable per plan, defaults to 37.15.**

**Still open:**

3. Confirm the threshold table in §6.5 (amounts and number of approvers) —
   proceeding with the proposed tiers as admin-editable configuration until
   told otherwise.
