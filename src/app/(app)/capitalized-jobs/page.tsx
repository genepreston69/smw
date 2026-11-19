import Link from "next/link";
import {
  Building2,
  CheckCircle2,
  Download,
  HandCoins,
  HardHat,
  Layers,
  ScrollText,
  Wrench,
} from "lucide-react";
import { requireUser } from "@/lib/auth";
import { money } from "@/lib/format";
import { monthLabel } from "@/lib/financials";
import {
  capLaborHref,
  capLaborPeriod,
  CAP_LABOR_BUCKET_LABELS,
  type CapLaborPeriodParams,
} from "@/lib/capitalizedLabor";
import {
  canApproveCapJobs,
  capJobRows,
  capJobTab,
  capJobTabRows,
  capJobTotal,
  type CapJobTab,
  capJobApprovalsErrorMessage,
  capJobsByMonth,
  capJobsErrorMessage,
  CAP_JOB_KINDS,
  CAP_JOB_KIND_ACCOUNTS,
  CAP_JOB_KIND_LABELS,
} from "@/lib/capitalizedJobs";
import { loadCapJobs, type CapJobs } from "@/lib/capitalizedJobsServer";
import {
  Card,
  CardTitle,
  EmptyState,
  PageHeader,
  StatTile,
  Table,
  Th,
  buttonCls,
} from "@/components/ui";
import { CapJobRows } from "./CapJobRows";
import { PeriodPicker } from "./PeriodPicker";

const PATH = "/capitalized-jobs";

const EMPTY: CapJobs = {
  jobs: new Map(),
  lines: [],
  benefits: [],
  benefitError: null,
  approvals: new Map(),
  approvalsError: null,
  multiCompany: false,
};

// The direct cost posted to non-billable (EQP) and intercompany jobs — labor
// and the other Direct Cost accounts, one column each — for a calendar year,
// a month, or a month range. Replaces Capitalized Labor and Capitalized
// Materials. Which lines count is cap_job_lines (migration 0044).
export default async function CapitalizedJobsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string } & CapLaborPeriodParams>;
}) {
  const { tab, ...periodParams } = await searchParams;
  const activeTab = capJobTab(tab);

  // One calendar year, one month, or a month range — the current year to
  // date by default. Lines outside it are never read, so they can't move any
  // number on the page.
  const period = capLaborPeriod(periodParams);

  // Tab links keep the period; period links keep the tab.
  const tabParam = activeTab === "all" ? null : activeTab;
  const href = (t: CapJobTab) =>
    capLaborHref(PATH, period.params, { tab: t === "all" ? null : t });
  const exportQuery = capLaborHref("", period.params);

  const { supabase, profile } = await requireUser();
  // A failed read renders as a banner, not a 500 — and is logged, since a
  // banner leaves no trace in the platform logs otherwise. Code can reach
  // production before migration 0044 is applied; the banner names it.
  const { loaded, loadError } = await loadCapJobs(supabase, period).then(
    (data) => ({ loaded: data, loadError: null as string | null }),
    (e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`Capitalized Jobs: load failed: ${message}`);
      return { loaded: EMPTY, loadError: capJobsErrorMessage(message) };
    },
  );
  const { jobs, lines, benefits, benefitError, approvals, multiCompany: showCompany } = loaded;
  // Code can reach production before migration 0045: name it, and disable
  // the boxes rather than show every job as unapproved.
  const approvalsError = loaded.approvalsError
    ? capJobApprovalsErrorMessage(loaded.approvalsError)
    : null;
  if (loaded.approvalsError) {
    console.error(`Capitalized Jobs: approvals read failed: ${loaded.approvalsError}`);
  }
  if (benefitError) {
    console.error(`Capitalized Jobs: benefit allocation read failed: ${benefitError}`);
  }

  // Candidate jobs with direct cost in the period, biggest dollars first.
  const candidates = capJobRows(jobs, lines, benefits, approvals);
  const nonBillable = candidates.filter((c) => c.bucket === "nonbillable");
  const intercompany = candidates.filter((c) => c.bucket === "intercompany");
  const approvedRows = capJobTabRows(candidates, "approved");
  const rows = capJobTabRows(candidates, activeTab);

  const all = capJobTotal(candidates);
  const shown = capJobTotal(rows);

  // The period month by month, for the jobs on the active tab. A one-month
  // period has nothing to break down, so the card is left out.
  const visibleJobs = new Set(rows.map((r) => r.id));
  const byMonth =
    period.fromMonth === period.toMonth
      ? null
      : capJobsByMonth(period, lines, benefits, (jobId) => visibleJobs.has(jobId));

  const periodLabel = period.label;
  const plural = (n: number) => `${n} job${n === 1 ? "" : "s"}`;

  const tabCls = (active: boolean) =>
    `rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
      active
        ? "bg-navy-900 text-white"
        : "text-ink-600 hover:bg-surface hover:text-ink-900"
    }`;

  return (
    <div>
      <PageHeader
        title="Capitalized Jobs"
        subtitle={`The direct cost posted to non-billable (EQP) or intercompany jobs — labor, contract service, fuel & oil, material and freight that may belong in a capital account rather than job cost — for ${period.label}. Pick a year, a month, or a range of months below. Cost moved to an asset account counts as already capitalized; the net is what still awaits review. Click a job to see its transactions, and see the methodology summary at the bottom of the page.`}
        action={
          <div className="flex gap-2">
            <a
              href={`/api/export/capitalized-jobs-workbook${exportQuery}`}
              className={buttonCls("secondary")}
            >
              <Download size={15} strokeWidth={2} />
              Download Excel
            </a>
            <a
              href={`/api/export/capitalized-jobs${exportQuery}`}
              className={buttonCls("secondary")}
            >
              <Download size={15} strokeWidth={2} />
              Download CSV
            </a>
          </div>
        }
      />

      <PeriodPicker path={PATH} period={period} keep={{ tab: tabParam }} />

      {loadError && (
        <p className="mb-6 rounded-lg border border-warn-700/25 bg-warn-50 px-4 py-3 text-sm text-warn-700">
          {loadError}
        </p>
      )}

      {approvalsError && (
        <p className="mb-6 rounded-lg border border-warn-700/25 bg-warn-50 px-4 py-3 text-sm text-warn-700">
          {approvalsError}
        </p>
      )}

      {benefitError && (
        // Never let a failed allocation read read as "no benefits allocated".
        <p className="mb-6 rounded-lg border border-warn-700/25 bg-warn-50 px-4 py-3 text-sm text-warn-700">
          Benefit allocation couldn&rsquo;t be loaded, so those columns are
          blank: {benefitError}
        </p>
      )}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatTile
          label={`Cost posted (${periodLabel})`}
          value={money(all.posted)}
          hint="labor, contract service, fuel & oil, material and freight, net of credits"
          icon={Layers}
        />
        <StatTile
          label={`Already capitalized (${periodLabel})`}
          value={money(all.capitalized)}
          hint="cost credited off to an asset account"
          icon={CheckCircle2}
        />
        <StatTile
          label={`Awaiting review (${periodLabel})`}
          value={money(all.net)}
          hint={`net across ${plural(candidates.length)}`}
          icon={HardHat}
        />
        <StatTile
          label="Non-billable (EQP)"
          value={money(capJobTotal(nonBillable).net)}
          hint={`net, ${plural(nonBillable.length)}`}
          icon={Wrench}
        />
        <StatTile
          label="Intercompany"
          value={money(capJobTotal(intercompany).net)}
          hint={`net, ${plural(intercompany.length)}`}
          icon={Building2}
        />
        <StatTile
          label={`Transactions (${periodLabel})`}
          value={all.txns}
          hint="bills, purchases, credits and journal entries on candidate jobs"
          icon={ScrollText}
        />
        <StatTile
          label={`Benefit allocation (${periodLabel})`}
          value={money(all.benefits)}
          hint="direct-labor share of employee benefits, candidate jobs"
          icon={HandCoins}
        />
      </div>

      <div className="mb-4 flex w-fit gap-1 rounded-lg border border-line bg-white p-1">
        <Link href={href("all")} className={tabCls(activeTab === "all")}>
          All ({candidates.length})
        </Link>
        <Link href={href("nonbillable")} className={tabCls(activeTab === "nonbillable")}>
          {CAP_LABOR_BUCKET_LABELS.nonbillable} ({nonBillable.length})
        </Link>
        <Link href={href("intercompany")} className={tabCls(activeTab === "intercompany")}>
          {CAP_LABOR_BUCKET_LABELS.intercompany} ({intercompany.length})
        </Link>
        <Link href={href("approved")} className={tabCls(activeTab === "approved")}>
          Approved ({approvedRows.length})
        </Link>
      </div>

      {byMonth && (
        <Card className="mb-6" pad={false}>
          <div className="px-6 pt-5">
            <CardTitle>By month</CardTitle>
          </div>
          <Table
            head={
              <tr>
                <Th>Month</Th>
                <Th right>Jobs</Th>
                <Th right>Transactions</Th>
                {CAP_JOB_KINDS.map((k) => (
                  <Th key={k} right>
                    {CAP_JOB_KIND_LABELS[k]}
                  </Th>
                ))}
                <Th right>Total cost</Th>
                <Th right>Already capitalized</Th>
                <Th right>Awaiting review</Th>
                <Th right>Benefit allocation</Th>
              </tr>
            }
          >
            {byMonth.rows.map((m) => (
              <tr key={m.month} className="hover:bg-surface/60">
                <td className="px-4 py-2.5 font-medium">
                  {/* Each month opens that month on its own. */}
                  <Link
                    href={capLaborHref(PATH, { month: m.month }, { tab: tabParam })}
                    className="text-ink-900 hover:text-brand-700"
                  >
                    {monthLabel(m.month)}
                  </Link>
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-ink-600">{m.jobs || "—"}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-ink-600">{m.txns || "—"}</td>
                {CAP_JOB_KINDS.map((k) => (
                  <td key={k} className="px-4 py-2.5 text-right tabular-nums text-ink-600">
                    {m[k] ? money(m[k]) : "—"}
                  </td>
                ))}
                <td className="px-4 py-2.5 text-right tabular-nums text-ink-600">
                  {m.txns ? money(m.posted) : "—"}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-ink-600">
                  {m.capitalized ? money(m.capitalized) : "—"}
                </td>
                <td className="px-4 py-2.5 text-right font-medium tabular-nums text-ink-900">
                  {m.txns ? money(m.net) : "—"}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-ink-600">
                  {m.benefits ? money(m.benefits) : "—"}
                </td>
              </tr>
            ))}
            <tr className="border-t-2 border-line font-semibold text-ink-900">
              <td className="px-4 py-2.5">Total</td>
              <td className="px-4 py-2.5 text-right tabular-nums">{byMonth.total.jobs}</td>
              <td className="px-4 py-2.5 text-right tabular-nums">{byMonth.total.txns}</td>
              {CAP_JOB_KINDS.map((k) => (
                <td key={k} className="px-4 py-2.5 text-right tabular-nums">
                  {money(byMonth.total[k])}
                </td>
              ))}
              <td className="px-4 py-2.5 text-right tabular-nums">{money(byMonth.total.posted)}</td>
              <td className="px-4 py-2.5 text-right tabular-nums">{money(byMonth.total.capitalized)}</td>
              <td className="px-4 py-2.5 text-right tabular-nums">{money(byMonth.total.net)}</td>
              <td className="px-4 py-2.5 text-right tabular-nums">{money(byMonth.total.benefits)}</td>
            </tr>
          </Table>
        </Card>
      )}

      {/* clip off so the sticky header can escape the card while scrolling */}
      <Card pad={false} clip={false}>
        {rows.length === 0 ? (
          activeTab === "approved" ? (
            <EmptyState icon={CheckCircle2} title={`No approved jobs with cost in ${period.label}`}>
              Tick the Approved box on a job to list it here. Approved jobs
              appear when they have direct cost in the selected period.
            </EmptyState>
          ) : (
            <EmptyState icon={HardHat} title={`No capitalized job costs in ${period.label}`}>
              Labor, contract service, fuel &amp; oil, material and freight
              posted to non-billable (EQP) or intercompany jobs will appear
              here. Pick another period above, or connect QuickBooks in
              Settings and run a sync.
            </EmptyState>
          )
        ) : (
          <Table
            stickyHeader
            head={
              <tr>
                <Th>Approved</Th>
                <Th>Job</Th>
                {showCompany && <Th>QB Company</Th>}
                <Th>Customer</Th>
                <Th>Type</Th>
                <Th right>Transactions</Th>
                <Th right>Latest</Th>
                {CAP_JOB_KINDS.map((k) => (
                  <Th key={k} right>
                    {CAP_JOB_KIND_LABELS[k]}
                  </Th>
                ))}
                <Th right>Total cost</Th>
                <Th right>Already capitalized</Th>
                <Th right>Awaiting review</Th>
                <Th right>Benefit allocation</Th>
              </tr>
            }
          >
            {/* Keyed by period so expanded jobs reload for a new period. */}
            <CapJobRows
              key={period.fileTag}
              jobs={rows}
              showCompany={showCompany}
              period={period.params}
              canApprove={canApproveCapJobs(profile.role)}
              approvalsUnavailable={approvalsError != null}
            />
            <tr className="border-t-2 border-line font-semibold text-ink-900">
              <td className="px-4 py-3" colSpan={showCompany ? 5 : 4}>
                Total
              </td>
              <td className="px-4 py-3 text-right tabular-nums">{shown.txns}</td>
              <td className="px-4 py-3" />
              {CAP_JOB_KINDS.map((k) => (
                <td key={k} className="px-4 py-3 text-right tabular-nums">
                  {money(shown[k])}
                </td>
              ))}
              <td className="px-4 py-3 text-right tabular-nums">{money(shown.posted)}</td>
              <td className="px-4 py-3 text-right tabular-nums">{money(shown.capitalized)}</td>
              <td className="px-4 py-3 text-right tabular-nums">{money(shown.net)}</td>
              <td className="px-4 py-3 text-right tabular-nums">{money(shown.benefits)}</td>
            </tr>
          </Table>
        )}
      </Card>

      <Card className="mt-6">
        <CardTitle>Methodology</CardTitle>
        <div className="grid gap-x-8 gap-y-5 text-sm text-ink-600 lg:grid-cols-2">
          <div>
            <h3 className="mb-1 font-semibold text-ink-900">1. What counts</h3>
            <p>
              Bills, purchases, vendor credits and journal entries imported
              from QuickBooks, tagged to the job, that post to one of the{" "}
              <strong>Direct Cost</strong> accounts or a sub-account of one:{" "}
              {CAP_JOB_KINDS.map((k) => CAP_JOB_KIND_ACCOUNTS[k]).join(", ")}.
              Each has its own column. Expenses on any other account are not
              counted, and neither are lines that posted to a balance-sheet
              account (a purchase straight into inventory or a fixed asset was
              never expensed). Time entries are excluded — they post nothing
              to the ledger. Refunds, vendor credits, reversals and
              corrections net against the cost posted. Only lines dated in
              the <strong>selected period</strong> — the current calendar year
              to date unless you pick a year, a month, or a range of months,
              back to January 2023 — are counted: the page, the transaction
              drill-down, and both downloads alike.
            </p>
          </div>
          <div>
            <h3 className="mb-1 font-semibold text-ink-900">2. Labor</h3>
            <p>
              The Labor column is everything posted to {CAP_JOB_KIND_ACCOUNTS.labor},
              plus journal-entry lines on any other expense account for{" "}
              <strong>wages</strong> or the{" "}
              <strong>employer&rsquo;s share of payroll taxes</strong> (FICA,
              Medicare, FUTA, SUTA, unemployment) — the payroll allocations
              (e.g. Paychex) posted per job. Withholdings from the
              employee&rsquo;s check, and every other payroll liability, are
              balance-sheet lines and never count, debit or credit. Payroll
              service fees are excluded.
            </p>
          </div>
          <div>
            <h3 className="mb-1 font-semibold text-ink-900">
              3. Which jobs qualify
            </h3>
            <p>
              Jobs named <em>EQP…</em> (internal equipment work) bucket as
              Non-Billable; jobs whose customer is a sister company bucket as
              Intercompany. Transportation jobs (names ending LH, HS, FL, BC)
              are operating work and never qualify. Precision Paint jobs for
              Superior Marine Ways are excluded — those allocations are
              capitalized wages, already handled. Only jobs with direct cost
              in the selected period are listed.
            </p>
          </div>
          <div>
            <h3 className="mb-1 font-semibold text-ink-900">
              4. How &ldquo;already capitalized&rdquo; is detected
            </h3>
            <p>
              A capitalization entry credits the cost accounts and debits a
              capital asset. The asset account varies by equipment and job, so
              an entry counts as capitalization when any of its lines debits a{" "}
              <em>Fixed Asset</em> or <em>Other Asset</em> account, whatever
              its name. <strong>Already capitalized</strong> totals the
              job-tagged credits on those entries across all five columns, and{" "}
              <strong>Awaiting review</strong> is total cost minus already
              capitalized — what may still belong in a capital account. A
              credit posted without the job tag won&rsquo;t appear on this
              page; the asset side of such entries is visible on the
              Financials page.
            </p>
          </div>
          <div>
            <h3 className="mb-1 font-semibold text-ink-900">
              5. Benefit allocation
            </h3>
            <p>
              The direct-labor share of Employee Benefits attributed to each
              job — the same figure as the Jobs dashboard column: per company
              per month, Employee Benefits &times; Direct Labor &divide;
              (Direct Labor + Salaries &amp; Wages) from the Income Statement,
              distributed across jobs pro-rata by direct-labor cost, summed
              over the months of the selected period (a partial month counts
              in full). It is shown for context — a capitalization entry may
              need to carry this burden along with the labor. It is not
              included in the Awaiting review amounts.
            </p>
          </div>
          <div>
            <h3 className="mb-1 font-semibold text-ink-900">
              6. Traceability
            </h3>
            <p>
              Every line carries its QuickBooks document number so it traces
              back to the exact bill, purchase or journal entry. Item lines
              imported before 2025 can&rsquo;t be traced to an account and
              count as Material; that history also predates vendor-credit
              import, so 2023–2024 figures are an upper bound. This page is
              read-only: record the capitalization entry in QuickBooks
              (tagging the job on the credit line), run a sync, and the
              amounts here update automatically.
            </p>
          </div>
          <div>
            <h3 className="mb-1 font-semibold text-ink-900">7. Approved</h3>
            <p>
              Approvers and admins tick <strong>Approved</strong> to record
              that a job has been signed off for capitalization; the box shows
              who approved it and when, and the Approved tab lists those jobs.
              The approval belongs to the job, not to a period: it stays on
              whichever year, month or range is selected until someone clears
              it. It changes no amounts — approved jobs stay in the other tabs
              and totals — and every approval and clearing is written to the
              audit log.
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}
