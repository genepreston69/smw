import Link from "next/link";
import { Download, Wrench } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { isEnterpriseName } from "@/lib/enterprise";
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

// Jobs with no cost transactions on or after this date move to the
// "No transactions" tab (except US Army Corps of Engineers jobs).
// Matches JOB_COSTS_START_DATE in src/lib/quickbooks.ts.
const NO_TXN_CUTOFF = "2025-01-01";

// US Army Corps of Engineers jobs stay under Customer jobs even without
// recent transactions. QuickBooks names vary ("US Army Corps of Engineers",
// "U.S. Army Corps...", "USACE"), so match loosely like isEnterpriseName.
function isArmyCorpsName(name: string | null | undefined): boolean {
  if (!name) return false;
  const n = name.toLowerCase();
  return n.includes("army corps") || n.split(/[^a-z0-9]+/).includes("usace");
}

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  const intercompanyTab = tab === "intercompany";
  const noTxnTab = tab === "no-transactions";

  const { supabase, profile } = await requireUser();
  const isAdmin = profile.role === "admin";
  const [{ data }, { data: connRows }, { data: costRows }] = await Promise.all([
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

  const isIntercompany = (j: JobRow) =>
    isEnterpriseName(j.customer?.display_name) ||
    isEnterpriseName(j.customer?.company_name);

  const isArmyCorps = (j: JobRow) =>
    isArmyCorpsName(j.customer?.display_name) ||
    isArmyCorpsName(j.customer?.company_name);

  // txn_date is a date string (YYYY-MM-DD), so string compare works.
  const hasRecentTxns = (j: JobRow) => {
    const latest = costByJob.get(j.id)?.latestTxnDate;
    return !!latest && latest >= NO_TXN_CUTOFF;
  };

  // No-transactions wins over intercompany: any job (customer or
  // intercompany) with no cost activity since the cutoff moves there,
  // except US Army Corps of Engineers jobs, which stay under Customer jobs.
  const isNoTxn = (j: JobRow) => !hasRecentTxns(j) && !isArmyCorps(j);

  const noTxnJobs = allJobs.filter(isNoTxn);
  const activeJobs = allJobs.filter((j) => !isNoTxn(j));
  const intercompanyJobs = activeJobs.filter(isIntercompany);
  const customerJobs = activeJobs.filter((j) => !isIntercompany(j));
  const jobs = intercompanyTab
    ? intercompanyJobs
    : noTxnTab
      ? noTxnJobs
      : customerJobs;

  const rows: JobRowData[] = jobs.map((j) => {
    const cost = costByJob.get(j.id);
    return {
      id: j.id,
      name: j.name,
      companyName: (j.realm_id && companyByRealm.get(j.realm_id)) || null,
      customerName: j.customer?.display_name ?? null,
      active: j.active,
      lastSyncedAt: j.last_synced_at,
      totalCost: cost ? cost.amount : null,
      latestTxnDate: cost?.latestTxnDate ?? null,
    };
  });

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
          intercompanyTab
            ? "Work performed for companies within the enterprise (Precision Paint, Superior Marine, SMW, IRDC)."
            : noTxnTab
              ? "Customer and intercompany jobs with no cost transactions since 1/1/2025. US Army Corps of Engineers jobs stay under Customer jobs."
              : "QuickBooks projects and sub-customers for outside customers. Job plans attach to these. Click a job to see its transaction history (materials, labor, and other direct costs since Jan 1, 2025)."
        }
        action={
          <a href="/api/export/jobs" className={buttonCls("secondary")}>
            <Download size={15} strokeWidth={2} />
            Export to Excel
          </a>
        }
      />

      <div className="mb-4 flex w-fit gap-1 rounded-lg border border-line bg-white p-1">
        <Link href="/jobs" className={tabCls(!intercompanyTab && !noTxnTab)}>
          Customer jobs ({customerJobs.length})
        </Link>
        <Link href="/jobs?tab=no-transactions" className={tabCls(noTxnTab)}>
          No transactions ({noTxnJobs.length})
        </Link>
        <Link href="/jobs?tab=intercompany" className={tabCls(intercompanyTab)}>
          Intercompany ({intercompanyJobs.length})
        </Link>
      </div>

      <Card pad={false}>
        {rows.length === 0 ? (
          <EmptyState
            icon={Wrench}
            title={
              intercompanyTab
                ? "No intercompany jobs"
                : noTxnTab
                  ? "No jobs without transactions"
                  : "No customer jobs yet"
            }
          >
            {intercompanyTab
              ? "Jobs whose customer is an enterprise company will appear here."
              : noTxnTab
                ? "Jobs with no cost transactions since 1/1/2025 will appear here."
                : "Connect QuickBooks in Settings and run a sync."}
          </EmptyState>
        ) : (
          <Table
            head={
              <tr>
                <Th>Job</Th>
                {showCompany && <Th>QB Company</Th>}
                <Th>Customer</Th>
                <Th right>Actual cost</Th>
                {noTxnTab && <Th right>Latest transaction</Th>}
                <Th>Active</Th>
                <Th right>Last synced</Th>
                {isAdmin && <Th right />}
              </tr>
            }
          >
            <JobRows
              jobs={rows}
              showCompany={showCompany}
              isAdmin={isAdmin}
              showLatestTxn={noTxnTab}
            />
          </Table>
        )}
      </Card>
    </div>
  );
}
