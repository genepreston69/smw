import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ClipboardCheck,
  HelpCircle,
  MessageSquareWarning,
  Ship,
  Settings2,
  Wrench,
  X,
} from "lucide-react";
import { requireUser } from "@/lib/auth";
import { PrintButton } from "@/components/PrintButton";
import { buttonCls } from "@/components/ui";

export const metadata = {
  title: "Job Plan Wizard — User Manual",
};

/* ---------------------------------------------------------------------------
   Printable user manual for the job plan wizard. Static content — the
   authoritative behavior lives in the wizard (PlanWizard.tsx), the cost
   engine (lib/costing.ts + plan_line_item_costs view), and the workflow
   functions in supabase/migrations. Keep this page in sync when those change.
--------------------------------------------------------------------------- */

const TOC = [
  ["overview", "1. What a job plan is"],
  ["roles", "2. Roles & permissions"],
  ["create", "3. Creating a plan"],
  ["navigate", "4. Finding your way around the wizard"],
  ["step-project", "5. Step 1 — Project"],
  ["step-rates", "6. Step 2 — Rates & pools"],
  ["step-scope", "7. Step 3 — Scope of work"],
  ["math", "8. How every number is calculated"],
  ["example", "9. A fully worked example"],
  ["step-review", "10. Step 4 — Review & submit"],
  ["workflow", "11. The approval workflow"],
  ["export", "12. Exporting & printing a plan"],
  ["delete", "13. Deleting plans"],
  ["faq", "14. Troubleshooting & FAQ"],
] as const;

export default async function WizardManualPage() {
  await requireUser();

  return (
    <div className="mx-auto max-w-3xl">
      {/* Header + actions (hidden when printing) */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href="/plans" className={buttonCls("secondary")}>
          <ArrowLeft size={16} strokeWidth={2} />
          Back to Job Plans
        </Link>
        <PrintButton />
      </div>

      <article className="rounded-xl border border-line bg-white p-8 shadow-[0_1px_2px_rgba(13,36,56,0.05)] print:rounded-none print:border-0 print:p-0 print:shadow-none">
        {/* Title block */}
        <header className="mb-8 border-b border-line pb-6">
          <p className="text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-brand-600">
            SMW Job Plans — User Manual
          </p>
          <h1 className="mt-1 text-[1.8rem] font-semibold tracking-tight text-ink-900">
            How to use the Job Plan Wizard
          </h1>
          <p className="mt-2 text-sm text-ink-600">
            A complete guide to building a cost estimate, pricing the work,
            and moving it through approval — from a blank plan to an approved
            price. Print this page or save it as a PDF with the{" "}
            <em>Print / Save PDF</em> button (or <Kbd>Ctrl</Kbd>+<Kbd>P</Kbd> /{" "}
            <Kbd>⌘</Kbd>+<Kbd>P</Kbd>).
          </p>
        </header>

        {/* Table of contents */}
        <nav aria-label="Contents" className="mb-10">
          <h2 className="text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
            Contents
          </h2>
          <ol className="mt-2 grid grid-cols-1 gap-x-8 gap-y-1 text-sm sm:grid-cols-2">
            {TOC.map(([id, label]) => (
              <li key={id}>
                <a
                  href={`#${id}`}
                  className="text-brand-600 hover:underline print:text-ink-900"
                >
                  {label}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="space-y-10 text-sm leading-6 text-ink-900">
          {/* ------------------------------------------------------------ */}
          <Section id="overview" title="1. What a job plan is">
            <P>
              A <strong>job plan</strong> is a priced cost estimate for a piece
              of work — a vessel repair, a fabrication package, a service
              call. It is made up of <strong>line items</strong> (one per work
              package or material takeoff), each carrying labor hours and a
              material takeoff. The wizard turns those inputs into cost,
              price, and margin automatically: you never type a total — every
              dollar figure on the plan is computed from the lines you enter
              and the rates you set.
            </P>
            <P>
              Every plan moves through a simple lifecycle. It starts as a{" "}
              <strong>draft</strong> that only its creator (and admins) can
              edit. When the estimate is ready it is{" "}
              <strong>submitted</strong>, which locks the content and routes
              it to approvers. Approvers can <strong>approve</strong> it,{" "}
              <strong>request changes</strong> (which unlocks it for another
              editing round), or <strong>reject</strong> it. Larger plans need
              more than one approval — see{" "}
              <a href="#workflow" className="text-brand-600 hover:underline">
                section 11
              </a>
              .
            </P>
            <Figure>
              draft&nbsp;&nbsp;→&nbsp;&nbsp;submitted&nbsp;&nbsp;→&nbsp;&nbsp;approved
              <br />
              &nbsp;&nbsp;&nbsp;&nbsp;↑&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;├──&nbsp;changes
              requested&nbsp;──→&nbsp;back to editing&nbsp;──→&nbsp;resubmit
              (new version)
              <br />
              &nbsp;&nbsp;&nbsp;&nbsp;└───────────┴──&nbsp;rejected&nbsp;(final)
            </Figure>
            <P>
              Plans can be linked to a <strong>QuickBooks customer and
              job</strong>. Customers and jobs are imported from QuickBooks
              and cannot be created here; linking a job lets the review step
              show actual costs to date next to your estimate, so you can
              compare the plan against reality as the work progresses.
            </P>
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section id="roles" title="2. Roles & permissions">
            <P>
              What you can do in the wizard depends on your role (shown in the
              bottom-left corner of the sidebar). Roles are assigned by an
              admin on the Settings page.
            </P>
            <MTable
              head={["Role", "What they can do in the wizard"]}
              rows={[
                [
                  "Estimator",
                  "Create plans, edit their own plans while in draft or changes-requested status, submit them for approval, and delete their own drafts.",
                ],
                [
                  "Approver",
                  "Open submitted plans and approve, reject, or request changes. Approvers cannot edit plan content, and nobody can approve a plan they created themselves.",
                ],
                [
                  "Admin",
                  "Everything above, on any plan: edit any draft or changes-requested plan, submit on behalf of the creator, approve (except their own plans), and delete any plan in any status.",
                ],
                [
                  "Viewer",
                  "Read-only. Viewers open plans directly on the Review step and see all totals, but no editing or approval controls.",
                ],
              ]}
            />
            <P>
              These rules are enforced by the database, not just by the
              screen: even if a button were visible, the server would refuse
              an action your role does not permit.
            </P>
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section id="create" title="3. Creating a plan">
            <Steps
              items={[
                <>
                  Open <strong>Job Plans</strong> in the sidebar and click{" "}
                  <strong>New job plan</strong>.
                </>,
                <>
                  Enter a <strong>plan title</strong> — this is the only
                  required field to get started. Use something you will
                  recognize in a list, e.g.{" "}
                  <em>&ldquo;Caroline COI 626 Repair&rdquo;</em>.
                </>,
                <>
                  Optionally pick the <strong>customer</strong> and{" "}
                  <strong>QuickBooks job</strong> now, or leave them for
                  later. A customer is required before the plan can be
                  submitted; the job link is always optional.
                </>,
                <>
                  Click <strong>Create plan &amp; start wizard</strong>. The
                  plan is created in <strong>draft</strong> status and the
                  wizard opens on Step&nbsp;1.
                </>,
              ]}
            />
            <Callout>
              You can leave at any time — a draft keeps everything you saved
              and stays in your Job Plans list until you submit or delete it.
            </Callout>
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section id="navigate" title="4. Finding your way around the wizard">
            <P>
              The wizard is one page with four steps:{" "}
              <strong>1&nbsp;Project → 2&nbsp;Rates → 3&nbsp;Scope →
              4&nbsp;Review</strong>. The pill-shaped{" "}
              <strong>step rail</strong> under the title jumps directly to any
              step, and <strong>Back / Next</strong> buttons live in the dark
              bar pinned to the bottom of the screen. Steps are not a one-way
              street — move back and forth as often as you like; nothing is
              final until you submit.
            </P>
            <Shot caption="The step rail — click any pill to jump to that step.">
              <MockStepRail />
            </Shot>
            <H3>The live ticker</H3>
            <P>
              The dark bottom bar is a running total of the whole plan:{" "}
              <strong>Lines</strong>, <strong>Hours</strong>,{" "}
              <strong>Cost</strong>, <strong>Price</strong>,{" "}
              <strong>Profit</strong>, and <strong>Margin</strong>. It
              recalculates on every keystroke, so you see the effect of a
              rate change or a new line instantly. Margin is color-coded:
              green at 30% or better, amber between 15% and 30%, red below
              15%.
            </P>
            <Shot caption="The live ticker, pinned to the bottom of the wizard. Profit is green when positive; this 29.4% margin shows amber (between 15% and 30%).">
              <MockTicker />
            </Shot>
            <H3>How saving works</H3>
            <Ul
              items={[
                <>
                  <strong>Plan details and rates (Steps 1 &amp; 2)</strong>{" "}
                  save together. When you change anything, a{" "}
                  <strong>Save plan details</strong> button appears in the
                  top-right. Moving to another step saves these edits
                  automatically, so you will not lose work by navigating.
                </>,
                <>
                  <strong>Line items (Step 3)</strong> save individually. Each
                  card has its own save (✓) button that lights up when the
                  card has unsaved edits. Prices on screen update live as you
                  type, but the numbers are not stored until you save the
                  card.
                </>,
                <>
                  Unsaved line edits <strong>block submission</strong> — the
                  Review step lists them as a pre-flight check until every
                  card is saved.
                </>,
              ]}
            />
            <H3>Header controls</H3>
            <Ul
              items={[
                <>
                  <strong>Title</strong> — while the plan is editable, click
                  the title at the top of the page and type to rename it.
                </>,
                <>
                  <strong>Status badge &amp; version</strong> — the badge next
                  to the title shows the workflow status; a &ldquo;v2&rdquo;,
                  &ldquo;v3&rdquo;… marker appears once a plan has been
                  resubmitted after changes were requested.
                </>,
                <>
                  <strong>Export CSV</strong> — downloads every line item and
                  the plan totals as a spreadsheet-ready file, in any status.
                </>,
                <>
                  <strong>Delete</strong> — shown to admins on any plan and to
                  creators on their own drafts. Deleting is permanent (see{" "}
                  <a href="#delete" className="text-brand-600 hover:underline">
                    section 13
                  </a>
                  ).
                </>,
              ]}
            />
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section id="step-project" title="5. Step 1 — Project">
            <P>
              Step 1 records who the work is for and when it happens. Only the
              customer is ever mandatory (and only at submit time) — fill in
              the rest as the information becomes available.
            </P>
            <MTable
              head={["Field", "What to enter"]}
              rows={[
                [
                  "Customer",
                  "The QuickBooks customer the work is for. Required before the plan can be submitted. Choosing a customer also filters the job list to that customer's jobs.",
                ],
                [
                  "QuickBooks job",
                  "Optional. Linking a job connects the plan to actual costs and invoices imported from QuickBooks — the Review step then shows actual cost to date, actual hours, and a cost-category breakdown next to your estimate.",
                ],
                [
                  "Project manager",
                  "Who owns delivery of the work internally.",
                ],
                [
                  "Customer contact / phone / email",
                  "The person on the customer's side, so anyone reading the plan knows who to call.",
                ],
                ["Department", "Internal department or division tag."],
                [
                  "Payment terms (days)",
                  "Invoice terms, e.g. 30 for net-30. Shown as “Net 30” on the plan.",
                ],
                [
                  "Start / end date",
                  "The expected working window for the job.",
                ],
                [
                  "Notes",
                  "Free text: scope assumptions, exclusions, berthing details, anything an approver should know that isn't a number.",
                ],
              ]}
            />
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section id="step-rates" title="6. Step 2 — Rates & pools">
            <P>
              Step 2 sets the four levers that drive the math on every line
              item. Set them once per plan; two of them (billing rate and
              material markup) can still be overridden line by line on
              Step&nbsp;3.
            </P>
            <MTable
              head={["Setting", "Meaning"]}
              rows={[
                [
                  "Labor cost rate ($/hr)",
                  "What one labor hour actually costs the company, fully burdened — wages plus benefits, payroll taxes, and insurance. This is the cost side of every labor calculation.",
                ],
                [
                  "Default billing rate ($/hr)",
                  "What the customer is charged per labor hour. Every line uses this rate unless the line sets its own specialty rate (e.g. certified welding billed higher).",
                ],
                [
                  "Consumables (% of labor price)",
                  "Covers welding wire, gas, abrasives, PPE and similar shop consumables. Calculated as a percentage of each line's labor price and passed through at cost — it is added to both the cost and the price of the line, with no markup.",
                ],
                [
                  "Overhead pool ($)",
                  "A fixed dollar amount for job-level overhead (supervision, equipment, facilities burden) that is spread across all line items in proportion to their share of direct cost. Required before submitting — enter 0 if the plan carries no overhead. Also passed through at cost.",
                ],
              ]}
            />
            <P>
              Below the fields, a banner shows the{" "}
              <strong>labor margin</strong> these rates produce on every
              billed hour, so you can sanity-check them before entering any
              scope. If the default billing rate is below the labor cost
              rate, every hour on the plan loses money — the Review step will
              flag it.
            </P>
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section id="step-scope" title="7. Step 3 — Scope of work">
            <P>
              Step 3 is where the estimate is actually built. Each{" "}
              <strong>line item card</strong> is one work package or material
              takeoff — e.g. <em>dry docking</em>, <em>renew bottom
              plating</em>, <em>pipe spool fabrication</em>. Add a card with{" "}
              <strong>Add line item</strong>, fill it in, and click{" "}
              <strong>Add</strong> on the card to save it. Prices on the card
              update live as you type.
            </P>
            <Shot caption="A saved line item card using the steel-by-weight material basis — the same line as the worked example in section 9. The strip along the bottom is the line's full computed breakdown.">
              <MockLineCard />
            </Shot>

            <H3>The card header</H3>
            <MTable
              head={["Control", "What it does"]}
              rows={[
                [
                  "Phase",
                  "Optional grouping label (e.g. Docking, Hull, Machinery). Create phases with the “New phase name” box + Add phase; assign each line from the dropdown on its card. Deleting a phase never deletes line items — they just lose the label.",
                ],
                [
                  "Description",
                  "What the work is. Required — a new card cannot be saved without one.",
                ],
                [
                  "Priority (P1 / P2 / P3)",
                  "P1 is base scope; P2 and P3 are additional or optional work. The Review step subtotals the plan by priority so the customer-facing base price and the options can be quoted separately.",
                ],
                [
                  "Priced / TBD toggle",
                  "Marks a line whose scope or pricing is not yet resolved. TBD lines stay in the plan and its totals, but a plan with any TBD line cannot be approved — the flag is a promise to come back and price it. You can still submit with TBD lines; approvers just cannot approve until every line is priced.",
                ],
                [
                  "Line price & margin",
                  "The card's computed price and margin percentage, always visible in the header.",
                ],
                [
                  "Save (✓) / Delete (🗑)",
                  "Save stores the card's edits (it is only enabled when the card has unsaved changes). Delete removes the line permanently.",
                ],
              ]}
            />

            <H3>Labor inputs</H3>
            <MTable
              head={["Field", "Meaning"]}
              rows={[
                [
                  "Events",
                  "How many times the work happens. Usually 1; use higher values for repeated operations (e.g. 4 crane lifts, 2 dockings).",
                ],
                [
                  "Hrs / pc",
                  "Labor hours to complete one piece (or one occurrence) of the work.",
                ],
                [
                  "Qty",
                  "Number of pieces. Total hours = events × hours per piece × quantity.",
                ],
                [
                  "Bill rate / hr",
                  "Leave blank to bill at the plan's default rate from Step 2. Enter a value to override for this line only — for specialty trades billed at a premium.",
                ],
              ]}
            />

            <H3>Material — pick the basis that matches how you buy it</H3>
            <P>
              The <strong>material basis</strong> dropdown switches which
              takeoff fields the card shows. All four bases feed the same
              downstream math; they only differ in how the material cost is
              derived.
            </P>
            <MTable
              head={["Basis", "Inputs", "Material cost"]}
              rows={[
                [
                  "Unit cost ($/ea)",
                  "Unit cost per each",
                  "quantity × unit cost. For purchased items: valves, zincs, fittings.",
                ],
                [
                  "Steel by weight ($/lb)",
                  "Length per piece (ft), weight per linear foot (lb/LF), price per lb",
                  "length/pc × qty = total LF; × lb/LF = estimated weight; × $/lb = cost. The card shows the computed pounds as you type. For plate, shapes, and pipe bought by weight.",
                ],
                [
                  "Area ($/SF)",
                  "Area per piece (SF), price per SF",
                  "area/pc × qty × $/SF. For coatings, blasting, deck covering.",
                ],
                [
                  "Lump sum",
                  "One dollar amount",
                  "Entered directly. For subcontracted work or vendor quotes.",
                ],
              ]}
            />
            <P>
              <strong>Markup %</strong> applies to the material only, and only
              on the price side: material price = material cost × (1 +
              markup). New lines default to 30%. A line with material cost
              but 0% markup is flagged on the Review step, since material
              would then be passed through with no margin.
            </P>
            <P>
              The strip along the bottom of each card shows the line&rsquo;s
              full computed breakdown — hours, labor cost, labor price,
              consumables, overhead allocation, line cost, and line price —
              so you can see exactly where its total comes from.
            </P>
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section id="math" title="8. How every number is calculated">
            <P>
              The same formulas run live in the wizard and in the database, so
              the numbers you watch while typing are exactly the numbers that
              get saved, exported, and approved. Per line item:
            </P>
            <Formulas
              rows={[
                ["Total hours", "hours per piece × quantity × events"],
                ["Labor cost", "labor cost rate × total hours"],
                [
                  "Labor price",
                  "(line bill rate, or the plan default) × total hours",
                ],
                [
                  "Material cost",
                  "per the basis chosen (see section 7)",
                ],
                [
                  "Material price",
                  "material cost × (1 + markup %)",
                ],
                [
                  "Consumables",
                  "consumables % × labor price — added to cost and price alike",
                ],
                [
                  "Overhead allocation",
                  "overhead pool × (this line's labor cost + material cost) ÷ (all lines' labor cost + material cost)",
                ],
                [
                  "Line cost",
                  "labor cost + material cost + consumables + overhead allocation",
                ],
                [
                  "Line price",
                  "labor price + material price + consumables + overhead allocation",
                ],
                ["Line profit", "line price − line cost"],
              ]}
            />
            <P>
              Plan totals are simply the sum of the lines, and{" "}
              <strong>margin = profit ÷ total price</strong>. Two things worth
              internalizing:
            </P>
            <Ul
              items={[
                <>
                  <strong>Profit comes from two places only</strong>: the
                  spread between billing and cost rate on labor hours, and the
                  markup on material. Consumables and overhead are pass-through
                  — they raise both cost and price by the same amount, adding
                  dollars to the invoice but nothing to profit (and therefore
                  diluting the margin percentage).
                </>,
                <>
                  <strong>Overhead moves when lines change.</strong> The pool
                  is a fixed dollar amount shared out by each line&rsquo;s
                  slice of direct cost, so adding, removing, or re-pricing any
                  line shifts every other line&rsquo;s overhead allocation.
                  The plan total overhead always equals the pool.
                </>,
              ]}
            />
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section id="example" title="9. A fully worked example">
            <P>
              One line, so the arithmetic is easy to follow. Plan rates: labor
              cost <strong>$55/hr</strong>, default billing{" "}
              <strong>$95/hr</strong>, consumables <strong>5%</strong>,
              overhead pool <strong>$1,500</strong>. The line:{" "}
              <em>&ldquo;Renew bottom plating&rdquo;</em> — 1 event, 6 hrs/pc,
              qty 8, steel by weight at 10 ft/pc, 12.5 lb/LF, $0.90/lb, 30%
              markup.
            </P>
            <Formulas
              rows={[
                ["Total hours", "6 × 8 × 1 = 48 hrs"],
                ["Labor cost", "$55 × 48 = $2,640"],
                ["Labor price", "$95 × 48 = $4,560"],
                [
                  "Steel weight",
                  "10 ft × 8 pcs = 80 LF; 80 × 12.5 = 1,000 lb",
                ],
                ["Material cost", "1,000 lb × $0.90 = $900"],
                ["Material price", "$900 × 1.30 = $1,170"],
                ["Consumables", "5% × $4,560 = $228"],
                [
                  "Overhead allocation",
                  "only line → the full $1,500 pool",
                ],
                ["Line cost", "2,640 + 900 + 228 + 1,500 = $5,268"],
                ["Line price", "4,560 + 1,170 + 228 + 1,500 = $7,458"],
                ["Profit / margin", "$2,190 · 29.4%"],
              ]}
            />
            <P>
              At $7,458 total price this plan falls in the under-$25,000
              threshold, so it needs one approval.
            </P>
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section id="step-review" title="10. Step 4 — Review & submit">
            <P>
              The Review step is the whole plan on one screen — it is also
              what approvers and viewers see when they open the plan.
            </P>
            <Ul
              items={[
                <>
                  <strong>Profitability breakdown</strong> — cost and price
                  side by side for labor, material, consumables, and
                  overhead, with total profit and margin, plus how many
                  approvals the current total requires.
                </>,
                <>
                  <strong>By priority</strong> — subtotals for P1 base scope
                  and P2/P3 additional work, so the base price and options can
                  be quoted separately.
                </>,
                <>
                  <strong>Actuals from QuickBooks</strong> — if a job is
                  linked: actual cost to date (red when it exceeds your
                  estimated cost), actual vs. estimated labor hours, and the
                  top cost categories. Use it to compare the estimate against
                  reality once work is underway.
                </>,
                <>
                  <strong>Pre-flight checks</strong> — everything worth fixing
                  before submitting, in one list (details below).
                </>,
                <>
                  <strong>Approval history</strong> — every decision ever made
                  on this plan, with the approver, the plan version it applied
                  to, the date, and any comment.
                </>,
              ]}
            />
            <H3>Pre-flight checks</H3>
            <P>
              Items tagged <strong>&ldquo;blocks submit&rdquo;</strong> must
              be cleared before the plan can go out; the rest are advisory
              warnings — you can submit through them, but expect approvers to
              ask.
            </P>
            <Shot caption="The pre-flight checks panel on the Review step. Items tagged “blocks submit” must be fixed; the rest are warnings.">
              <MockPreflight />
            </Shot>
            <MTable
              head={["Check", "Type"]}
              rows={[
                ["No customer selected", "Blocking — pick one on Step 1"],
                [
                  "Overhead pool not set",
                  "Blocking — enter a value (0 is allowed) on Step 2",
                ],
                [
                  "Unsaved line item edits",
                  "Blocking — save or discard each edited card on Step 3",
                ],
                [
                  "No line items on the plan",
                  "Blocking — enforced at submit time",
                ],
                [
                  "TBD lines present",
                  "Advisory at submit, but blocks approval until every line is priced",
                ],
                [
                  "A line prices below its cost",
                  "Advisory — that line loses money",
                ],
                [
                  "Material with 0% markup",
                  "Advisory — material passed through with no margin",
                ],
                [
                  "Default billing rate below labor cost rate",
                  "Advisory — every hour on the plan loses money",
                ],
                [
                  "Blended margin below 10%",
                  "Advisory — thin-margin plan",
                ],
              ]}
            />
            <H3>Submitting</H3>
            <P>
              Click <strong>Submit for approval</strong>. The plan switches to{" "}
              <strong>submitted</strong>: all content — details, rates,
              phases, and lines — is locked, and the plan appears in the
              approvers&rsquo; queue on the Approvals page. Nothing further is
              required from you unless an approver requests changes.
            </P>
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section id="workflow" title="11. The approval workflow">
            <H3>How many approvals a plan needs</H3>
            <P>
              The requirement is driven by the plan&rsquo;s total price
              (thresholds are configurable by admins; the defaults are shown
              on the Approvals page):
            </P>
            <MTable
              head={["Total price", "Required"]}
              rows={[
                ["Under $25,000", "1 approval"],
                ["$25,000 – $100,000", "2 approvals"],
                ["$100,000 and up", "3 approvals"],
              ]}
            />
            <P>
              A plan stays <strong>submitted</strong> and collects approvals
              until it has enough, then flips to <strong>approved</strong>{" "}
              automatically. The Approvals page shows a live{" "}
              <em>granted / required</em> count for every waiting plan.
            </P>
            <H3>Acting on a submitted plan</H3>
            <P>
              Approvers (and admins) open the plan — it lands on the Review
              step with an <strong>Awaiting approval</strong> banner holding
              three actions:
            </P>
            <Shot caption="The approval banner as an approver sees it on a submitted plan. A comment is optional to approve, required to request changes or reject.">
              <MockApprovalBanner />
            </Shot>
            <MTable
              head={["Action", "Comment", "What happens"]}
              rows={[
                [
                  "Approve",
                  "Optional",
                  "Records an approval for the current version. When approvals reach the required count, the plan becomes approved.",
                ],
                [
                  "Request changes",
                  "Required",
                  "Sends the plan back to the estimator in changes-requested status. It becomes editable again; when resubmitted, the version number increments and approvals start over from zero for the new version.",
                ],
                [
                  "Reject",
                  "Required",
                  "Final. A rejected plan is closed permanently — it cannot be edited or resubmitted. To pursue the work, create a new plan (use Request changes instead when a revision could fix it).",
                ],
              ]}
            />
            <H3>Guard rails</H3>
            <Ul
              items={[
                <>
                  <strong>No self-approval</strong> — you can never approve a
                  plan you created, even as an admin.
                </>,
                <>
                  <strong>TBD gate</strong> — a plan with any TBD line cannot
                  be approved. The estimator must price or remove those lines
                  (via request-changes if already submitted).
                </>,
                <>
                  <strong>Version integrity</strong> — approvals are tied to a
                  specific version, so nothing approved ever differs from what
                  the approver saw.
                </>,
                <>
                  <strong>Audit trail</strong> — every submit, approval,
                  change request, and rejection is written to a permanent
                  audit log with who, when, and the totals at that moment.
                </>,
              ]}
            />
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section id="export" title="12. Exporting & printing a plan">
            <Ul
              items={[
                <>
                  <strong>Export CSV</strong> (top-right of the wizard) —
                  downloads the plan&rsquo;s line items and totals for Excel
                  or Sheets. Available in every status, to anyone who can view
                  the plan.
                </>,
                <>
                  <strong>Printing a plan</strong> — open the Review step and
                  use the browser&rsquo;s print dialog (
                  <Kbd>Ctrl</Kbd>+<Kbd>P</Kbd> / <Kbd>⌘</Kbd>+<Kbd>P</Kbd>);
                  choose <em>Save as PDF</em> as the destination to produce a
                  PDF.
                </>,
                <>
                  <strong>This manual</strong> — prints the same way; the{" "}
                  <em>Print / Save PDF</em> button at the top does it in one
                  click.
                </>,
              ]}
            />
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section id="delete" title="13. Deleting plans">
            <P>
              <strong>Deleting a plan is permanent</strong> — the plan and all
              of its phases and line items are removed, with no undo.
              Estimators can delete <em>their own drafts only</em>; admins can
              delete any plan in any status. The Delete button lives in the
              wizard header and next to each row on the Job Plans list, and
              always asks for confirmation first.
            </P>
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section id="faq" title="14. Troubleshooting & FAQ">
            <Faq
              q="Everything on the plan is read-only — why can't I edit?"
              a="Three common reasons: the plan is submitted, approved, or rejected (content is locked outside draft and changes-requested status); you are not the plan's creator (only the creator or an admin may edit); or your role is viewer or approver, which never edits plan content."
            />
            <Faq
              q="The Submit button is disabled."
              a="You have unsaved edits. Save plan details (top-right button) if it is showing, and save every line item card with a lit save (✓) button on the Scope step. The Review step's pre-flight list tells you exactly how many lines have unsaved edits."
            />
            <Faq
              q="Submitting fails with “Overhead is required before submitting”."
              a="The overhead pool on Step 2 has never been set. It must have a value before submission — enter 0 if the plan genuinely carries no overhead."
            />
            <Faq
              q="An approver can see the plan but the Approve button is disabled."
              a="The plan has TBD lines — hover the button and the tooltip says so. Ask the estimator to price or remove them: use Request changes to send the plan back so they can."
            />
            <Faq
              q="Why did the version number change to v2?"
              a="An approver requested changes and the plan was resubmitted. Each resubmission increments the version, and approvals granted on earlier versions no longer count — every approver signs off on the exact content in front of them."
            />
            <Faq
              q="My line's overhead allocation changed but I didn't touch that line."
              a="Expected. The overhead pool is a fixed amount divided across lines by their share of direct (labor + material) cost, so changing any line redistributes the pool across all of them. The plan-level overhead total never changes — only the split."
            />
            <Faq
              q="The QuickBooks job I need isn't in the dropdown."
              a="Jobs are imported from QuickBooks, not created here. If a job is missing, run a QuickBooks sync from the Settings page (admins) — the dropdown lists every active imported job for the selected customer."
            />
            <Faq
              q="Can I reopen a rejected plan?"
              a="No — rejection is final by design. Create a new plan for the work. If you expect a plan to come back after revisions, approvers should use Request changes rather than Reject."
            />
            <Faq
              q="Who can delete a plan?"
              a="Admins can delete any plan; estimators only their own drafts. Once a plan has been submitted, only an admin can remove it."
            />
          </Section>
        </div>

        <footer className="mt-12 border-t border-line pt-4 text-xs text-ink-400">
          SMW Job Plans — Job Plan Wizard user manual. Approval thresholds and
          role assignments are configurable by admins; the values shown here
          are the system defaults.
        </footer>
      </article>
    </div>
  );
}

/* ------------------------------------------------------------------------- */

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-6">
      <h2 className="mb-3 border-b border-line pb-2 text-lg font-semibold tracking-tight text-ink-900">
        {title}
      </h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function H3({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="pt-2 text-sm font-semibold text-ink-900">{children}</h3>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="text-ink-600">{children}</p>;
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-line bg-surface px-1 py-0.5 font-mono text-[0.7rem] text-ink-900">
      {children}
    </kbd>
  );
}

function Callout({ children }: { children: React.ReactNode }) {
  return (
    <div className="break-inside-avoid rounded-lg border border-brand-500/25 bg-brand-50 px-4 py-2.5 text-sm text-brand-700">
      {children}
    </div>
  );
}

function Figure({ children }: { children: React.ReactNode }) {
  return (
    <pre className="break-inside-avoid overflow-x-auto rounded-lg bg-surface px-4 py-3 font-mono text-xs leading-5 text-ink-900">
      {children}
    </pre>
  );
}

function Steps({ items }: { items: React.ReactNode[] }) {
  return (
    <ol className="space-y-2 text-ink-600">
      {items.map((item, i) => (
        <li key={i} className="flex gap-3">
          <span className="flex h-5 w-5 flex-none items-center justify-center rounded-full bg-navy-900 text-[0.65rem] font-semibold text-white">
            {i + 1}
          </span>
          <span>{item}</span>
        </li>
      ))}
    </ol>
  );
}

function Ul({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="list-disc space-y-1.5 pl-5 text-ink-600">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

function MTable({
  head,
  rows,
}: {
  head: string[];
  rows: string[][];
}) {
  return (
    <div className="break-inside-avoid overflow-hidden rounded-lg border border-line">
      <table className="w-full text-sm">
        <thead className="border-b border-line bg-surface/70 text-left text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
          <tr>
            {head.map((h) => (
              <th key={h} className="px-3.5 py-2">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line/70">
          {rows.map((cells, i) => (
            <tr key={i} className="align-top">
              {cells.map((c, j) => (
                <td
                  key={j}
                  className={`px-3.5 py-2 ${
                    j === 0
                      ? "whitespace-nowrap font-medium text-ink-900"
                      : "text-ink-600"
                  }`}
                >
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Formulas({ rows }: { rows: [string, string][] }) {
  return (
    <div className="break-inside-avoid rounded-lg bg-surface px-4 py-3">
      <dl className="space-y-1 font-mono text-xs leading-5">
        {rows.map(([label, formula]) => (
          <div key={label} className="flex flex-wrap gap-x-2">
            <dt className="w-40 flex-none font-semibold text-ink-900">
              {label}
            </dt>
            <dd className="text-ink-600">= {formula}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Faq({ q, a }: { q: string; a: string }) {
  return (
    <div className="break-inside-avoid">
      <p className="font-semibold text-ink-900">{q}</p>
      <p className="mt-0.5 text-ink-600">{a}</p>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Illustrations — static reproductions of the wizard UI, built with the same
   design tokens as the live components so they match the app exactly and
   print cleanly. Purely decorative: nothing here is interactive.
--------------------------------------------------------------------------- */

function Shot({
  caption,
  children,
}: {
  caption: string;
  children: React.ReactNode;
}) {
  return (
    <figure className="break-inside-avoid" aria-hidden="true">
      <div className="overflow-x-auto rounded-lg border border-line bg-surface/60 p-4">
        {children}
      </div>
      <figcaption className="mt-1.5 text-xs italic text-ink-400">
        {caption}
      </figcaption>
    </figure>
  );
}

function MockStepRail() {
  const steps = [
    { label: "Project", icon: Ship, active: true },
    { label: "Rates", icon: Settings2 },
    { label: "Scope", icon: Wrench },
    { label: "Review", icon: ClipboardCheck },
  ];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {steps.map((s, i) => {
        const Icon = s.icon;
        return (
          <span
            key={s.label}
            className={`inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-semibold ${
              s.active
                ? "bg-navy-900 text-white"
                : "border border-line bg-white text-ink-600"
            }`}
          >
            <span
              className={`flex h-4.5 w-4.5 items-center justify-center rounded-full text-[0.62rem] ${
                s.active ? "bg-white/15 text-white" : "bg-surface text-ink-400"
              }`}
            >
              {i + 1}
            </span>
            <Icon size={13} strokeWidth={2} />
            {s.label}
          </span>
        );
      })}
    </div>
  );
}

function MockTick({
  label,
  v,
  tone,
}: {
  label: string;
  v: string;
  tone?: "ok" | "warn" | "bad";
}) {
  const color =
    tone === "ok"
      ? "text-[#6fcf97]"
      : tone === "warn"
        ? "text-[#e5b567]"
        : tone === "bad"
          ? "text-[#f0857a]"
          : "text-white";
  return (
    <span className="shrink-0">
      <span className="block text-[10px] uppercase tracking-widest text-white/40">
        {label}
      </span>
      <span className={`block text-sm font-semibold tabular-nums ${color}`}>
        {v}
      </span>
    </span>
  );
}

function MockTicker() {
  return (
    <div className="flex min-w-fit items-center gap-6 rounded-lg bg-navy-950 px-6 py-3">
      <MockTick label="Lines" v="1" />
      <MockTick label="Hours" v="48" />
      <MockTick label="Cost" v="$5,268.00" />
      <MockTick label="Price" v="$7,458.00" />
      <MockTick label="Profit" v="$2,190.00" tone="ok" />
      <MockTick label="Margin" v="29.4%" tone="warn" />
    </div>
  );
}

function MockInput({
  label,
  value,
  faint,
  w,
}: {
  label: string;
  value: string;
  faint?: boolean;
  w?: string;
}) {
  return (
    <span className={`block ${w ?? ""}`}>
      <span className="block text-[0.65rem] font-semibold uppercase tracking-[0.06em] text-ink-400">
        {label}
      </span>
      <span
        className={`mt-1 block w-full truncate rounded-md border border-line bg-white px-2 py-1.5 text-sm tabular-nums ${
          faint ? "text-ink-400" : "text-ink-900"
        }`}
      >
        {value}
      </span>
    </span>
  );
}

function MockMini({
  label,
  v,
  strong,
}: {
  label: string;
  v: string;
  strong?: boolean;
}) {
  return (
    <span
      className={`text-xs tabular-nums ${strong ? "font-semibold text-ink-900" : "text-ink-600"}`}
    >
      <span className="text-[10px] font-medium uppercase tracking-wide text-ink-400">
        {label}{" "}
      </span>
      {v}
    </span>
  );
}

function MockLineCard() {
  return (
    <div className="min-w-[36rem] rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(13,36,56,0.05)]">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <span className="rounded-md border border-line bg-white px-2 py-1 text-xs font-semibold uppercase tracking-wide text-brand-700">
          Hull
        </span>
        <span className="min-w-40 flex-1 rounded-md border border-line bg-white px-2 py-1 text-sm text-ink-900">
          Renew bottom plating
        </span>
        <span className="rounded-md border border-line bg-white px-2 py-1 text-xs text-ink-900">
          P1 — Base scope
        </span>
        <span className="flex items-center gap-1 rounded-full bg-surface px-2.5 py-1 text-xs font-medium text-ink-600">
          <HelpCircle size={12} aria-hidden="true" />
          Priced
        </span>
        <span className="ml-auto text-sm font-semibold tabular-nums text-ink-900">
          $7,458.00
        </span>
        <span className="text-xs tabular-nums text-ok-600">29.4%</span>
      </div>
      <div className="grid grid-cols-3 gap-3 px-4 py-3 md:grid-cols-6">
        <MockInput label="Events" value="1" />
        <MockInput label="Hrs / pc" value="6" />
        <MockInput label="Qty" value="8" />
        <MockInput label="Bill rate / hr" value="default" faint />
        <MockInput
          label="Material basis"
          value="Steel by weight ($/lb)"
          w="col-span-2"
        />
        <MockInput label="Length / pc (ft)" value="10" />
        <MockInput label="Wt / lin ft" value="12.5" />
        <MockInput label="$ / lb" value="0.90" />
        <MockInput label="Markup %" value="30" />
        <span className="col-span-2 flex items-end pb-2 text-xs tabular-nums text-ink-600">
          1000.0 lbs → $900.00 cost / $1,170.00 price
        </span>
        <div className="col-span-3 flex flex-wrap gap-x-6 gap-y-1 border-t border-line/60 pt-2 md:col-span-6">
          <MockMini label="Hours" v="48" />
          <MockMini label="Labor cost" v="$2,640.00" />
          <MockMini label="Labor price" v="$4,560.00" />
          <MockMini label="Consumables" v="$228.00" />
          <MockMini label="OH alloc" v="$1,500.00" />
          <MockMini label="Line cost" v="$5,268.00" strong />
          <MockMini label="Line price" v="$7,458.00" strong />
        </div>
      </div>
    </div>
  );
}

function MockPreflight() {
  return (
    <div className="min-w-fit rounded-xl border border-warn-700/25 bg-warn-50 p-4">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-warn-700">
        <AlertTriangle size={16} aria-hidden="true" /> Pre-flight checks
      </div>
      <ul className="space-y-1 text-sm text-ink-900">
        <li>
          • Overhead pool is not set — required before submitting.
          <span className="ml-1.5 rounded bg-warn-700/10 px-1 text-[10px] font-bold uppercase text-warn-700">
            blocks submit
          </span>
        </li>
        <li>• 1 TBD line — approval is blocked until resolved.</li>
        <li>
          • &ldquo;Anchor chain survey&rdquo; has material at 0% markup.
        </li>
      </ul>
    </div>
  );
}

function MockApprovalBanner() {
  return (
    <div className="min-w-fit rounded-xl border border-brand-500/25 bg-brand-50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-brand-700">
          <span className="font-semibold">Awaiting approval:</span> 0 of 1
          required approval · $7,458.00 total
        </p>
        <span className="flex flex-wrap items-center gap-2">
          <span className="w-56 rounded-lg border border-line bg-white px-3 py-1.5 text-sm text-ink-400">
            Comment (required to reject / request changes)
          </span>
          <span className={buttonCls("success", "sm")}>
            <Check size={13} strokeWidth={2.5} />
            Approve
          </span>
          <span className={buttonCls("warn", "sm")}>
            <MessageSquareWarning size={13} strokeWidth={2} />
            Request changes
          </span>
          <span className={buttonCls("danger", "sm")}>
            <X size={13} strokeWidth={2.5} />
            Reject
          </span>
        </span>
      </div>
    </div>
  );
}
