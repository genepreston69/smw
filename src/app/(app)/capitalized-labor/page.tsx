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
import { fetchAllRows } from "@/lib/supabase/fetchAll";
import { money } from "@/lib/format";
import {
  capLaborAmounts,
  capLaborBucket,
  capLaborWindow,
  CAP_LABOR_BUCKET_LABELS,
  type CapLaborBucket,
} from "@/lib/capitalizedLabor";
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
import { CapLaborRows, type CapLaborRowData } from "./CapLaborRows";

interface JobRow {
  id: string;
  name: string;
  realm_id: string | null;
  customer: { display_name: string; company_name: string | null } | null;
}

export default async function CapitalizedLaborPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  const activeTab: CapLaborBucket | "all" =
    tab === "nonbillable" || tab === "intercompany" ? tab : "all";

  const href = (t: CapLaborBucket | "all") =>
    t === "all" ? "/capitalized-labor" : `/capitalized-labor?tab=${t}`;

  // Capitalized labor is calculated for the calendar year to date only —
  // Jan 1 through today. Earlier entries are never read, so they can't move
  // any number on the page.
  const ytd = capLaborWindow();

  const { supabase } = await requireUser();
  // Paged reads (fetchAllRows) so nothing is cut off at Supabase's 1000-row
  // cap; .order("id") tie-breaks for stable pages.
  const [jobData, { data: connRows }, lineRows, { data: benefitData, error: benefitError }] =
    await Promise.all([
      fetchAllRows((from, to) =>
        supabase
          .from("jobs")
          .select(
            "id, name, realm_id, customer:customers(display_name, company_name)",
          )
          .order("name")
          .order("id")
          .range(from, to),
      ),
      supabase.from("qb_connection_status").select("realm_id, company_name"),
      // Counted journal lines only — wages and employer taxes, each tagged
      // posted or capitalized; withholdings never appear (migration 0030).
      fetchAllRows((from, to) =>
        supabase
          .from("cap_labor_lines")
          .select("id, job_id, qb_txn_id, txn_date, amount, treatment")
          .gte("txn_date", ytd.from)
          .lte("txn_date", ytd.to)
          .order("id")
          .range(from, to),
      ),
      // Employee-benefit allocation per job — the same figure as the Jobs
      // dashboard's column — summed over the year to date in one statement
      // (migration 0024). It is month-grain, so the current month counts in
      // full. Reading the month-grain view row by row instead re-ran the
      // whole allocation once per page of results, which blew the statement
      // timeout.
      supabase.rpc("job_benefit_allocation_summary", {
        p_from: ytd.from,
        p_to: ytd.toMonth,
      }),
    ]);

  const companyByRealm = new Map(
    (connRows ?? []).map((c) => [c.realm_id as string, c.company_name as string | null]),
  );
  const showCompany = companyByRealm.size > 1;

  // A failed allocation read renders as a banner, not a 500, which means it
  // leaves no trace in the platform logs unless it is written there.
  if (benefitError) {
    console.error(
      `Capitalized Labor: benefit allocation read failed: ${benefitError.message}` +
        ` (code ${benefitError.code ?? "none"})`,
    );
  }

  // The summary comes back as compact [job, amount] tuples for the window.
  const summary = (benefitData ?? {}) as { period?: [string, number][] };
  const benefitByJob = new Map<string, number>();
  for (const [jobId, amount] of summary.period ?? []) {
    benefitByJob.set(jobId, (benefitByJob.get(jobId) ?? 0) + Number(amount ?? 0));
  }

  // Labor posted is wages plus employer taxes posted to the job, net of
  // reversals; already capitalized is labor credited off by an entry that
  // debits a capital asset. cap_labor_lines decides which is which, so
  // withholdings never land in either.
  interface JobAgg {
    posted: number;
    capitalized: number; // stored positive
    entryIds: Set<string>;
    latestDate: string | null;
  }
  const aggByJob = new Map<string, JobAgg>();
  for (const l of lineRows) {
    const jobId = l.job_id as string;
    let agg = aggByJob.get(jobId);
    if (!agg) {
      agg = { posted: 0, capitalized: 0, entryIds: new Set(), latestDate: null };
      aggByJob.set(jobId, agg);
    }
    const split = capLaborAmounts(l.treatment as string, Number(l.amount ?? 0));
    agg.posted += split.posted;
    agg.capitalized += split.capitalized;
    agg.entryIds.add(l.qb_txn_id as string);
    const date = (l.txn_date as string | null) ?? null;
    if (date && (!agg.latestDate || date > agg.latestDate)) {
      agg.latestDate = date;
    }
  }

  // Candidate jobs: journal-entry labor posted this year to a non-billable
  // or intercompany job. Jobs with no labor this year aren't listed.
  const candidates: (CapLaborRowData & { amount: number })[] = [];
  for (const j of (jobData ?? []) as unknown as JobRow[]) {
    const agg = aggByJob.get(j.id);
    if (!agg) continue;
    const bucket = capLaborBucket({
      name: j.name,
      customerDisplayName: j.customer?.display_name,
      customerCompanyName: j.customer?.company_name,
      qbCompanyName: j.realm_id ? companyByRealm.get(j.realm_id) : null,
    });
    if (!bucket) continue;
    candidates.push({
      id: j.id,
      name: j.name,
      companyName: (j.realm_id && companyByRealm.get(j.realm_id)) || null,
      customerName: j.customer?.display_name ?? null,
      bucket,
      postedAmount: agg.posted,
      capitalizedAmount: agg.capitalized,
      amount: agg.posted - agg.capitalized,
      benefitAllocation: benefitByJob.get(j.id) ?? null,
      entryCount: agg.entryIds.size,
      latestDate: agg.latestDate,
    });
  }

  // Biggest dollars first.
  candidates.sort(
    (a, b) => b.amount - a.amount || a.name.localeCompare(b.name),
  );

  const nonBillable = candidates.filter((c) => c.bucket === "nonbillable");
  const intercompany = candidates.filter((c) => c.bucket === "intercompany");
  const rows = activeTab === "all" ? candidates : activeTab === "nonbillable" ? nonBillable : intercompany;

  const sumNet = (list: { amount: number }[]) =>
    list.reduce((s, c) => s + c.amount, 0);
  const postedTotal = candidates.reduce((s, c) => s + (c.postedAmount ?? 0), 0);
  const capitalizedTotal = candidates.reduce(
    (s, c) => s + (c.capitalizedAmount ?? 0),
    0,
  );
  const benefitTotal = candidates.reduce(
    (s, c) => s + (c.benefitAllocation ?? 0),
    0,
  );
  const entryCount = (list: { entryCount: number }[]) =>
    list.reduce((s, c) => s + c.entryCount, 0);
  const periodLabel = ytd.label;

  const tabCls = (active: boolean) =>
    `rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
      active
        ? "bg-navy-900 text-white"
        : "text-ink-600 hover:bg-surface hover:text-ink-900"
    }`;

  return (
    <div>
      <PageHeader
        title="Capitalized Labor"
        subtitle={`Labor posted by journal entry to non-billable (EQP) or intercompany jobs — wages plus the employer's share of payroll taxes that may belong in a capital account rather than job cost, calculated for ${ytd.label} (Jan 1 through today) only. Withholdings from employees' checks are never counted. Labor moved to an asset account counts as already capitalized; the net is what still awaits review. Click a job to see the entries, and see the methodology summary at the bottom of the page.`}
        action={
          <div className="flex gap-2">
            <a
              href="/api/export/capitalized-labor-workbook"
              className={buttonCls("secondary")}
            >
              <Download size={15} strokeWidth={2} />
              Download Excel
            </a>
            <a
              href="/api/export/capitalized-labor"
              className={buttonCls("secondary")}
            >
              <Download size={15} strokeWidth={2} />
              Download CSV
            </a>
          </div>
        }
      />

      {benefitError && (
        // Never let a failed allocation read read as "no benefits allocated".
        <p className="mb-6 rounded-lg border border-warn-700/25 bg-warn-50 px-4 py-3 text-sm text-warn-700">
          Benefit allocation couldn&rsquo;t be loaded, so those columns are
          blank: {benefitError.message}
        </p>
      )}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatTile
          label={`Labor posted (${periodLabel})`}
          value={money(postedTotal)}
          hint="wages + employer payroll taxes, net of reversals"
          icon={Layers}
        />
        <StatTile
          label={`Already capitalized (${periodLabel})`}
          value={money(capitalizedTotal)}
          hint="labor credited off to an asset account"
          icon={CheckCircle2}
        />
        <StatTile
          label={`Awaiting review (${periodLabel})`}
          value={money(sumNet(candidates))}
          hint={`net across ${candidates.length} job${candidates.length === 1 ? "" : "s"}`}
          icon={HardHat}
        />
        <StatTile
          label="Non-billable (EQP)"
          value={money(sumNet(nonBillable))}
          hint={`net, ${nonBillable.length} job${nonBillable.length === 1 ? "" : "s"}`}
          icon={Wrench}
        />
        <StatTile
          label="Intercompany"
          value={money(sumNet(intercompany))}
          hint={`net, ${intercompany.length} job${intercompany.length === 1 ? "" : "s"}`}
          icon={Building2}
        />
        <StatTile
          label={`Journal entries (${periodLabel})`}
          value={entryCount(candidates)}
          hint="distinct entries across candidate jobs"
          icon={ScrollText}
        />
        <StatTile
          label={`Benefit allocation (${periodLabel})`}
          value={money(benefitTotal)}
          hint="direct-labor share of employee benefits, candidate jobs"
          icon={HandCoins}
        />
      </div>

      <div className="mb-4 flex w-fit gap-1 rounded-lg border border-line bg-white p-1">
        <Link href={href("all")} className={tabCls(activeTab === "all")}>
          All ({candidates.length})
        </Link>
        <Link
          href={href("nonbillable")}
          className={tabCls(activeTab === "nonbillable")}
        >
          {CAP_LABOR_BUCKET_LABELS.nonbillable} ({nonBillable.length})
        </Link>
        <Link
          href={href("intercompany")}
          className={tabCls(activeTab === "intercompany")}
        >
          {CAP_LABOR_BUCKET_LABELS.intercompany} ({intercompany.length})
        </Link>
      </div>

      {/* clip off so the sticky header can escape the card while scrolling */}
      <Card pad={false} clip={false}>
        {rows.length === 0 ? (
          <EmptyState icon={HardHat} title="No capitalized labor found">
            Journal entries that post wages or employer payroll taxes to
            non-billable (EQP) or intercompany jobs will appear here. Connect
            QuickBooks in Settings and run a sync.
          </EmptyState>
        ) : (
          <Table
            stickyHeader
            head={
              <tr>
                <Th>Job</Th>
                {showCompany && <Th>QB Company</Th>}
                <Th>Customer</Th>
                <Th>Type</Th>
                <Th right>Entries</Th>
                <Th right>Latest entry</Th>
                <Th right>Labor posted</Th>
                <Th right>Already capitalized</Th>
                <Th right>Awaiting review</Th>
                <Th right>Benefit allocation</Th>
              </tr>
            }
          >
            <CapLaborRows jobs={rows} showCompany={showCompany} />
          </Table>
        )}
      </Card>

      <Card className="mt-6">
        <CardTitle>Methodology</CardTitle>
        <div className="grid gap-x-8 gap-y-5 text-sm text-ink-600 lg:grid-cols-2">
          <div>
            <h3 className="mb-1 font-semibold text-ink-900">
              1. What counts as labor
            </h3>
            <p>
              Journal-entry lines imported from QuickBooks that post to an
              expense account for <strong>wages</strong> (<em>labor</em>,{" "}
              <em>payroll</em>, <em>wages</em>, <em>salaries</em>) or the{" "}
              <strong>employer&rsquo;s share of payroll taxes</strong> (FICA,
              Medicare, FUTA, SUTA, unemployment) — the payroll allocations
              (e.g. Paychex) posted per job. Withholdings from the
              employee&rsquo;s check, and every other payroll liability, are
              balance-sheet lines and never count, debit or credit. Payroll
              service fees, bills, purchases, and time entries are excluded.
              Reversals and corrections net against labor posted. Only entries
              dated in the <strong>calendar year to date</strong> (Jan 1,{" "}
              {ytd.year} through today) are counted — the dashboard, the
              journal-entry drill-down, and both downloads alike.
            </p>
          </div>
          <div>
            <h3 className="mb-1 font-semibold text-ink-900">
              2. Which jobs qualify
            </h3>
            <p>
              Jobs named <em>EQP…</em> (internal equipment work) bucket as
              Non-Billable; jobs whose customer is a sister company bucket as
              Intercompany. Transportation jobs (names ending LH, HS, FL, BC)
              are operating work and never qualify. Precision Paint jobs for
              Superior Marine Ways are excluded — those allocations are
              capitalized wages, already handled. Only jobs with journal-entry
              labor this year are listed.
            </p>
          </div>
          <div>
            <h3 className="mb-1 font-semibold text-ink-900">
              3. How &ldquo;already capitalized&rdquo; is detected
            </h3>
            <p>
              A capitalization entry credits the labor (and employer-tax)
              accounts and debits a capital asset. The asset account varies by
              equipment and job, so an entry counts as capitalization when any
              of its lines debits a <em>Fixed Asset</em> or{" "}
              <em>Other Asset</em> account, whatever its name.{" "}
              <strong>Already capitalized</strong> totals the job-tagged labor
              credits on those entries, and <strong>Awaiting review</strong>{" "}
              is labor posted minus already capitalized — what may still belong
              in a capital account. A credit posted without the job tag
              won&rsquo;t appear on this page; the asset side of such entries
              is visible on the Financials page.
            </p>
          </div>
          <div>
            <h3 className="mb-1 font-semibold text-ink-900">
              4. Benefit allocation
            </h3>
            <p>
              The direct-labor share of Employee Benefits attributed to each
              job — the same figure as the Jobs dashboard column: per company
              per month, Employee Benefits &times; Direct Labor &divide;
              (Direct Labor + Salaries &amp; Wages) from the Income Statement,
              distributed across jobs pro-rata by direct-labor cost, summed
              over the year to date. It covers all of a job&rsquo;s direct
              labor (not just journal entries) and is shown for context — a
              capitalization entry may need to carry this burden along with
              the labor. It is not included in the Awaiting review amounts.
            </p>
          </div>
          <div>
            <h3 className="mb-1 font-semibold text-ink-900">
              5. Traceability
            </h3>
            <p>
              Every line carries its journal number so it traces back to the
              exact entry in QuickBooks. This page is read-only: record the
              capitalization entry in QuickBooks (tagging the job on the
              credit line), run a sync, and the amounts here update
              automatically — each sync fully refreshes the imported rows.
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}
