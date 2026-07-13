import { fetchAllRows } from "@/lib/supabase/fetchAll";
import { isEnterpriseName } from "@/lib/enterprise";

/* ---------------------------------------------------------------------------
   Customer summary: every job's actual costs and invoiced revenue rolled up
   by customer. The summary page and its CSV export must aggregate
   identically, so the rollup lives here. Job-level data only — invoices
   billed to a top-level customer (not a job) never import, so they can't
   appear here either.
--------------------------------------------------------------------------- */

export interface CustomerSummaryJob {
  id: string;
  name: string;
  /** null when the job has no imported cost lines / invoices. */
  cost: number | null;
  /** Cost split; null exactly when cost is null. Contract services is the
      non-labor, non-materials remainder (account-based expense lines). */
  materials: number | null;
  labor: number | null;
  contractServices: number | null;
  invoiced: number | null;
}

export interface CustomerSummaryRow {
  /** customer_id, or "none" for jobs with no customer link. */
  key: string;
  name: string;
  /** QB company display name, or null for the single-company case. */
  companyName: string | null;
  intercompany: boolean;
  jobs: number;
  /** The jobs behind the rollup, largest invoiced first. */
  jobList: CustomerSummaryJob[];
  materials: number;
  labor: number;
  other: number;
  hours: number;
  cost: number;
  invoiced: number;
  net: number;
}

export interface CustomerSummary {
  rows: CustomerSummaryRow[];
  /** Only meaningful when more than one QB company is connected. */
  showCompany: boolean;
  totals: Pick<
    CustomerSummaryRow,
    "jobs" | "materials" | "labor" | "other" | "hours" | "cost" | "invoiced" | "net"
  >;
}

interface JobRow {
  id: string;
  name: string;
  customer_id: string | null;
  realm_id: string | null;
  customer: { display_name: string; company_name: string | null } | null;
}

// The page and export routes both hold an untyped server client; a minimal
// structural type keeps this helper decoupled from either call site.
interface SupabaseLike {
  from(table: string): {
    select(columns: string): {
      order(column: string): {
        range(from: number, to: number): PromiseLike<{
          data: unknown[] | null;
          error: { message: string } | null;
        }>;
      };
    };
  };
}

export async function getCustomerSummary(
  supabase: SupabaseLike,
): Promise<CustomerSummary> {
  const [jobRows, connRows, costRows, invRows] = await Promise.all([
    fetchAllRows((from, to) =>
      supabase
        .from("jobs")
        .select(
          "id, name, customer_id, realm_id, customer:customers(display_name, company_name)",
        )
        .order("id")
        .range(from, to),
    ),
    fetchAllRows((from, to) =>
      supabase
        .from("qb_connection_status")
        .select("realm_id, company_name")
        .order("realm_id")
        .range(from, to),
    ),
    fetchAllRows((from, to) =>
      supabase
        .from("job_cost_totals")
        .select(
          "job_id, total_amount, total_hours, materials_amount, labor_amount, other_amount",
        )
        .order("job_id")
        .range(from, to),
    ),
    fetchAllRows((from, to) =>
      supabase
        .from("job_invoice_totals")
        .select("job_id, total_invoiced")
        .order("job_id")
        .range(from, to),
    ),
  ]);

  const companyByRealm = new Map(
    (connRows as { realm_id: string; company_name: string | null }[]).map(
      (c) => [c.realm_id, c.company_name],
    ),
  );
  const showCompany = companyByRealm.size > 1;

  const costByJob = new Map(
    (
      costRows as {
        job_id: string;
        total_amount: number | null;
        total_hours: number | null;
        materials_amount: number | null;
        labor_amount: number | null;
        other_amount: number | null;
      }[]
    ).map((r) => [r.job_id, r]),
  );
  const invoicedByJob = new Map(
    (invRows as { job_id: string; total_invoiced: number | null }[]).map(
      (r) => [r.job_id, Number(r.total_invoiced ?? 0)],
    ),
  );

  // One bucket per customer; jobs whose customer link is missing land in a
  // single "(No customer)" bucket so every job is accounted for.
  const buckets = new Map<string, CustomerSummaryRow>();
  for (const j of jobRows as unknown as JobRow[]) {
    const key = j.customer_id ?? "none";
    let bucket = buckets.get(key);
    if (!bucket) {
      const name = j.customer?.display_name ?? "(No customer)";
      bucket = {
        key,
        name,
        companyName:
          (j.realm_id && companyByRealm.get(j.realm_id)) || null,
        intercompany:
          isEnterpriseName(j.customer?.display_name) ||
          isEnterpriseName(j.customer?.company_name),
        jobs: 0,
        jobList: [],
        materials: 0,
        labor: 0,
        other: 0,
        hours: 0,
        cost: 0,
        invoiced: 0,
        net: 0,
      };
      buckets.set(key, bucket);
    }
    bucket.jobs += 1;
    const cost = costByJob.get(j.id);
    if (cost) {
      bucket.materials += Number(cost.materials_amount ?? 0);
      bucket.labor += Number(cost.labor_amount ?? 0);
      bucket.other += Number(cost.other_amount ?? 0);
      bucket.hours += Number(cost.total_hours ?? 0);
      bucket.cost += Number(cost.total_amount ?? 0);
    }
    const invoiced = invoicedByJob.get(j.id);
    bucket.invoiced += invoiced ?? 0;
    bucket.jobList.push({
      id: j.id,
      name: j.name,
      cost: cost ? Number(cost.total_amount ?? 0) : null,
      materials: cost ? Number(cost.materials_amount ?? 0) : null,
      labor: cost ? Number(cost.labor_amount ?? 0) : null,
      contractServices: cost ? Number(cost.other_amount ?? 0) : null,
      invoiced: invoiced ?? null,
    });
  }

  const rows = [...buckets.values()]
    .map((b) => ({
      ...b,
      net: b.invoiced - b.cost,
      jobList: [...b.jobList].sort(
        (x, y) =>
          (y.invoiced ?? 0) - (x.invoiced ?? 0) || x.name.localeCompare(y.name),
      ),
    }))
    .sort((a, b) => b.invoiced - a.invoiced || a.name.localeCompare(b.name));

  const totals = rows.reduce(
    (t, r) => ({
      jobs: t.jobs + r.jobs,
      materials: t.materials + r.materials,
      labor: t.labor + r.labor,
      other: t.other + r.other,
      hours: t.hours + r.hours,
      cost: t.cost + r.cost,
      invoiced: t.invoiced + r.invoiced,
      net: t.net + r.net,
    }),
    { jobs: 0, materials: 0, labor: 0, other: 0, hours: 0, cost: 0, invoiced: 0, net: 0 },
  );

  return { rows, showCompany, totals };
}
