import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/fetchAll";
import { capLaborBucket, CAP_LABOR_BUCKET_LABELS } from "@/lib/capitalizedLabor";
import { shortDate } from "@/lib/format";

// Excel workbook for the Capitalized Labor dashboard: a Jobs sheet mirroring
// the dashboard table (all-time amounts) and a Journal Lines sheet with the
// line-level detail accounting builds the capitalization entry from. Must
// bucket identically to the dashboard (src/app/(app)/capitalized-labor/) and
// the CSV export — the rule lives in src/lib/capitalizedLabor.ts.
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Paged reads so the workbook includes every row past Supabase's 1000-row cap.
  const [jobs, { data: connRows }, lines] = await Promise.all([
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
        .select(
          "id, job_id, qb_txn_id, qb_doc_number, txn_date, description, category, amount",
        )
        .eq("qb_txn_type", "JournalEntry")
        .eq("cost_type", "labor")
        .order("txn_date", { ascending: false, nullsFirst: false })
        .order("id")
        .range(from, to),
    ),
  ]);

  const companyByRealm = new Map(
    (connRows ?? []).map((c) => [c.realm_id, c.company_name]),
  );

  interface JobRow {
    id: string;
    name: string;
    realm_id: string | null;
    customer: { display_name: string; company_name: string | null } | null;
  }

  const candidateByJob = new Map<
    string,
    { job: JobRow; bucket: "nonbillable" | "intercompany" }
  >();
  for (const j of jobs as unknown as JobRow[]) {
    const bucket = capLaborBucket({
      name: j.name,
      customerDisplayName: j.customer?.display_name,
      customerCompanyName: j.customer?.company_name,
      qbCompanyName: j.realm_id
        ? ((companyByRealm.get(j.realm_id) as string | null) ?? null)
        : null,
    });
    if (bucket) candidateByJob.set(j.id, { job: j, bucket });
  }

  // Per-job rollup matching the dashboard: debits are payroll allocations
  // posted to the job, credits (stored positive) are labor already moved off
  // the labor accounts, net is what still awaits review.
  interface JobAgg {
    debits: number;
    credits: number;
    entryIds: Set<string>;
    latestDate: string | null;
  }
  const aggByJob = new Map<string, JobAgg>();
  for (const l of lines) {
    const jobId = l.job_id as string;
    if (!candidateByJob.has(jobId)) continue;
    let agg = aggByJob.get(jobId);
    if (!agg) {
      agg = { debits: 0, credits: 0, entryIds: new Set(), latestDate: null };
      aggByJob.set(jobId, agg);
    }
    const amount = Number(l.amount ?? 0);
    if (amount >= 0) agg.debits += amount;
    else agg.credits += -amount;
    agg.entryIds.add(l.qb_txn_id as string);
    const date = (l.txn_date as string | null) ?? null;
    if (date && (!agg.latestDate || date > agg.latestDate)) {
      agg.latestDate = date;
    }
  }

  const workbook = new ExcelJS.Workbook();
  const moneyFmt = "#,##0.00";

  const jobsSheet = workbook.addWorksheet("Jobs");
  jobsSheet.columns = [
    { header: "Job", key: "job", width: 32 },
    { header: "QB Company", key: "company", width: 22 },
    { header: "Customer", key: "customer", width: 28 },
    { header: "Type", key: "type", width: 14 },
    { header: "Entries", key: "entries", width: 9 },
    { header: "Latest Entry", key: "latest", width: 13 },
    { header: "Labor Posted", key: "debits", width: 14, style: { numFmt: moneyFmt } },
    { header: "Already Capitalized", key: "credits", width: 18, style: { numFmt: moneyFmt } },
    { header: "Awaiting Review", key: "net", width: 15, style: { numFmt: moneyFmt } },
  ];
  jobsSheet.getRow(1).font = { bold: true };
  jobsSheet.views = [{ state: "frozen", ySplit: 1 }];

  const summaryRows = [...aggByJob.entries()].map(([jobId, agg]) => {
    const { job, bucket } = candidateByJob.get(jobId)!;
    return { job, bucket, agg, net: agg.debits - agg.credits };
  });
  // Biggest dollars first, matching the dashboard's default sort.
  summaryRows.sort(
    (a, b) => b.net - a.net || a.job.name.localeCompare(b.job.name),
  );
  for (const { job, bucket, agg, net } of summaryRows) {
    jobsSheet.addRow({
      job: job.name,
      company: job.realm_id
        ? (companyByRealm.get(job.realm_id) ?? job.realm_id)
        : "",
      customer: job.customer?.display_name ?? "",
      type: CAP_LABOR_BUCKET_LABELS[bucket],
      entries: agg.entryIds.size,
      latest: agg.latestDate ? shortDate(agg.latestDate) : "",
      debits: agg.debits,
      credits: agg.credits,
      net,
    });
  }
  const totalRow = jobsSheet.addRow({
    job: "Total",
    entries: summaryRows.reduce((s, r) => s + r.agg.entryIds.size, 0),
    debits: summaryRows.reduce((s, r) => s + r.agg.debits, 0),
    credits: summaryRows.reduce((s, r) => s + r.agg.credits, 0),
    net: summaryRows.reduce((s, r) => s + r.net, 0),
  });
  totalRow.font = { bold: true };

  const linesSheet = workbook.addWorksheet("Journal Lines");
  linesSheet.columns = [
    { header: "Job", key: "job", width: 32 },
    { header: "QB Company", key: "company", width: 22 },
    { header: "Customer", key: "customer", width: 28 },
    { header: "Type", key: "type", width: 14 },
    { header: "Date", key: "date", width: 12 },
    { header: "Journal Entry", key: "entry", width: 14 },
    { header: "Account", key: "account", width: 28 },
    { header: "Description", key: "description", width: 40 },
    { header: "Posting", key: "posting", width: 9 },
    { header: "Amount", key: "amount", width: 14, style: { numFmt: moneyFmt } },
  ];
  linesSheet.getRow(1).font = { bold: true };
  linesSheet.views = [{ state: "frozen", ySplit: 1 }];

  for (const l of lines) {
    const candidate = candidateByJob.get(l.job_id as string);
    if (!candidate) continue;
    const { job, bucket } = candidate;
    linesSheet.addRow({
      job: job.name,
      company: job.realm_id
        ? (companyByRealm.get(job.realm_id) ?? job.realm_id)
        : "",
      customer: job.customer?.display_name ?? "",
      type: CAP_LABOR_BUCKET_LABELS[bucket],
      date: l.txn_date ? shortDate(l.txn_date as string) : "",
      entry: (l.qb_doc_number as string | null) ?? `#${l.qb_txn_id}`,
      account: (l.category as string | null) ?? "",
      description: (l.description as string | null) ?? "",
      // Credits are labor already moved off the job's labor accounts
      // (capitalized or corrected); debits are allocations awaiting review.
      posting: Number(l.amount ?? 0) < 0 ? "Credit" : "Debit",
      amount: Number(l.amount ?? 0),
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return new Response(Buffer.from(buffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="capitalized-labor.xlsx"',
    },
  });
}
