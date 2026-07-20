import Link from "next/link";
import { Building2, Download, HardHat, ScrollText, Wrench } from "lucide-react";
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

  interface JobAgg {
    total: number;
    periodTotal: number;
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
        total: 0,
        periodTotal: 0,
        inPeriod: false,
        entryIds: new Set(),
        latestDate: null,
      };
      aggByJob.set(jobId, agg);
    }
    const amount = Number(l.amount ?? 0);
    const date = (l.txn_date as string | null) ?? null;
    agg.total += amount;
    if (!periodStart || (date && date >= periodStart)) {
      agg.periodTotal += amount;
      agg.inPeriod = true;
    }
    agg.entryIds.add(l.qb_txn_id as string);
    if (date && (!agg.latestDate || date > agg.latestDate)) {
      agg.latestDate = date;
    }
  }

  // Candidate jobs: journal-entry labor posted to a non-billable or
  // intercompany job.
  const candidates: (CapLaborRowData & { periodTotal: number })[] = [];
  for (const j of (jobData ?? []) as unknown as JobRow[]) {
    const agg = aggByJob.get(j.id);
    if (!agg) continue;
    const bucket = capLaborBucket({
      name: j.name,
      customerDisplayName: j.customer?.display_name,
      customerCompanyName: j.customer?.company_name,
    });
    if (!bucket) continue;
    candidates.push({
      id: j.id,
      name: j.name,
      companyName: (j.realm_id && companyByRealm.get(j.realm_id)) || null,
      customerName: j.customer?.display_name ?? null,
      bucket,
      amount: agg.inPeriod ? agg.periodTotal : null,
      periodTotal: agg.inPeriod ? agg.periodTotal : 0,
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

  const sum = (list: { periodTotal: number }[]) =>
    list.reduce((s, c) => s + c.periodTotal, 0);
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
        subtitle="Labor posted by journal entry to non-billable (EQP) or intercompany jobs — payroll allocations that may belong in a capital account rather than job cost. Amounts come from journal-entry lines against labor, payroll, or wages accounts imported from QuickBooks. Click a job to see the entries."
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

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label={`Capitalized labor (${periodLabel})`}
          value={money(sum(candidates))}
          hint={`${candidates.length} job${candidates.length === 1 ? "" : "s"}`}
          icon={HardHat}
        />
        <StatTile
          label="Non-billable (EQP)"
          value={money(sum(nonBillable))}
          hint={`${nonBillable.length} job${nonBillable.length === 1 ? "" : "s"}`}
          icon={Wrench}
        />
        <StatTile
          label="Intercompany"
          value={money(sum(intercompany))}
          hint={`${intercompany.length} job${intercompany.length === 1 ? "" : "s"}`}
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
                <Th right>Capitalized labor</Th>
              </tr>
            }
          >
            <CapLaborRows jobs={rows} showCompany={showCompany} />
          </Table>
        )}
      </Card>
    </div>
  );
}
