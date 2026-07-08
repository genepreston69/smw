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

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  const activeTab =
    tab === "intercompany" || tab === "nonbillable" ? tab : "customer";

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
    supabase.from("job_cost_totals").select("job_id, total_amount, total_hours"),
  ]);

  const allJobs = (data ?? []) as unknown as JobRow[];
  const companyByRealm = new Map(
    (connRows ?? []).map((c) => [c.realm_id as string, c.company_name as string | null]),
  );
  const showCompany = companyByRealm.size > 1;
  const costByJob = new Map(
    (costRows ?? []).map((r) => [r.job_id as string, Number(r.total_amount ?? 0)]),
  );

  const isIntercompany = (j: JobRow) =>
    isEnterpriseName(j.customer?.display_name) ||
    isEnterpriseName(j.customer?.company_name);
  // EQP-prefixed job numbers are internal equipment work — never billable.
  const isNonBillable = (j: JobRow) => /^eqp/i.test(j.name.trim());

  const nonBillableJobs = allJobs.filter(isNonBillable);
  const billableJobs = allJobs.filter((j) => !isNonBillable(j));
  const intercompanyJobs = billableJobs.filter(isIntercompany);
  const customerJobs = billableJobs.filter((j) => !isIntercompany(j));
  const jobs =
    activeTab === "nonbillable"
      ? nonBillableJobs
      : activeTab === "intercompany"
        ? intercompanyJobs
        : customerJobs;

  const rows: JobRowData[] = jobs.map((j) => ({
    id: j.id,
    name: j.name,
    companyName: (j.realm_id && companyByRealm.get(j.realm_id)) || null,
    customerName: j.customer?.display_name ?? null,
    active: j.active,
    lastSyncedAt: j.last_synced_at,
    totalCost: costByJob.has(j.id) ? costByJob.get(j.id)! : null,
  }));

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
          activeTab === "nonbillable"
            ? "Non-billable jobs — job numbers starting with EQP (internal equipment work)."
            : activeTab === "intercompany"
              ? "Work performed for companies within the enterprise (Precision Paint, Superior Marine, SMW, IRDC)."
              : "QuickBooks projects and sub-customers for outside customers. Job plans attach to these. Click a job to see its transaction history (materials, direct labor, and other direct costs since Jan 1, 2023)."
        }
        action={
          <a href="/api/export/jobs" className={buttonCls("secondary")}>
            <Download size={15} strokeWidth={2} />
            Export to Excel
          </a>
        }
      />

      <div className="mb-4 flex w-fit gap-1 rounded-lg border border-line bg-white p-1">
        <Link href="/jobs" className={tabCls(activeTab === "customer")}>
          Customer jobs ({customerJobs.length})
        </Link>
        <Link
          href="/jobs?tab=intercompany"
          className={tabCls(activeTab === "intercompany")}
        >
          Intercompany ({intercompanyJobs.length})
        </Link>
        <Link
          href="/jobs?tab=nonbillable"
          className={tabCls(activeTab === "nonbillable")}
        >
          Non-Billable ({nonBillableJobs.length})
        </Link>
      </div>

      <Card pad={false}>
        {rows.length === 0 ? (
          <EmptyState
            icon={Wrench}
            title={
              activeTab === "nonbillable"
                ? "No non-billable jobs"
                : activeTab === "intercompany"
                  ? "No intercompany jobs"
                  : "No customer jobs yet"
            }
          >
            {activeTab === "nonbillable"
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
                <Th right>Actual cost</Th>
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
