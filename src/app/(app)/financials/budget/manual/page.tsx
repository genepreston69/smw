import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { PrintButton } from "@/components/PrintButton";
import { buttonCls } from "@/components/ui";
import { monthLabel } from "@/lib/financials";
import { BUDGET_YEAR, baselineRange } from "@/lib/budget";

export const metadata = {
  title: "Budget — User Manual",
};

/* ---------------------------------------------------------------------------
   Printable user manual for the Budget module (/financials/budget). Static
   content — the authoritative behavior lives in src/lib/budget.ts
   (assembleBudget and friends), src/lib/budgetServer.ts (loadBudget), the
   page components in this folder, the Excel export at
   /api/export/budget, and migrations 0026 / 0027. Keep this page in sync
   when those change. Year and baseline labels are read from the real
   constants so the text can never drift from the screen.
--------------------------------------------------------------------------- */

const TOC = [
  ["overview", "1. What the Budget module is"],
  ["access", "2. Who can use it"],
  ["concepts", "3. The four ingredients of the budget"],
  ["tour", "4. A tour of the Budget page"],
  ["filters", "5. Company, View & Columns filters"],
  ["baseline", "6. The baseline — where the numbers come from"],
  ["growth", "7. Growth assumptions"],
  ["initiatives", "8. New initiatives"],
  ["initiative-workflow", "9. The initiative approval workflow"],
  ["statement", "10. Reading the budget statement"],
  ["variance", "11. Budget vs Actual"],
  ["math", "12. How every number is calculated"],
  ["example", "13. A worked example"],
  ["export", "14. Exporting to Excel & printing"],
  ["prep", "15. Preparing the data: categories & syncs"],
  ["process", "16. A recommended budgeting process"],
  ["faq", "17. Troubleshooting & FAQ"],
] as const;

export default async function BudgetManualPage() {
  await requireAdmin();

  const year = BUDGET_YEAR;
  const baseline = baselineRange(year);
  const baseFrom = monthLabel(baseline.from); // e.g. "Jul 2025"
  const baseTo = monthLabel(baseline.to); // e.g. "Jun 2026"
  const baseFromYear = year - 2;
  const baseToYear = year - 1;
  const fmt = (n: number) =>
    n.toLocaleString("en-US", { maximumFractionDigits: 0 });

  return (
    <div className="mx-auto max-w-3xl">
      {/* Header + actions (hidden when printing) */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href="/financials/budget" className={buttonCls("secondary")}>
          <ArrowLeft size={16} strokeWidth={2} />
          Back to Budget
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
            How to use the Budget module
          </h1>
          <p className="mt-2 text-sm text-ink-600">
            A complete guide to building the calendar {year} budget: where the
            baseline comes from, how growth assumptions and new initiatives
            shape it, how to read Budget vs Actual once the year is under
            way, and how every number is calculated. Print this page or save
            it as a PDF with the <em>Print / Save PDF</em> button (or{" "}
            <Kbd>Ctrl</Kbd>+<Kbd>P</Kbd> / <Kbd>⌘</Kbd>+<Kbd>P</Kbd>).
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
          <Section id="overview" title="1. What the Budget module is">
            <P>
              The Budget module turns the general ledger you have already
              imported from QuickBooks into a <strong>full calendar-year
              budget for {year}</strong>, laid out exactly like the expandable
              Income Statement: Income, Direct Costs, Gross profit, Operating
              Expenses, Net income, and (for all companies together) the
              intercompany eliminations. You do not type a budget line by
              line. Instead the system starts from a year of real actuals,
              you apply growth assumptions per company, and you add new
              initiatives that do not exist in history yet. The result is a
              month-by-month plan that carries your seasonality forward and
              can be compared against actuals as the year closes.
            </P>
            <P>
              Three things make this budget different from a spreadsheet you
              would build by hand:
            </P>
            <Ul
              items={[
                <>
                  <strong>It is derived, not stored.</strong> The only inputs
                  saved are the growth percentages and the initiatives. The
                  statement itself is recomputed from the ledger on every
                  page load, so it always reflects the latest categories and
                  the latest synced ledger.
                </>,
                <>
                  <strong>It is live.</strong> Change a growth percentage and
                  every row re-prices instantly, before you decide whether to
                  save it. Explore scenarios freely; nothing is stored until
                  you click <em>Save changes</em>.
                </>,
                <>
                  <strong>It is governed.</strong> New initiatives move through
                  proposed → approved (or rejected). Only approved initiatives
                  count toward the budget, and an approved initiative&rsquo;s
                  amounts are locked. Every status change is written to the
                  audit log.
                </>,
              ]}
            />
            <Figure>
              Ledger actuals ({baseFrom} – {baseTo})
              <br />
              &nbsp;&nbsp;→ mapped month-for-month onto {year}
              <br />
              &nbsp;&nbsp;→ × (1 + growth %) per company (revenue % / expense %)
              <br />
              &nbsp;&nbsp;+ approved new initiatives (spread from start month → Dec)
              <br />
              &nbsp;&nbsp;= Budget {year}, in the Income Statement&rsquo;s layout
              <br />
              <br />
              Budget {year} vs ledger actuals (closed months) = Budget vs Actual
            </Figure>
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section id="access" title="2. Who can use it">
            <P>
              The Budget is part of the Financials area and is{" "}
              <strong>admin-only</strong>, like the general ledger it is built
              from. Only users whose role is <em>Admin</em> see the{" "}
              <strong>Financials → Budget</strong> entry in the sidebar; anyone
              else who opens the address directly is redirected to the home
              page.
            </P>
            <MTable
              head={["Role", "Budget access"]}
              rows={[
                [
                  "Admin",
                  "Full access: view the budget, change growth assumptions, create / edit / approve / reject / delete initiatives, and export to Excel.",
                ],
                [
                  "Estimator / Approver / Viewer",
                  "No access. The Budget page and its export are hidden and refused.",
                ],
              ]}
            />
            <P>
              These rules are enforced in the database (row-level security on
              the budget tables checks for the admin role) and again in every
              server action, not just by hiding buttons. There is no separate
              &ldquo;budget approver&rdquo; role: any admin can approve an
              initiative, including one they created, because the budget is
              a planning document rather than a committed contract. Who
              approved what is recorded on each initiative and in the audit
              log.
            </P>
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section id="concepts" title="3. The four ingredients of the budget">
            <P>
              Everything on the Budget page is one of four things. Knowing
              which is which makes the rest of this manual easy to follow.
            </P>
            <MTable
              head={["Ingredient", "What it is", "Where it comes from"]}
              rows={[
                [
                  "Baseline",
                  `Each revenue and expense account's actual monthly activity for the twelve months ${baseFrom} – ${baseTo}, moved onto the same calendar month of ${year}.`,
                  "Computed from the imported general ledger on every load. Nothing to enter.",
                ],
                [
                  "Growth assumptions",
                  "Two percentages per QuickBooks company: revenue growth and expense growth. Applied to every baseline account of that company.",
                  "You enter them in the Growth assumptions card and click Save changes.",
                ],
                [
                  "New initiatives",
                  `Expected ${year} revenue and expense, by account, for something that is not in last year's history — a new crew, a new product line, a new lease. Spread evenly from a start month through December.`,
                  "You create them with New Initiative; they join the budget only once approved.",
                ],
                [
                  "Categories",
                  "The grouping of accounts into Income / Direct Costs / Operating Expense categories, the direct-cost split, and the Employee Benefits allocation.",
                  "Assigned on the Chart of Accounts page — shared with the Income Statement, not budget-specific.",
                ],
              ]}
            />
            <Callout>
              The budget year itself ({year}) is fixed in the application and
              changes once a year with a code update. Its baseline window
              follows automatically: the twelve months ending June 30 of the
              year before the budget year.
            </Callout>
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section id="tour" title="4. A tour of the Budget page">
            <P>
              Open <strong>Financials → Budget</strong> in the sidebar. From
              top to bottom the page shows:
            </P>
            <Steps
              items={[
                <>
                  <strong>Header.</strong> The title <em>Budget {year}</em>,
                  a one-line description of how the budget is built, and the
                  action buttons: <strong>Export Excel</strong>,{" "}
                  <strong>Income Statement</strong> (jumps to the actuals the
                  budget mirrors), and <strong>User manual</strong> (this
                  page).
                </>,
                <>
                  <strong>Filter card.</strong> Pill rows for{" "}
                  <strong>Company</strong> (only when more than one QuickBooks
                  company is connected), <strong>View</strong> (Budget or
                  Budget vs Actual), and <strong>Columns</strong> (Month,
                  Quarter, Total only — Budget view only). See{" "}
                  <a href="#filters" className="text-brand-600 hover:underline">
                    section 5
                  </a>
                  .
                </>,
                <>
                  <strong>Growth assumptions card.</strong> One row per
                  company with a <em>Revenue growth %</em> and an{" "}
                  <em>Expense growth %</em> field, a <strong>Reset to
                  baseline</strong> button, and the <strong>New
                  Initiative</strong> button. A colored bar appears under the
                  rows whenever you have unsaved edits. See{" "}
                  <a href="#growth" className="text-brand-600 hover:underline">
                    section 7
                  </a>
                  .
                </>,
                <>
                  <strong>Summary tiles.</strong> <em>Budgeted income</em>,{" "}
                  <em>Budgeted gross profit</em> (when a direct-cost category
                  exists), <em>Budgeted net income</em> (after eliminations
                  when viewing all companies), and <em>Proposed
                  initiatives</em> — the net value of initiatives still
                  awaiting approval, which is <strong>not</strong> in the
                  budget.
                </>,
                <>
                  <strong>The statement.</strong> The budget (or Budget vs
                  Actual) in the Income Statement&rsquo;s expandable layout.
                  Click any category row to expand it to its accounts; use{" "}
                  <strong>Expand all / Collapse all</strong> above the table.
                  See{" "}
                  <a href="#statement" className="text-brand-600 hover:underline">
                    section 10
                  </a>
                  .
                </>,
                <>
                  <strong>New initiatives panel.</strong> Every initiative for
                  the selected companies — proposed first, then approved, then
                  rejected — with its totals, status, and action buttons.
                  Click an initiative&rsquo;s name to expand its description
                  and account lines. See{" "}
                  <a href="#initiatives" className="text-brand-600 hover:underline">
                    section 8
                  </a>
                  .
                </>,
                <>
                  <strong>Footnote.</strong> A short restatement of the rules
                  in this manual, so a reader who lands on the page cold
                  knows how the numbers were formed.
                </>,
              ]}
            />
            <Shot caption="The growth assumptions card with an unsaved change on one company. The budget below already reflects the new percentage; nothing is stored until Save changes.">
              <MockAssumptions />
            </Shot>
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section id="filters" title="5. Company, View & Columns filters">
            <H3>Company</H3>
            <P>
              <strong>All companies</strong> consolidates every connected
              QuickBooks company into one statement and shows the
              intercompany eliminations below Net income. Picking a single
              company shows that company alone, and — because eliminations
              are a consolidation adjustment — hides the eliminations
              section. The Company filter also controls which companies
              appear in the Growth assumptions card and which initiatives are
              listed. The row is hidden entirely when only one company is
              connected.
            </P>
            <H3>View</H3>
            <MTable
              head={["View", "What you see"]}
              rows={[
                [
                  "Budget",
                  `The full ${year} plan, by month, quarter, or total, with a % column after each amount (percent of that column's total income).`,
                ],
                [
                  "Budget vs Actual",
                  `Full-year budget, year-to-date budget, and year-to-date actuals side by side, with variance in dollars and percent — once at least one ${year} month has closed. Before that it shows an explanatory empty state.`,
                ],
              ]}
            />
            <H3>Columns (Budget view only)</H3>
            <MTable
              head={["Option", "Layout"]}
              rows={[
                [
                  "Month",
                  `Twelve columns Jan ${year} – Dec ${year}, plus a Total column.`,
                ],
                [
                  "Quarter",
                  `Four columns ${year} Q1 – Q4, plus a Total column.`,
                ],
                [
                  "Total only",
                  "A single Budget column per row — the compact view for a summary meeting.",
                ],
              ]}
            />
            <P>
              Filters live in the page address, so a bookmarked or shared
              link opens on the same company, view, and layout. Growth
              assumptions are <em>not</em> in the address — they are saved
              per company, or carried along only by the Excel export.
            </P>
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section id="baseline" title="6. The baseline — where the numbers come from">
            <P>
              The baseline is the heart of the budget: a year of real,
              audited-quality ledger activity that gives every account a
              realistic starting point and a realistic seasonal shape. For
              the {year} budget it is the twelve months{" "}
              <strong>{baseFrom} through {baseTo}</strong>.
            </P>
            <H3>Why these twelve months?</H3>
            <P>
              Budgets are typically built in the second half of the year, so
              the trailing twelve months ending June 30 are the most recent
              <em> complete</em> year of data available when planning starts.
              Using a July–June window also means every calendar month is
              represented exactly once, which is what allows the month-for-
              month mapping below.
            </P>
            <H3>Month-for-month mapping</H3>
            <P>
              Each baseline month lands on the <strong>same calendar
              month</strong> of the budget year, not on the month twelve or
              eighteen months later:
            </P>
            <MTable
              head={["Baseline month", "Becomes budget month"]}
              rows={[
                [`Jul ${baseFromYear}`, `Jul ${year}`],
                [`Aug ${baseFromYear}`, `Aug ${year}`],
                ["…", "…"],
                [`Dec ${baseFromYear}`, `Dec ${year}`],
                [`Jan ${baseToYear}`, `Jan ${year}`],
                ["…", "…"],
                [`Jun ${baseToYear}`, `Jun ${year}`],
              ]}
            />
            <P>
              This keeps seasonality intact: if December is historically a
              slow month and March a strong one, the budget shows the same
              pattern. Growth is then applied on top of that shape.
            </P>
            <H3>What is included</H3>
            <Ul
              items={[
                <>
                  Only <strong>Revenue</strong> and <strong>Expense</strong>{" "}
                  accounts (the profit-and-loss side of the ledger). Balance
                  sheet accounts are never budgeted here.
                </>,
                <>
                  Every posted ledger line in the window, read the same way
                  the Income Statement reads it, so{" "}
                  <strong>the baseline for a month equals the Income Statement
                  for that month</strong> with zero growth applied.
                </>,
                <>
                  Amounts are natural-signed: positive revenue increases
                  income, positive expense increases cost. A credit memo or a
                  refund shows as a negative on its account, and is grown by
                  the same percentage as everything else in its class.
                </>,
              ]}
            />
            <Callout>
              The baseline is only as complete as the imported ledger. If a
              baseline month looks light, check the Income Statement for that
              month first — the budget can only grow what the sync brought
              in. Section 15 covers the syncs.
            </Callout>
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section id="growth" title="7. Growth assumptions">
            <P>
              Growth assumptions are the primary lever of the budget: two
              percentages per QuickBooks company that scale every baseline
              account of that company.
            </P>
            <MTable
              head={["Field", "What it does", "Allowed range"]}
              rows={[
                [
                  "Revenue growth %",
                  "Multiplies every Revenue account of the company by (1 + %). Also grows that company's intercompany revenue, so the eliminations scale with it.",
                  "−100% to 1000%, decimals allowed (e.g. 4.5).",
                ],
                [
                  "Expense growth %",
                  "Multiplies every Expense account of the company — direct costs and operating expenses alike — by (1 + %).",
                  "−100% to 1000%, decimals allowed.",
                ],
              ]}
            />
            <P>
              A blank field or a lone minus sign is treated as 0%. Values are
              saved per company and per budget year, so next year&rsquo;s
              budget starts fresh.
            </P>
            <H3>Editing: live preview, explicit save</H3>
            <Steps
              items={[
                <>
                  Type a percentage in either field. The statement, the
                  summary tiles, and the eliminations{" "}
                  <strong>re-price immediately</strong> — the field turns
                  amber to show it differs from the saved value.
                </>,
                <>
                  A bar appears under the rows:{" "}
                  <em>&ldquo;Unsaved changes for &lt;company&gt; — the budget
                  below reflects them. Save changes or revert?&rdquo;</em>
                </>,
                <>
                  Click <strong>Save changes</strong> to store every edited
                  company&rsquo;s percentages, or <strong>Revert</strong> to
                  snap back to the saved values. Each company saves
                  independently: if one fails validation the others still
                  save, and the bar names the one that did not.
                </>,
                <>
                  <strong>Reset to baseline</strong> sets every company&rsquo;s
                  percentages to 0 so the budget equals the baseline actuals.
                  This is itself an unsaved edit — save or revert as usual.
                </>,
              ]}
            />
            <Callout>
              Leaving the page with unsaved growth changes triggers a browser
              &ldquo;leave this page?&rdquo; warning. If you only wanted to
              explore a scenario, click Revert first and the warning goes
              away.
            </Callout>
            <H3>Choosing a sensible percentage</H3>
            <Ul
              items={[
                <>
                  Growth applies <strong>uniformly</strong> to every account in
                  the class. It is the right tool for &ldquo;we expect 5% more
                  volume and 3% cost inflation.&rdquo; It is the wrong tool for
                  &ldquo;we are hiring two welders&rdquo; — that is a new
                  initiative (next section), so it lands on specific accounts
                  and specific months.
                </>,
                <>
                  Revenue and expense can grow at different rates — that is
                  how you budget margin expansion or compression. Watch the
                  Budgeted net income tile as you type.
                </>,
                <>
                  Negative growth is allowed and useful for a company winding
                  down a line of business, but remember it also shrinks
                  every expense account uniformly.
                </>,
              ]}
            />
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section id="initiatives" title="8. New initiatives">
            <P>
              A new initiative is anything you expect in {year} that history
              cannot predict: a new barge-building line, a second paint crew,
              a new facility lease, a one-time equipment overhaul. Each
              initiative belongs to one company, starts in a chosen month,
              and carries an expected <strong>annual</strong> amount per
              account.
            </P>
            <H3>Creating an initiative</H3>
            <Steps
              items={[
                <>
                  Click <strong>New Initiative</strong> (top right of the Growth
                  assumptions card). The dialog opens.
                </>,
                <>
                  Enter a <strong>Name</strong> (required, up to 120
                  characters) — e.g. <em>&ldquo;Second paint crew&rdquo;</em>.
                </>,
                <>
                  Pick the <strong>Company</strong>. The account list below
                  switches to that company&rsquo;s chart of accounts, and any
                  amounts already typed are cleared.
                </>,
                <>
                  Pick the <strong>Starts</strong> month. Amounts are spread
                  evenly from this month through December {year}. January
                  means a full twelve-month spread; July means six months.
                </>,
                <>
                  Optionally add a <strong>Description</strong> (up to 2000
                  characters): the business case, assumptions, who sponsors
                  it. It shows when the initiative is expanded in the panel.
                </>,
                <>
                  Under <strong>Expected revenue</strong> and{" "}
                  <strong>Expected expense</strong>, type the {year} amount in
                  each relevant account. Use the filter box to find accounts
                  by name or category; accounts you have already filled in
                  stay visible while filtering. The footer totals Revenue,
                  Expense, and Net as you type.
                </>,
                <>
                  Click <strong>Save as proposed</strong>. The initiative
                  appears in the panel with status{" "}
                  <em>Proposed — not in budget</em>.
                </>,
              ]}
            />
            <Shot caption="The initiative dialog. Each account gets the expected full-year amount; the footer totals update as you type.">
              <MockInitiativeDialog />
            </Shot>
            <H3>Rules enforced on save</H3>
            <Ul
              items={[
                <>At least one account must have a non-zero amount.</>,
                <>
                  Each account can appear only once; accounts left at 0 are
                  simply not stored.
                </>,
                <>
                  Amounts are whole-year figures. The system divides by the
                  number of months from the start month to December — you do
                  not enter a monthly figure.
                </>,
                <>
                  Negative amounts are allowed (e.g. an initiative that reduces
                  an expense account). They are spread and grouped the same
                  way.
                </>,
              ]}
            />
            <H3>Which accounts can I choose?</H3>
            <P>
              Every <em>active</em> Revenue and Expense account imported for
              the chosen company, listed with its Category so you can see
              where it will land on the statement. An account that was later
              deactivated in QuickBooks stays available on an initiative that
              already uses it. Because an initiative line is keyed by the
              account&rsquo;s full name, its amounts land{" "}
              <strong>in the same statement row and Category as that
              account&rsquo;s actuals</strong> — they are indistinguishable
              from grown baseline once approved.
            </P>
            <Callout>
              Initiatives have no customer, so they never create or affect an
              intercompany elimination. If an initiative is genuinely
              intercompany revenue, budget it net or leave it out.
            </Callout>
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section id="initiative-workflow" title="9. The initiative approval workflow">
            <P>
              Initiatives have three statuses. Only one of them touches the
              budget.
            </P>
            <Figure>
              proposed&nbsp;&nbsp;──approve──→&nbsp;&nbsp;approved&nbsp;&nbsp;(in budget, amounts locked)
              <br />
              &nbsp;&nbsp;&nbsp;│&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;│
              <br />
              &nbsp;&nbsp;&nbsp;│&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└── return to proposed ──┐
              <br />
              &nbsp;&nbsp;&nbsp;├──reject───→&nbsp;&nbsp;rejected&nbsp;&nbsp;(listed, not in budget)&nbsp;&nbsp;&nbsp;│
              <br />
              &nbsp;&nbsp;&nbsp;│&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└── return to proposed ──┤
              <br />
              &nbsp;&nbsp;&nbsp;└────────────────────────────────────────────────────┘
            </Figure>
            <MTable
              head={["Status", "In budget?", "Editable?", "Deletable?", "Actions offered"]}
              rows={[
                [
                  "Proposed",
                  "No — shown in the Proposed initiatives tile only",
                  "Yes (Edit)",
                  "Yes",
                  "Edit · Approve · Reject · Delete",
                ],
                [
                  "Approved",
                  "Yes — folded into its accounts' categories",
                  "No — amounts are locked",
                  "No — return to proposed first",
                  "Return to proposed",
                ],
                [
                  "Rejected",
                  "No",
                  "No",
                  "Yes",
                  "Return to proposed · Delete",
                ],
              ]}
            />
            <H3>Approving</H3>
            <P>
              Click <strong>Approve</strong> on a proposed initiative. Its
              status becomes <em>Approved — in budget</em>, the approver&rsquo;s
              name and the timestamp are stamped on it (shown under the status
              badge), and the statement and tiles update on the next render.
              The <em>Budgeted net income</em> tile then notes how much of the
              total comes from approved initiatives.
            </P>
            <H3>Why approved amounts are locked</H3>
            <P>
              Once leadership has approved a number, that number should not
              drift quietly. The database refuses any change to an approved
              (or rejected) initiative&rsquo;s account lines — the message
              reads <em>&ldquo;Initiative is approved; return it to proposed
              before editing its amounts&rdquo;</em>. To change it, click{" "}
              <strong>Return to proposed</strong>, edit, and approve again.
              Returning to proposed clears the approver stamp and takes the
              initiative out of the budget until it is re-approved.
            </P>
            <H3>Rejecting and deleting</H3>
            <P>
              <strong>Reject</strong> keeps the initiative on record (useful
              for &ldquo;we considered this and said no&rdquo;) without it
              touching the budget; it can be revived with Return to proposed.{" "}
              <strong>Delete</strong> removes an initiative permanently and
              asks for confirmation; it is offered only for proposed and
              rejected initiatives, so an approved number can never vanish in
              one click.
            </P>
            <H3>Audit trail</H3>
            <P>
              Every create, edit, approve, reject, return-to-proposed, and
              delete writes a row to the application&rsquo;s audit log with
              the actor, the initiative, and the before/after status. The
              initiative row itself shows the current approver.
            </P>
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section id="statement" title="10. Reading the budget statement">
            <P>
              The statement is the same component as the Income Statement, fed
              with budget cells instead of actuals, so everything you know
              from that page applies here.
            </P>
            <H3>Layout</H3>
            <MTable
              head={["Block", "Contents"]}
              rows={[
                [
                  "Income",
                  "Revenue categories, largest first, each expandable to its accounts. Total income closes the block.",
                ],
                [
                  "Direct Costs",
                  "Expense categories named Direct Costs / Direct Labor / Cost of Goods Sold / Cost of Sales / COGS, plus the Employee Benefits (Allocated) group. Shown only when at least one such category exists.",
                ],
                [
                  "Gross profit",
                  "Income − Direct Costs. Appears only when a Direct Costs block exists, so income is never mislabeled as gross profit.",
                ],
                [
                  "Operating Expenses (or Expenses)",
                  "Every other expense category, largest first; Uncategorized always last.",
                ],
                [
                  "Net income (before eliminations)",
                  "Income − Direct Costs − Operating Expenses, per column and in total.",
                ],
                [
                  "Intercompany eliminations",
                  "All-companies view only: the revenue lines backed out, and Net income after eliminations.",
                ],
              ]}
            />
            <H3>Cells and the % column</H3>
            <Ul
              items={[
                <>
                  Amounts are whole dollars; a dash means zero. Negative
                  amounts show in red.
                </>,
                <>
                  The small <strong>%</strong> after each amount is the
                  common-size view: that amount as a percent of the same
                  column&rsquo;s <em>total income</em>. On the Total column it
                  is percent of full-year income. It lets you check, for
                  instance, that direct labor stays at its historical share of
                  revenue after your growth assumptions.
                </>,
                <>
                  The <strong>Total</strong> column (Month and Quarter
                  layouts) is the full-year figure; it is omitted in Total
                  only, where the single column already is the year.
                </>,
                <>
                  Click a category row to expand its accounts; the count beside
                  the category name is how many accounts it holds. Rows inside
                  an expanded category include any approved-initiative amounts
                  for that account.
                </>,
              ]}
            />
            <H3>Employee Benefits allocation</H3>
            <P>
              Exactly as on the Income Statement, the direct-labor share of
              any category named <em>Employee Benefits</em> is reclassified
              into Direct Costs, column by column: moved = Employee Benefits ×
              Direct Labor ÷ (Direct Labor + Salaries &amp; Wages). The source
              category keeps its accounts plus a <em>&ldquo;Less: allocated to
              Direct Costs&rdquo;</em> line, and an <em>Employee Benefits
              (Allocated)</em> group appears under Direct Costs. Net income is
              unchanged by the move. Because it is computed on the budgeted
              numbers, a higher expense growth grows the allocation
              proportionally.
            </P>
            <H3>Intercompany eliminations (all companies)</H3>
            <P>
              When viewing all companies, revenue that one sister company
              bills to another is backed out below Net income so the
              consolidated result is not inflated. The budget applies the
              same two elimination lines as the Income Statement — revenue
              from Precision Paint / other enterprise customers, and revenue
              from the agency customer billed by anyone other than the billing
              agent — using the baseline&rsquo;s customer activity{" "}
              <strong>grown by that company&rsquo;s revenue growth %</strong>.
              The <em>Budgeted net income</em> tile shows the after-eliminations
              figure in this view.
            </P>
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section id="variance" title="11. Budget vs Actual">
            <P>
              Switch <strong>View</strong> to <em>Budget vs Actual</em> once the
              budget year is under way. The view compares the budget with the
              ledger through the <strong>last closed month</strong> — the
              in-progress month is always excluded, exactly as everywhere else
              in Financials, so a half-posted month never reads as a shortfall.
            </P>
            <MTable
              head={["Column", "Meaning"]}
              rows={[
                ["Full-year budget", `The complete ${year} budget for the row, same as the Total column of the Budget view.`],
                ["YTD <month> budget", "The budget for January through the last closed month only."],
                ["YTD <month> actual", "Posted ledger activity for the same months, grouped by the same categories."],
                ["Variance", "Favorable-positive, see below."],
                ["%", "Variance ÷ |YTD budget|. A dash when the YTD budget is zero or there is no variance."],
              ]}
            />
            <H3>Favorable-positive variance</H3>
            <P>
              Variance is always expressed so that <strong>a positive number is
              good news</strong>, whatever the row:
            </P>
            <Formulas
              rows={[
                ["Income & profit rows", "YTD actual − YTD budget"],
                ["Cost rows (Direct, Opex)", "YTD budget − YTD actual"],
              ]}
            />
            <P>
              Positive variances show in green, negative in red. Gross profit,
              Net income, and the eliminations rows follow the income rule.
            </P>
            <H3>Before the first month closes</H3>
            <P>
              Until January {year} has closed, Budget vs Actual shows an
              explanatory empty state and the Budget view carries the full
              plan. The Excel export falls back to the Budget sheet in the
              same situation.
            </P>
            <Callout>
              Growth edits re-price the budget columns in Budget vs Actual
              too, so you can test &ldquo;what growth rate would we have
              needed?&rdquo; against real results — save only if you mean
              to change the plan.
            </Callout>
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section id="math" title="12. How every number is calculated">
            <P>
              Every figure on the page and in the export comes from the same
              small set of rules, applied in this order.
            </P>
            <H3>1. Baseline cell</H3>
            <Formulas
              rows={[
                [
                  "baseline(account, m)",
                  `sum of posted ledger lines on that account in baseline month m (${baseFrom} – ${baseTo}), natural-signed`,
                ],
                ["budget month", "same calendar month of the budget year (Jul→Jul, Jan→Jan)"],
              ]}
            />
            <H3>2. Growth</H3>
            <Formulas
              rows={[
                ["factor (Revenue acct)", "1 + revenue growth % ÷ 100   (per company)"],
                ["factor (Expense acct)", "1 + expense growth % ÷ 100   (per company; direct costs included)"],
                ["grown(account, m)", "baseline(account, m) × factor"],
              ]}
            />
            <H3>3. Initiatives (approved only)</H3>
            <Formulas
              rows={[
                ["months", "13 − start month   (Jan = 12, Jul = 6, Dec = 1)"],
                ["per month", "annual amount ÷ months"],
                ["initiative(account, m)", "per month for every m from start month to 12; 0 before the start month"],
              ]}
            />
            <H3>4. Budget cell and columns</H3>
            <Formulas
              rows={[
                ["budget(account, m)", "grown(account, m) + Σ initiative(account, m) over approved initiatives"],
                ["Quarter column", "sum of its three months"],
                ["Total / Budget column", "sum of all twelve months"],
                ["% cell", "amount ÷ same column's total income"],
              ]}
            />
            <H3>5. Statement rollups (shared with the Income Statement)</H3>
            <Formulas
              rows={[
                ["Category", "Σ its accounts' budget cells"],
                ["Direct Costs", "Σ categories named Direct Costs / Direct Labor / COGS / Cost of Sales + Employee Benefits (Allocated)"],
                ["Benefits moved", "Employee Benefits × Direct Labor ÷ (Direct Labor + Salaries & Wages), per column, capped at 100%"],
                ["Gross profit", "Income − Direct Costs"],
                ["Net income", "Income − Direct Costs − Operating Expenses"],
              ]}
            />
            <H3>6. Eliminations (all companies)</H3>
            <Formulas
              rows={[
                ["elimination(m)", "− Σ baseline intercompany customer revenue × (1 + revenue growth %), per company"],
                ["Net income after", "Net income + Σ elimination lines"],
              ]}
            />
            <H3>7. Budget vs Actual</H3>
            <Formulas
              rows={[
                ["closed through", "last complete calendar month of the budget year (0 before January closes)"],
                ["YTD budget", "Σ budget(account, m) for m ≤ closed through"],
                ["YTD actual", "Σ posted ledger lines on the account for m ≤ closed through"],
                ["Variance (income)", "YTD actual − YTD budget"],
                ["Variance (cost)", "YTD budget − YTD actual"],
                ["Variance %", "Variance ÷ |YTD budget|"],
              ]}
            />
            <Callout>
              The screen and the Excel export run the exact same assembly on
              the exact same inputs. If a number on screen differs from the
              file, the only possible cause is an unsaved growth edit made
              between the two — and the file&rsquo;s Assumptions sheet labels
              that case explicitly.
            </Callout>
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section id="example" title="13. A worked example">
            <P>
              One company, one revenue account and one expense account, to
              make every step concrete. Suppose the baseline shows:
            </P>
            <MTable
              head={["Account", `Jul ${baseFromYear}`, `Jan ${baseToYear}`, "Baseline year total"]}
              rows={[
                ["400 Fabrication Revenue", `$${fmt(100000)}`, `$${fmt(80000)}`, `$${fmt(1200000)}`],
                ["710 Labor Cost", `$${fmt(40000)}`, `$${fmt(32000)}`, `$${fmt(480000)}`],
              ]}
            />
            <P>
              Set <strong>Revenue growth 5%</strong> and <strong>Expense
              growth 3%</strong>. The budget becomes:
            </P>
            <MTable
              head={["Account", `Jul ${year}`, `Jan ${year}`, `${year} total`]}
              rows={[
                ["400 Fabrication Revenue", `$${fmt(105000)}`, `$${fmt(84000)}`, `$${fmt(1260000)}`],
                ["710 Labor Cost", `$${fmt(41200)}`, `$${fmt(32960)}`, `$${fmt(494400)}`],
              ]}
            />
            <P>
              Now approve an initiative <em>&ldquo;Second shift&rdquo;</em>{" "}
              starting <strong>July</strong> with $120,000 of 400 Fabrication
              Revenue and $60,000 of 710 Labor Cost for the year. July to
              December is six months, so each month from July on gets
              $20,000 of revenue and $10,000 of labor; January is untouched:
            </P>
            <MTable
              head={["Account", `Jul ${year}`, `Jan ${year}`, `${year} total`]}
              rows={[
                ["400 Fabrication Revenue", `$${fmt(125000)}`, `$${fmt(84000)}`, `$${fmt(1380000)}`],
                ["710 Labor Cost", `$${fmt(51200)}`, `$${fmt(32960)}`, `$${fmt(554400)}`],
                ["Gross profit (if labor is a direct cost)", `$${fmt(73800)}`, `$${fmt(51040)}`, `$${fmt(825600)}`],
              ]}
            />
            <P>
              While the initiative was still <em>proposed</em>, the statement
              showed the second table and the <em>Proposed initiatives</em>{" "}
              tile read $60,000 (revenue 120,000 − expense 60,000). After
              approval the statement shows the third table and the{" "}
              <em>Budgeted net income</em> tile notes &ldquo;Includes $60,000
              from approved initiatives.&rdquo;
            </P>
            <P>
              Finally, suppose it is now April {year} (March is the last
              closed month) and the ledger shows $270,000 of fabrication
              revenue for January–March against a YTD budget of $252,000.
              Budget vs Actual shows a <strong>+$18,000 (+7.1%)</strong>{" "}
              variance in green for that account. If labor came in at
              $105,000 against a $98,880 YTD budget, that row shows{" "}
              <strong>−$6,120 (−6.2%)</strong> in red — cost over budget is
              unfavorable, hence negative.
            </P>
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section id="export" title="14. Exporting to Excel & printing">
            <P>
              <strong>Export Excel</strong> in the header downloads a workbook
              named{" "}
              <em>budget-{year}-&lt;company&gt;-by-&lt;month|quarter|total&gt;.xlsx</em>{" "}
              (or <em>…-vs-actual.xlsx</em> in Budget vs Actual). It honors
              the current Company, View, and Columns filters{" "}
              <strong>and the growth percentages currently on screen, saved
              or not</strong>, so the file is always what you were looking at.
            </P>
            <MTable
              head={["Sheet", "Contents"]}
              rows={[
                [
                  "Budget (or Budget vs Actual)",
                  "The statement with every category expanded to its accounts as grouped outline rows (collapse them with Excel's outline buttons). Budget: amount and % pairs per column plus Total. Budget vs Actual: full-year budget, YTD budget, YTD actual, variance, variance %. A notes line records company, baseline window, growth status, and the number of approved initiatives.",
                ],
                [
                  "Assumptions",
                  "Each company's revenue and expense growth with a Status of Saved or Unsaved (as shown on screen).",
                ],
                [
                  "Initiatives",
                  "Every initiative for the selected companies — approved first — with company, status, start month, approver, revenue, expense, and net, expanding to its account lines.",
                ],
              ]}
            />
            <Callout>
              Exporting never saves anything. If you export a scenario with
              unsaved growth, the Assumptions sheet says so — share it as a
              scenario, not as the plan of record, until you click Save
              changes.
            </Callout>
            <H3>Printing</H3>
            <P>
              The Budget page prints as shown. For a clean handout, choose{" "}
              <em>Total only</em> columns and expand the categories you want
              visible, then use your browser&rsquo;s print dialog. This
              manual prints with the <em>Print / Save PDF</em> button at the
              top.
            </P>
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section id="prep" title="15. Preparing the data: categories & syncs">
            <P>
              The budget inherits two things from the rest of Financials.
              Getting them right first saves rework.
            </P>
            <H3>Categories (Chart of Accounts)</H3>
            <Ul
              items={[
                <>
                  Open <strong>Financials → Chart of Accounts</strong> and give
                  every income and expense account a <strong>Category</strong>.
                  Accounts left blank fall under <em>Uncategorized</em> on both
                  the Income Statement and the Budget.
                </>,
                <>
                  Name the cost-of-revenue category <em>Direct Costs</em> (or
                  Direct Labor / Cost of Goods Sold / Cost of Sales / COGS) so
                  the statement shows a Gross profit line.
                </>,
                <>
                  Categories named <em>Employee Benefits</em> and <em>Salaries
                  &amp; Wages</em>, together with the direct-labor account (710
                  Labor Cost or any account containing &ldquo;Direct
                  Labor&rdquo;), drive the benefits allocation.
                </>,
                <>
                  Categories survive syncs and apply to every month, past and
                  budget. Changing one re-groups the budget on the next load.
                </>,
              ]}
            />
            <H3>Ledger syncs</H3>
            <Ul
              items={[
                <>
                  The baseline and the actuals come from the imported general
                  ledger. The nightly QuickBooks sync refreshes it every
                  morning; an admin can also run <strong>Sync general
                  ledger</strong> on the Settings page at any time.
                </>,
                <>
                  If the Budget page shows <em>&ldquo;No baseline ledger
                  data&rdquo;</em>, the ledger for {baseFrom} – {baseTo} has
                  not been imported yet. Run the general-ledger sync and
                  reload.
                </>,
                <>
                  Ledger months before 2025 are frozen, audited history and are
                  never re-fetched; everything in the baseline window is
                  refreshed on each sync.
                </>,
              ]}
            />
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section id="process" title="16. A recommended budgeting process">
            <P>
              The module supports many ways of working. This sequence gets a
              defensible budget in front of leadership with the least
              back-and-forth.
            </P>
            <Steps
              items={[
                <>
                  <strong>Clean the chart of accounts.</strong> Review
                  categories on the Chart of Accounts page; confirm Gross
                  profit appears on the Income Statement and the benefits
                  allocation looks right. Do this before anyone sees a budget
                  number.
                </>,
                <>
                  <strong>Review the baseline.</strong> Open the Budget with
                  every growth % at 0 (Reset to baseline). This is last
                  year&rsquo;s shape projected forward. Look for one-time
                  items in the baseline — a large insurance recovery, a
                  write-off — that should not repeat. You cannot remove them
                  from the baseline, but you can offset them with a negative
                  initiative (e.g. &ldquo;Remove {baseToYear} one-time
                  settlement&rdquo;) so the adjustment is explicit and
                  approved.
                </>,
                <>
                  <strong>Set growth per company.</strong> Agree revenue and
                  expense growth with each company&rsquo;s leader. Use the
                  live preview in the meeting; save when agreed.
                </>,
                <>
                  <strong>Collect initiatives as proposed.</strong> Have each
                  leader enter their initiatives with a clear description and
                  realistic start month. Leave them proposed. The{" "}
                  <em>Proposed initiatives</em> tile becomes the agenda for the
                  approval meeting.
                </>,
                <>
                  <strong>Approve or reject in one sitting.</strong> Walk the
                  New initiatives panel top to bottom. Approve what is funded,
                  reject what is not (keep it on record), and return to
                  proposed anything that needs rework.
                </>,
                <>
                  <strong>Export the plan of record.</strong> With all growth
                  saved and initiatives decided, export All companies by Month
                  and by Total. The Assumptions sheet should read{" "}
                  <em>Saved</em> on every line.
                </>,
                <>
                  <strong>Review monthly.</strong> Once January closes, switch
                  to Budget vs Actual at each month-end close. Investigate red
                  variances by expanding the category to its accounts, then
                  drill into the actuals on the Income Statement or Financials
                  pages.
                </>,
              ]}
            />
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section id="faq" title="17. Troubleshooting & FAQ">
            <div className="space-y-4">
              <Faq
                q="I changed a growth % and the numbers moved, but after reloading they went back. Why?"
                a="Edits re-price the page live but are not stored until you click Save changes in the bar under the growth fields. Reloading, or clicking Revert, discards unsaved edits."
              />
              <Faq
                q="I approved an initiative and the statement did not change."
                a="Check the Company filter — an initiative only appears in the view of its own company or All companies. If the filter is right, the amounts may land in a category you have collapsed; expand it or use Expand all."
              />
              <Faq
                q="Edit is missing on an initiative."
                a="Only proposed initiatives can be edited. Approved and rejected initiatives offer Return to proposed instead; use that, edit, then approve again."
              />
              <Faq
                q="Delete is missing on an initiative."
                a="Approved initiatives cannot be deleted directly, so an approved number never disappears in one click. Return it to proposed first, then delete."
              />
              <Faq
                q="The page says “No baseline ledger data.”"
                a={`The general ledger for ${baseFrom} – ${baseTo} has not been imported for the selected company. An admin should run Sync general ledger on the Settings page, or wait for the nightly sync, then reload.`}
              />
              <Faq
                q="Budget vs Actual says “No actuals yet.”"
                a={`No month of ${year} has closed. The view activates once January ${year} is complete; the in-progress month is never compared.`}
              />
              <Faq
                q="There is no Gross profit line."
                a="No expense account carries a direct-cost category. On the Chart of Accounts page, name the relevant category Direct Costs (or Direct Labor / Cost of Goods Sold / Cost of Sales / COGS)."
              />
              <Faq
                q="A big one-time item from last year is inflating the baseline."
                a="The baseline is the ledger as posted and cannot be edited here. Add a negative initiative on the same account for the same amount, describe why, and approve it — the adjustment is then explicit, attributed, and reversible."
              />
              <Faq
                q="Why does the Direct Costs block contain “Employee Benefits (Allocated)”?"
                a="The direct-labor share of the Employee Benefits category is reclassified above Gross profit, exactly as on the Income Statement. The source category shows a matching “Less: allocated to Direct Costs” line, so Net income is unchanged."
              />
              <Faq
                q="The eliminations disappeared when I picked one company."
                a="Intercompany eliminations are a consolidation adjustment and only make sense across companies, so they show in the All companies view only."
              />
              <Faq
                q="Why is a cost variance negative when we spent more than budget?"
                a="Variance is favorable-positive on every row. For cost rows it is budget − actual, so overspending is negative (red) and underspending positive (green)."
              />
              <Faq
                q="My export does not match a colleague's."
                a="The export carries the growth % on screen at the moment of export, saved or not. Compare the Assumptions sheets — one of them probably says Unsaved. Save changes (or Revert) and export again."
              />
              <Faq
                q="Can I budget balance sheet accounts or cash?"
                a="No. The budget covers Revenue and Expense accounts only — it is a profit-and-loss budget in the Income Statement's layout."
              />
              <Faq
                q="Can I budget a different year?"
                a={`The budget year is fixed at ${year} in the application and rolls forward with a code update. Growth assumptions and initiatives are stored per year, so each year starts clean.`}
              />
              <Faq
                q="Who can see the budget?"
                a="Admins only — the same access as the general ledger it is built from. Other roles do not see the Budget entry in the sidebar and are refused if they open the address."
              />
            </div>
          </Section>
        </div>

        <footer className="mt-10 border-t border-line pt-4 text-xs text-ink-400">
          SMW Job Plans — Budget module user manual. The budget year, baseline
          window, and growth limits quoted here are read from the live
          application, so they always match the Budget page. Baseline
          seasonality, growth, initiative spreading, categories, benefits
          allocation, and eliminations follow the rules in sections 6–12;
          the Budget page footnote restates them in brief.
        </footer>
      </article>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Typography helpers — same set as the Job Plan Wizard and Barge manuals so
   the three read as one document family.
--------------------------------------------------------------------------- */

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

function MTable({ head, rows }: { head: string[]; rows: string[][] }) {
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
            <dt className="w-44 flex-none font-semibold text-ink-900">
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
   Illustrations — static reproductions of the Budget UI, built with the same
   design tokens as the live components so they match the app and print
   cleanly. Purely decorative: nothing here is interactive.
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

function MockPct({ value, changed = false }: { value: string; changed?: boolean }) {
  return (
    <span className="relative inline-block">
      <span
        className={`inline-block w-20 rounded-md border py-1 pr-6 pl-2 text-right text-xs tabular-nums text-ink-900 ${
          changed ? "border-warn-700/50 bg-amber-50" : "border-line bg-white"
        }`}
      >
        {value}
      </span>
      <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[0.65rem] text-ink-400">
        %
      </span>
    </span>
  );
}

function MockAssumptions() {
  const btn =
    "inline-flex items-center rounded-md border border-line bg-white px-2.5 py-1 text-xs font-medium text-ink-900";
  return (
    <div className="min-w-[36rem] rounded-xl border border-line bg-white text-sm">
      <div className="flex items-center justify-between border-b border-line/70 px-4 py-2">
        <span className="text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
          Growth assumptions
        </span>
        <span className="flex items-center gap-2">
          <span className={btn}>Reset to baseline</span>
          <span className="inline-flex items-center rounded-md bg-navy-900 px-2.5 py-1 text-xs font-medium text-white">
            + New Initiative
          </span>
        </span>
      </div>
      <div className="divide-y divide-line/70">
        <div className="flex items-center gap-6 px-4 py-2">
          <span className="min-w-40 text-xs font-medium text-ink-900">Superior Marine</span>
          <span className="flex items-center gap-2 text-xs text-ink-600">
            Revenue growth <MockPct value="5" changed />
          </span>
          <span className="flex items-center gap-2 text-xs text-ink-600">
            Expense growth <MockPct value="3" />
          </span>
        </div>
        <div className="flex items-center gap-6 px-4 py-2">
          <span className="min-w-40 text-xs font-medium text-ink-900">Precision Paint</span>
          <span className="flex items-center gap-2 text-xs text-ink-600">
            Revenue growth <MockPct value="2" />
          </span>
          <span className="flex items-center gap-2 text-xs text-ink-600">
            Expense growth <MockPct value="2" />
          </span>
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-warn-700/25 bg-amber-50 px-4 py-2 text-xs text-amber-800">
        <span>
          Unsaved changes for Superior Marine — the budget below reflects them.
          Save changes or revert?
        </span>
        <span className="flex items-center gap-2">
          <span className={btn}>Revert</span>
          <span className="inline-flex items-center rounded-md bg-navy-900 px-2.5 py-1 text-xs font-medium text-white">
            Save changes
          </span>
        </span>
      </div>
    </div>
  );
}

function MockInitiativeDialog() {
  const field =
    "block w-full rounded-md border border-line bg-white px-2.5 py-1 text-xs text-ink-900";
  const label = (t: string) => (
    <span className="mb-0.5 block text-[0.62rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
      {t}
    </span>
  );
  const row = (name: string, cat: string, amt: string) => (
    <div className="flex items-center justify-between px-3 py-1 text-xs">
      <span className="text-ink-900">
        {name} <span className="ml-1 text-ink-400">{cat}</span>
      </span>
      <span className="inline-block w-28 rounded-md border border-line bg-white px-2 py-0.5 text-right tabular-nums text-ink-900">
        {amt}
      </span>
    </div>
  );
  return (
    <div className="min-w-[34rem] rounded-xl border border-line bg-white text-sm shadow-sm">
      <div className="border-b border-line px-4 py-2 text-sm font-semibold text-ink-900">
        New initiative
      </div>
      <div className="grid gap-2 border-b border-line px-4 py-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          {label("Name")}
          <span className={field}>Second paint crew</span>
        </div>
        <div>
          {label("Company")}
          <span className={field}>Precision Paint</span>
        </div>
        <div>
          {label("Starts")}
          <span className={field}>Jul {BUDGET_YEAR}</span>
        </div>
      </div>
      <div className="border-b border-line/70 px-4 py-1.5 text-[0.65rem] text-ink-400">
        Enter the expected amount for {BUDGET_YEAR} in each account; it is
        spread evenly from the start month through December.
      </div>
      <div className="bg-surface/50 px-3 py-1 text-[0.62rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
        Expected revenue
      </div>
      {row("400 Painting Revenue", "Sales", "240,000")}
      <div className="bg-surface/50 px-3 py-1 text-[0.62rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
        Expected expense
      </div>
      {row("710 Labor Cost", "Direct Costs", "120,000")}
      {row("720 Materials", "Direct Costs", "45,000")}
      <div className="flex items-center justify-between border-t border-line px-4 py-2 text-xs text-ink-600">
        <span>
          Revenue <span className="font-medium text-ink-900">$240,000</span> ·
          Expense <span className="font-medium text-ink-900">$165,000</span> ·
          Net <span className="font-semibold text-ink-900">$75,000</span>
        </span>
        <span className="inline-flex items-center rounded-md bg-navy-900 px-2.5 py-1 text-xs font-medium text-white">
          Save as proposed
        </span>
      </div>
    </div>
  );
}
