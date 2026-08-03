import Link from "next/link";
import {
  Building2,
  CheckCircle2,
  Download,
  HardHat,
  Layers,
  ScrollText,
  Wrench,
} from "lucide-react";
import { requireUser } from "@/lib/auth";
import { fetchAllRows } from "@/lib/supabase/fetchAll";
import { money } from "@/lib/format";
import {
  capLaborBucket,
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

// Time filter for the amounts. Switching periods never changes which jobs
// are listed or how they bucket — only the amounts shown, matching the Jobs
// dashboard.
type Period = "all" | "ytd" | "mtd";

const PERIODS: { key: Period; label: string }[] = [
  { key: "all", label: "All time" },
  { key: "ytd", label: "Year to date" },
  { key: "mtd", label: "Month to date" },
];

export default async function CapitalizedLaborPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; period?: string }>;
}) {
  const { tab, period: periodParam } = await searchParams;
  const period: Period =
    periodParam === "ytd" || periodParam === "mtd" ? periodParam : "all";
  const activeTab: CapLaborBucket | "all" =
    tab === "nonbillable" || tab === "intercompany" ? tab : "all";

  const href = (opts?: { tab?: string; period?: Period }) => {
    const params = new URLSearchParams();
    const t = opts && "tab" in opts ? opts.tab : activeTab;
    if (t && t !== "all") params.set("tab", t);
    const p = opts && "period" in opts ? opts.period : period;
    if (p && p !== "all") params.set("period", p);
    const q = params.toString();
    return q ? `/capitalized-labor?${q}` : "/capitalized-labor";
  };

  const { supabase } = await requireUser();
  // Paged reads (fetchAllRows) so nothing is cut off at Supabase's 1000-row
  // cap; .order("id") tie-breaks for stable pages.
  const [jobData, { data: connRows }, lineRows] = await Promise.all([
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
    fetchAllRows((from, to) =>
      supabase
        .from("job_costs")
        .select("id, job_id, qb_txn_id, txn_date, amount")
        .eq("qb_txn_type", "JournalEntry")
        .eq("cost_type", "labor")
        .order("id")
        .range(from, to),
    ),
  ]);

  const companyByRealm = new Map(
    (connRows ?? []).map((c) => [c.realm_id as string, c.company_name as string | null]),
  );
  const showCompany = companyByRealm.size > 1;

  // Period boundaries in UTC, matching the database rollup views
  // (current_date is UTC on Supabase). Dates are YYYY-MM-DD strings, so
  // string compare works.
  const today = new Date();
  const ytdStart = `${today.getUTCFullYear()}-01-01`;
  const mtdStart = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-01`;
  const periodStart = period === "ytd" ? ytdStart : period === "mtd" ? mtdStart : null;

  // Debits (positive amounts) are payroll allocations posted to the job;
  // credits (negative amounts) are labor moved back off the labor accounts —
  // the signature a capitalization entry leaves when its credit line is
  // tagged to the job. Tracking them separately is what lets the page show
  // what may have already been capitalized vs. what still awaits review.
  interface JobAgg {
    periodDebits: number;
    periodCredits: number; // stored positive
    inPeriod: boolean;
    entryIds: Set<string>;
    latestDate: string | null;
  }
  const aggByJob = new Map<string, JobAgg>();
  for (const l of lineRows) {
    const jobId = l.job_id as string;
    let agg = aggByJob.get(jobId);
    if (!agg) {
      agg = {
        periodDebits: 0,
        periodCredits: 0,
        inPeriod: false,
        entryIds: new Set(),
        latestDate: null,
      };
      aggByJob.set(jobId, agg);
    }
    const amount = Number(l.amount ?? 0);
    const date = (l.txn_date as string | null) ?? null;
    if (!periodStart || (date && date >= periodStart)) {
      if (amount >= 0) agg.periodDebits += amount;
      else agg.periodCredits += -amount;
      agg.inPeriod = true;
    }
    agg.entryIds.add(l.qb_txn_id as string);
    if (date && (!agg.latestDate || date > agg.latestDate)) {
      agg.latestDate = date;
    }
  }

  // Candidate jobs: journal-entry labor posted to a non-billable or
  // intercompany job.
  const candidates: (CapLaborRowData & {
    periodDebits: number;
    periodCredits: number;
    periodNet: number;
  })[] = [];
  for (const j of (jobData ?? []) as unknown as JobRow[]) {
    const agg = aggByJob.get(j.id);
    if (!agg) continue;
    const bucket = capLaborBucket({
      name: j.name,
      customerDisplayName: j.customer?.display_name,
      customerCompanyName: j.customer?.company_name,
    });
    if (!bucket) continue;
    const net = agg.periodDebits - agg.periodCredits;
    candidates.push({
      id: j.id,
      name: j.name,
      companyName: (j.realm_id && companyByRealm.get(j.realm_id)) || null,
      customerName: j.customer?.display_name ?? null,
      bucket,
      grossAmount: agg.inPeriod ? agg.periodDebits : null,
      capitalizedAmount: agg.inPeriod ? agg.periodCredits : null,
      amount: agg.inPeriod ? net : null,
      periodDebits: agg.inPeriod ? agg.periodDebits : 0,
      periodCredits: agg.inPeriod ? agg.periodCredits : 0,
      periodNet: agg.inPeriod ? net : 0,
      entryCount: agg.entryIds.size,
      latestDate: agg.latestDate,
    });
  }

  // Biggest dollars first; jobs quiet in the selected period sort last.
  candidates.sort((a, b) => {
    if (a.amount == null && b.amount == null)
      return a.name.localeCompare(b.name);
    if (a.amount == null) return 1;
    if (b.amount == null) return -1;
    return b.amount - a.amount || a.name.localeCompare(b.name);
  });

  const nonBillable = candidates.filter((c) => c.bucket === "nonbillable");
  const intercompany = candidates.filter((c) => c.bucket === "intercompany");
  const rows = activeTab === "all" ? candidates : activeTab === "nonbillable" ? nonBillable : intercompany;

  const sumNet = (list: { periodNet: number }[]) =>
    list.reduce((s, c) => s + c.periodNet, 0);
  const grossTotal = candidates.reduce((s, c) => s + c.periodDebits, 0);
  const capitalizedTotal = candidates.reduce((s, c) => s + c.periodCredits, 0);
  const entryCount = (list: { entryCount: number }[]) =>
    list.reduce((s, c) => s + c.entryCount, 0);
  const periodLabel = PERIODS.find((p) => p.key === period)!.label.toLowerCase();

  const tabCls = (active: boolean) =>
    `rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
      active
        ? "bg-navy-900 text-white"
        : "text-ink-600 hover:bg-surface hover:text-ink-900"
    }`;

  return (
    <div>
      <div className="mb-4 flex w-fit gap-1 rounded-lg border border-line bg-white p-1">
        {PERIODS.map(({ key, label }) => (
          <Link key={key} href={href({ period: key })} className={tabCls(period === key)}>
            {label}
          </Link>
        ))}
      </div>

      <PageHeader
        title="Capitalized Labor"
        subtitle="Labor posted by journal entry to non-billable (EQP) or intercompany jobs — payroll allocations that may belong in a capital account rather than job cost. Credits already posted against those labor accounts count as capitalized; the net is what still awaits review. Click a job to see the entries, and see the methodology summary at the bottom of the page."
        action={
          <a
            href="/api/export/capitalized-labor"
            className={buttonCls("secondary")}
          >
            <Download size={15} strokeWidth={2} />
            Download CSV
          </a>
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatTile
          label={`Labor posted (${periodLabel})`}
          value={money(grossTotal)}
          hint="journal-entry debits to labor accounts"
          icon={Layers}
        />
        <StatTile
          label={`Already capitalized (${periodLabel})`}
          value={money(capitalizedTotal)}
          hint="credits — labor moved off these jobs"
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
          label="Journal entries"
          value={entryCount(candidates)}
          hint="all time, across candidate jobs"
          icon={ScrollText}
        />
      </div>

      <div className="mb-4 flex w-fit gap-1 rounded-lg border border-line bg-white p-1">
        <Link href={href({ tab: "all" })} className={tabCls(activeTab === "all")}>
          All ({candidates.length})
        </Link>
        <Link
          href={href({ tab: "nonbillable" })}
          className={tabCls(activeTab === "nonbillable")}
        >
          {CAP_LABOR_BUCKET_LABELS.nonbillable} ({nonBillable.length})
        </Link>
        <Link
          href={href({ tab: "intercompany" })}
          className={tabCls(activeTab === "intercompany")}
        >
          {CAP_LABOR_BUCKET_LABELS.intercompany} ({intercompany.length})
        </Link>
      </div>

      {/* clip off so the sticky header can escape the card while scrolling */}
      <Card pad={false} clip={false}>
        {rows.length === 0 ? (
          <EmptyState icon={HardHat} title="No capitalized labor found">
            Journal entries that post labor, payroll, or wages accounts to
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
              account whose name contains <em>labor</em>, <em>payroll</em>, or{" "}
              <em>wages</em> — the payroll allocations (e.g. Paychex gross
              wages) posted per job. Bills, purchases, and time entries are
              regular job cost and are excluded. Debits count as labor posted;
              credits count against it.
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
              are operating work and never qualify. Unlike the Jobs dashboard,
              there is no recent-activity cutoff — old entries still need
              review.
            </p>
          </div>
          <div>
            <h3 className="mb-1 font-semibold text-ink-900">
              3. How &ldquo;already capitalized&rdquo; is detected
            </h3>
            <p>
              A capitalization entry credits the labor account and debits a
              capital (fixed-asset) account. When that credit is tagged to the
              job in QuickBooks, it lands here as a negative line, so{" "}
              <strong>Already capitalized</strong> totals those credits and{" "}
              <strong>Awaiting review</strong> is labor posted minus credits —
              what may still belong in a capital account. A credit posted
              without the job tag won&rsquo;t appear on this page; the asset
              side of such entries is visible on the Financials page.
            </p>
          </div>
          <div>
            <h3 className="mb-1 font-semibold text-ink-900">
              4. Traceability
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
