import Link from "next/link";
import { ArrowDown, ArrowUp, ArrowUpDown, Download, Wrench } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { fetchAllRows } from "@/lib/supabase/fetchAll";
import { classifyJobView, type JobView } from "@/lib/jobViews";
import { Card, EmptyState, PageHeader, Table, Th, buttonCls } from "@/components/ui";
import { JobRows, type JobRowData } from "./JobRows";

interface JobRow {
  id: string;
  name: string;
  realm_id: string | null;
  fully_qualified_name: string | null;
  active: boolean;
  last_synced_at: string | null;
  customer: { display_name: string; company_name: string | null } | null;
}

// Sortable dashboard columns. Numbers and dates sort highest/newest first on
// the first click (Active shows "Yes" first); text columns sort A→Z first.
type SortKey =
  | "name"
  | "company"
  | "customer"
  | "cost"
  | "invoiced"
  | "latest"
  | "active"
  | "synced";

const SORT_PATTERN =
  /^(name|company|customer|cost|invoiced|latest|active|synced)_(asc|desc)$/;

const DESC_FIRST: ReadonlySet<SortKey> = new Set([
  "cost",
  "invoiced",
  "latest",
  "active",
  "synced",
]);

// Time filter for the cost/invoiced columns. Period totals come precomputed
// from the rollup views (ytd_amount, mtd_amount, …), so switching periods
// never changes which jobs are listed or how they're grouped into tabs —
// only the amounts shown.
type Period = "all" | "ytd" | "mtd";

const PERIODS: { key: Period; label: string }[] = [
  { key: "all", label: "All time" },
  { key: "ytd", label: "Year to date" },
  { key: "mtd", label: "Month to date" },
];

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; sort?: string; period?: string }>;
}) {
  const { tab, sort, period: periodParam } = await searchParams;
  const period: Period =
    periodParam === "ytd" || periodParam === "mtd" ? periodParam : "all";
  const activeTab =
    tab === "transportation" ||
    tab === "intercompany" ||
    tab === "nonbillable" ||
    tab === "notransactions"
      ? tab
      : "customer";
  const sortMatch = SORT_PATTERN.exec(sort ?? "");
  const sortKey = sortMatch ? (sortMatch[1] as SortKey) : null;
  const sortDir = sortMatch ? (sortMatch[2] as "asc" | "desc") : null;

  const jobsHref = (opts?: {
    tab?: string;
    sort?: string | null;
    period?: Period;
  }) => {
    const params = new URLSearchParams();
    const t = opts && "tab" in opts ? opts.tab : activeTab;
    if (t && t !== "customer") params.set("tab", t);
    const s = opts && "sort" in opts ? opts.sort : sort;
    if (s && SORT_PATTERN.test(s)) params.set("sort", s);
    const p = opts && "period" in opts ? opts.period : period;
    if (p && p !== "all") params.set("period", p);
    const q = params.toString();
    return q ? `/jobs?${q}` : "/jobs";
  };

  const { supabase, profile } = await requireUser();
  const isAdmin = profile.role === "admin";
  // Paged reads (fetchAllRows) so no list is cut off at Supabase's
  // 1000-row cap; .order("id") tie-breaks duplicate names for stable pages.
  const [data, { data: connRows }, costRows, invRows] = await Promise.all([
    fetchAllRows((from, to) =>
      supabase
        .from("jobs")
        .select(
          "id, name, realm_id, fully_qualified_name, active, last_synced_at, customer:customers(display_name, company_name)",
        )
        .order("name")
        .order("id")
        .range(from, to),
    ),
    supabase.from("qb_connection_status").select("realm_id, company_name"),
    fetchAllRows((from, to) =>
      supabase
        .from("job_cost_totals")
        .select("job_id, total_amount, ytd_amount, mtd_amount, latest_txn_date")
        .order("job_id")
        .range(from, to),
    ),
    fetchAllRows((from, to) =>
      supabase
        .from("job_invoice_totals")
        .select(
          "job_id, total_invoiced, ytd_invoiced, mtd_invoiced, latest_invoice_date",
        )
        .order("job_id")
        .range(from, to),
    ),
  ]);

  const companyByRealm = new Map(
    (connRows ?? []).map((c) => [c.realm_id as string, c.company_name as string | null]),
  );
  const showCompany = companyByRealm.size > 1;
  // Period sums are null when a job has no activity in the period, so the
  // row shows "—" (and sorts last) just like a job with no rows at all.
  const costByJob = new Map(
    costRows.map((r) => [
      r.job_id as string,
      {
        amount: Number(r.total_amount ?? 0),
        ytd: r.ytd_amount == null ? null : Number(r.ytd_amount),
        mtd: r.mtd_amount == null ? null : Number(r.mtd_amount),
        latestTxnDate: (r.latest_txn_date as string | null) ?? null,
      },
    ]),
  );
  const invoiceByJob = new Map(
    invRows.map((r) => [
      r.job_id as string,
      {
        invoiced: Number(r.total_invoiced ?? 0),
        ytd: r.ytd_invoiced == null ? null : Number(r.ytd_invoiced),
        mtd: r.mtd_invoiced == null ? null : Number(r.mtd_invoiced),
        latestInvoiceDate: (r.latest_invoice_date as string | null) ?? null,
      },
    ]),
  );

  // Jobs with no dollars at all (zero or missing actual cost AND zero or
  // missing invoiced) are noise on the dashboard, so they're hidden from
  // every tab. The workbook export still includes them.
  const allJobs = ((data ?? []) as unknown as JobRow[]).filter((j) => {
    const cost = costByJob.get(j.id)?.amount ?? 0;
    const invoiced = invoiceByJob.get(j.id)?.invoiced ?? 0;
    return cost !== 0 || invoiced !== 0;
  });

  // Latest activity across costs and invoices. Dates are YYYY-MM-DD strings,
  // so string compare works.
  const latestTxnDate = (jobId: string): string | null => {
    const cost = costByJob.get(jobId)?.latestTxnDate ?? null;
    const inv = invoiceByJob.get(jobId)?.latestInvoiceDate ?? null;
    if (cost && inv) return cost >= inv ? cost : inv;
    return cost ?? inv;
  };

  const grouped: Record<JobView, JobRow[]> = {
    customer: [],
    transportation: [],
    intercompany: [],
    nonbillable: [],
    notransactions: [],
  };
  for (const j of allJobs) {
    grouped[
      classifyJobView({
        name: j.name,
        customerDisplayName: j.customer?.display_name,
        customerCompanyName: j.customer?.company_name,
        qbCompanyName: (j.realm_id && companyByRealm.get(j.realm_id)) || null,
        latestTxnDate: latestTxnDate(j.id),
      })
    ].push(j);
  }
  const customerJobs = grouped.customer;
  const transportationJobs = grouped.transportation;
  const intercompanyJobs = grouped.intercompany;
  const nonBillableJobs = grouped.nonbillable;
  const noTxnJobs = grouped.notransactions;
  const jobs = grouped[activeTab as JobView];

  const rows: JobRowData[] = jobs.map((j) => {
    const cost = costByJob.get(j.id);
    const invoice = invoiceByJob.get(j.id);
    return {
      id: j.id,
      name: j.name,
      companyName: (j.realm_id && companyByRealm.get(j.realm_id)) || null,
      customerName: j.customer?.display_name ?? null,
      active: j.active,
      lastSyncedAt: j.last_synced_at,
      totalCost: !cost
        ? null
        : period === "all"
          ? cost.amount
          : cost[period],
      invoiced: !invoice
        ? null
        : period === "all"
          ? invoice.invoiced
          : invoice[period],
      latestTxnDate: latestTxnDate(j.id),
    };
  });

  // Jobs come name-sorted from the query; sorting a column keeps blank
  // values last regardless of direction.
  const sortValue = (r: JobRowData): string | number | null => {
    switch (sortKey) {
      case "name":
        return r.name.toLowerCase();
      case "company":
        return r.companyName?.toLowerCase() ?? null;
      case "customer":
        return r.customerName?.toLowerCase() ?? null;
      case "cost":
        return r.totalCost;
      case "invoiced":
        return r.invoiced;
      case "latest":
        return r.latestTxnDate;
      case "active":
        return r.active ? 1 : 0;
      case "synced":
        return r.lastSyncedAt;
      default:
        return null;
    }
  };
  if (sortKey) {
    rows.sort((a, b) => {
      const va = sortValue(a);
      const vb = sortValue(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return sortDir === "desc" ? -cmp : cmp;
    });
  }

  // Click cycles a column: first direction -> reverse -> back to name order.
  const nextSort = (key: SortKey): string | null => {
    const first = DESC_FIRST.has(key) ? "desc" : "asc";
    if (sortKey !== key) return `${key}_${first}`;
    if (sortDir === first)
      return `${key}_${first === "desc" ? "asc" : "desc"}`;
    return null;
  };

  const sortHeader = (k: SortKey, label: string) => {
    const active = sortKey === k;
    const Icon = !active ? ArrowUpDown : sortDir === "desc" ? ArrowDown : ArrowUp;
    return (
      <Link
        href={jobsHref({ sort: nextSort(k) })}
        title={
          !active
            ? "Sort"
            : `Sorted ${sortDir === "desc" ? "descending" : "ascending"} — click to ${
                nextSort(k) ? "reverse" : "clear"
              }`
        }
        className={`inline-flex items-center gap-1 uppercase transition-colors hover:text-ink-900 ${
          active ? "text-ink-900" : ""
        }`}
      >
        {label}
        <Icon size={12} strokeWidth={2} />
      </Link>
    );
  };

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
          <Link
            key={key}
            href={jobsHref({ period: key })}
            className={tabCls(period === key)}
          >
            {label}
          </Link>
        ))}
      </div>

      <PageHeader
        title="Jobs"
        subtitle={
          activeTab === "notransactions"
            ? "Jobs with no cost or invoice activity since Jan 1, 2025 (US Army Corps of Engineers jobs stay under Customer jobs). They move to the other tabs once activity is tagged to them in QuickBooks."
            : activeTab === "nonbillable"
              ? "Non-billable jobs — job numbers starting with EQP (internal equipment work), plus Precision Paint jobs under the PPS customer (internal work)."
              : activeTab === "intercompany"
                ? "Work performed for companies within the enterprise (Precision Paint, Superior Marine, SMW, IRDC)."
                : activeTab === "transportation"
                  ? "Transportation jobs — job numbers ending in LH, HS, FL, or BC."
                  : "QuickBooks projects and sub-customers for outside customers. Job plans attach to these. Click a job to see its transaction history (materials, direct labor, and other direct costs since Jan 1, 2023)."
        }
        action={
          <a href="/api/export/jobs-workbook" className={buttonCls("secondary")}>
            <Download size={15} strokeWidth={2} />
            Download workbook
          </a>
        }
      />

      <div className="mb-4 flex w-fit gap-1 rounded-lg border border-line bg-white p-1">
        <Link
          href={jobsHref({ tab: "customer" })}
          className={tabCls(activeTab === "customer")}
        >
          Customer jobs ({customerJobs.length})
        </Link>
        <Link
          href={jobsHref({ tab: "transportation" })}
          className={tabCls(activeTab === "transportation")}
        >
          Transportation ({transportationJobs.length})
        </Link>
        <Link
          href={jobsHref({ tab: "intercompany" })}
          className={tabCls(activeTab === "intercompany")}
        >
          Intercompany ({intercompanyJobs.length})
        </Link>
        <Link
          href={jobsHref({ tab: "nonbillable" })}
          className={tabCls(activeTab === "nonbillable")}
        >
          Non-Billable ({nonBillableJobs.length})
        </Link>
        <Link
          href={jobsHref({ tab: "notransactions" })}
          className={tabCls(activeTab === "notransactions")}
        >
          No transactions ({noTxnJobs.length})
        </Link>
      </div>

      {/* clip off so the sticky header can escape the card while scrolling */}
      <Card pad={false} clip={false}>
        {rows.length === 0 ? (
          <EmptyState
            icon={Wrench}
            title={
              activeTab === "notransactions"
                ? "Every job has transactions"
                : activeTab === "nonbillable"
                  ? "No non-billable jobs"
                  : activeTab === "intercompany"
                    ? "No intercompany jobs"
                    : activeTab === "transportation"
                      ? "No transportation jobs"
                      : "No customer jobs yet"
            }
          >
            {activeTab === "notransactions"
              ? "Jobs with no cost or invoice activity since Jan 1, 2025 will appear here."
              : activeTab === "nonbillable"
                ? "Jobs whose number starts with EQP, or Precision Paint jobs under the PPS customer, will appear here."
                : activeTab === "intercompany"
                  ? "Jobs whose customer is an enterprise company will appear here."
                  : activeTab === "transportation"
                    ? "Jobs whose number ends in LH, HS, FL, or BC will appear here."
                    : "Connect QuickBooks in Settings and run a sync."}
          </EmptyState>
        ) : (
          <Table
            stickyHeader
            head={
              <tr>
                <Th>{sortHeader("name", "Job")}</Th>
                {showCompany && <Th>{sortHeader("company", "QB Company")}</Th>}
                <Th>{sortHeader("customer", "Customer")}</Th>
                <Th right>{sortHeader("cost", "Actual cost")}</Th>
                <Th right>{sortHeader("invoiced", "Invoiced")}</Th>
                <Th right>{sortHeader("latest", "Latest transaction")}</Th>
                <Th>{sortHeader("active", "Active")}</Th>
                <Th right>{sortHeader("synced", "Last synced")}</Th>
                {isAdmin && <Th right />}
              </tr>
            }
          >
            <JobRows jobs={rows} showCompany={showCompany} isAdmin={isAdmin} />
          </Table>
        )}
      </Card>
    </div>
  );
}
