import Link from "next/link";
import { ArrowDown, ArrowUp, ArrowUpDown, Download, Wrench } from "lucide-react";
import { requireUser } from "@/lib/auth";
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

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; sort?: string }>;
}) {
  const { tab, sort } = await searchParams;
  const activeTab =
    tab === "intercompany" || tab === "nonbillable" || tab === "notransactions"
      ? tab
      : "customer";
  const costSort =
    sort === "cost_desc" ? "desc" : sort === "cost_asc" ? "asc" : null;

  const jobsHref = (opts?: { tab?: string; sort?: string | null }) => {
    const params = new URLSearchParams();
    const t = opts && "tab" in opts ? opts.tab : activeTab;
    if (t && t !== "customer") params.set("tab", t);
    const s = opts && "sort" in opts ? opts.sort : sort;
    if (s === "cost_desc" || s === "cost_asc") params.set("sort", s);
    const q = params.toString();
    return q ? `/jobs?${q}` : "/jobs";
  };

  const { supabase, profile } = await requireUser();
  const isAdmin = profile.role === "admin";
  const [{ data }, { data: connRows }, { data: costRows }, { data: invRows }] =
    await Promise.all([
      supabase
        .from("jobs")
        .select(
          "id, name, realm_id, fully_qualified_name, active, last_synced_at, customer:customers(display_name, company_name)",
        )
        .order("name"),
      supabase.from("qb_connection_status").select("realm_id, company_name"),
      supabase
        .from("job_cost_totals")
        .select("job_id, total_amount, latest_txn_date"),
      supabase
        .from("job_invoice_totals")
        .select("job_id, total_invoiced, latest_invoice_date"),
    ]);

  const allJobs = (data ?? []) as unknown as JobRow[];
  const companyByRealm = new Map(
    (connRows ?? []).map((c) => [c.realm_id as string, c.company_name as string | null]),
  );
  const showCompany = companyByRealm.size > 1;
  const costByJob = new Map(
    (costRows ?? []).map((r) => [
      r.job_id as string,
      {
        amount: Number(r.total_amount ?? 0),
        latestTxnDate: (r.latest_txn_date as string | null) ?? null,
      },
    ]),
  );
  const invoiceByJob = new Map(
    (invRows ?? []).map((r) => [
      r.job_id as string,
      {
        invoiced: Number(r.total_invoiced ?? 0),
        latestInvoiceDate: (r.latest_invoice_date as string | null) ?? null,
      },
    ]),
  );

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
        latestTxnDate: latestTxnDate(j.id),
      })
    ].push(j);
  }
  const customerJobs = grouped.customer;
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
      totalCost: cost ? cost.amount : null,
      invoiced: invoice ? invoice.invoiced : null,
      latestTxnDate: latestTxnDate(j.id),
    };
  });

  // Jobs come name-sorted from the query; cost sort puts costless jobs last.
  if (costSort) {
    rows.sort((a, b) => {
      if (a.totalCost == null && b.totalCost == null) return 0;
      if (a.totalCost == null) return 1;
      if (b.totalCost == null) return -1;
      return costSort === "asc"
        ? a.totalCost - b.totalCost
        : b.totalCost - a.totalCost;
    });
  }

  // Click cycles: default (name) -> highest first -> lowest first -> default.
  const nextCostSort =
    costSort === null ? "cost_desc" : costSort === "desc" ? "cost_asc" : null;
  const CostSortIcon =
    costSort === "desc" ? ArrowDown : costSort === "asc" ? ArrowUp : ArrowUpDown;

  const tabCls = (active: boolean) =>
    `rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
      active
        ? "bg-navy-900 text-white"
        : "text-ink-600 hover:bg-surface hover:text-ink-900"
    }`;

  return (
    <div>
      <PageHeader
        title="Jobs"
        subtitle={
          activeTab === "notransactions"
            ? "Jobs with no cost or invoice activity since Jan 1, 2025 (US Army Corps of Engineers jobs stay under Customer jobs). They move to the other tabs once activity is tagged to them in QuickBooks."
            : activeTab === "nonbillable"
              ? "Non-billable jobs — job numbers starting with EQP (internal equipment work)."
              : activeTab === "intercompany"
                ? "Work performed for companies within the enterprise (Precision Paint, Superior Marine, SMW, IRDC)."
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

      <Card pad={false}>
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
                    : "No customer jobs yet"
            }
          >
            {activeTab === "notransactions"
              ? "Jobs with no cost or invoice activity since Jan 1, 2025 will appear here."
              : activeTab === "nonbillable"
                ? "Jobs whose number starts with EQP will appear here."
                : activeTab === "intercompany"
                  ? "Jobs whose customer is an enterprise company will appear here."
                  : "Connect QuickBooks in Settings and run a sync."}
          </EmptyState>
        ) : (
          <Table
            head={
              <tr>
                <Th>Job</Th>
                {showCompany && <Th>QB Company</Th>}
                <Th>Customer</Th>
                <Th right>
                  <Link
                    href={jobsHref({ sort: nextCostSort })}
                    title={
                      costSort === "desc"
                        ? "Sorted highest first — click for lowest first"
                        : costSort === "asc"
                          ? "Sorted lowest first — click to clear"
                          : "Sort by actual cost"
                    }
                    className={`inline-flex items-center gap-1 uppercase transition-colors hover:text-ink-900 ${
                      costSort ? "text-ink-900" : ""
                    }`}
                  >
                    Actual cost
                    <CostSortIcon size={12} strokeWidth={2} />
                  </Link>
                </Th>
                <Th right>Invoiced</Th>
                <Th right>Latest transaction</Th>
                <Th>Active</Th>
                <Th right>Last synced</Th>
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
