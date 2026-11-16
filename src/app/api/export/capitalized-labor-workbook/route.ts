import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/fetchAll";
import {
  capLaborAmounts,
  capLaborBucket,
  capLaborByMonth,
  capLaborPeriodFromSearch,
  CAP_LABOR_BUCKET_LABELS,
  CAP_LABOR_TREATMENT_LABELS,
  yearOf,
  type CapLaborTreatment,
} from "@/lib/capitalizedLabor";
import { shortDate } from "@/lib/format";
import { monthLabel } from "@/lib/financials";

// Excel workbook for the Capitalized Labor dashboard: a Jobs sheet mirroring
// the dashboard table, a By Month sheet mirroring its by-month breakdown, and
// a Journal Lines sheet with the line-level detail accounting builds the
// capitalization entry from — all for the dashboard's period (the same year /
// month / from-to params, parsed by capLaborPeriod). Must bucket identically
// to the dashboard (src/app/(app)/capitalized-labor/) and the CSV export —
// the rule lives in src/lib/capitalizedLabor.ts.
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const period = capLaborPeriodFromSearch(new URL(request.url).searchParams);

  // Paged reads so the workbook includes every row past Supabase's 1000-row cap.
  const [jobs, { data: connRows }, lines, benefitRows] = await Promise.all([
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
        .select(
          "id, job_id, qb_txn_id, qb_doc_number, txn_date, description, category, amount, treatment",
        )
        .gte("txn_date", period.from)
        .lte("txn_date", period.to)
        .order("txn_date", { ascending: false, nullsFirst: false })
        .order("id")
        .range(from, to),
    ),
    // Employee-benefit allocation per job per month for the period's months,
    // from the precomputed cache (migration 0025) — same read and figure as
    // the dashboard's Benefit allocation column.
    fetchAllRows((from, to) =>
      supabase
        .from("job_benefit_allocation_cache")
        .select("job_id, month, amount")
        .gte("month", `${period.fromMonth}-01`)
        .lte("month", `${period.toMonth}-01`)
        .order("job_id")
        .order("month")
        .range(from, to),
    ),
  ]);

  const companyByRealm = new Map(
    (connRows ?? []).map((c) => [c.realm_id, c.company_name]),
  );
  const benefitByJob = new Map<string, number>();
  for (const b of benefitRows) {
    benefitByJob.set(b.job_id, (benefitByJob.get(b.job_id) ?? 0) + Number(b.amount ?? 0));
  }

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

  // Per-job rollup matching the dashboard: labor posted is wages plus
  // employer taxes net of reversals, already capitalized (stored positive) is
  // labor credited off to a capital asset, net is what still awaits review.
  interface JobAgg {
    posted: number;
    capitalized: number;
    entryIds: Set<string>;
    latestDate: string | null;
  }
  const aggByJob = new Map<string, JobAgg>();
  for (const l of lines) {
    const jobId = l.job_id as string;
    if (!candidateByJob.has(jobId)) continue;
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
    { header: "Labor Posted", key: "posted", width: 14, style: { numFmt: moneyFmt } },
    { header: "Already Capitalized", key: "capitalized", width: 18, style: { numFmt: moneyFmt } },
    { header: "Awaiting Review", key: "net", width: 15, style: { numFmt: moneyFmt } },
    { header: "Benefit Allocation", key: "benefits", width: 17, style: { numFmt: moneyFmt } },
  ];
  jobsSheet.getRow(1).font = { bold: true };
  jobsSheet.views = [{ state: "frozen", ySplit: 1 }];

  const summaryRows = [...aggByJob.entries()].map(([jobId, agg]) => {
    const { job, bucket } = candidateByJob.get(jobId)!;
    return { job, bucket, agg, net: agg.posted - agg.capitalized };
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
      posted: agg.posted,
      capitalized: agg.capitalized,
      net,
      benefits: benefitByJob.get(job.id) ?? null,
    });
  }
  const totalRow = jobsSheet.addRow({
    job: `Total — ${period.label}`,
    entries: summaryRows.reduce((s, r) => s + r.agg.entryIds.size, 0),
    posted: summaryRows.reduce((s, r) => s + r.agg.posted, 0),
    capitalized: summaryRows.reduce((s, r) => s + r.agg.capitalized, 0),
    net: summaryRows.reduce((s, r) => s + r.net, 0),
    benefits: summaryRows.reduce(
      (s, r) => s + (benefitByJob.get(r.job.id) ?? 0),
      0,
    ),
  });
  totalRow.font = { bold: true };

  // The dashboard's by-month breakdown, over every candidate job (the
  // workbook isn't scoped to a tab).
  const byMonth = capLaborByMonth(
    period,
    lines as {
      job_id: string;
      qb_txn_id: string;
      txn_date: string | null;
      amount: number | null;
      treatment: string;
    }[],
    benefitRows,
    (jobId) => aggByJob.has(jobId),
  );
  const monthSheet = workbook.addWorksheet("By Month");
  monthSheet.columns = [
    { header: "Month", key: "month", width: 14 },
    { header: "Jobs", key: "jobs", width: 8 },
    { header: "Entries", key: "entries", width: 9 },
    { header: "Labor Posted", key: "posted", width: 14, style: { numFmt: moneyFmt } },
    { header: "Already Capitalized", key: "capitalized", width: 18, style: { numFmt: moneyFmt } },
    { header: "Awaiting Review", key: "net", width: 15, style: { numFmt: moneyFmt } },
    { header: "Benefit Allocation", key: "benefits", width: 17, style: { numFmt: moneyFmt } },
  ];
  monthSheet.getRow(1).font = { bold: true };
  monthSheet.views = [{ state: "frozen", ySplit: 1 }];
  for (const m of byMonth.rows) {
    monthSheet.addRow({ ...m, month: monthLabel(m.month) });
  }
  monthSheet.addRow({ ...byMonth.total, month: `Total — ${period.label}` }).font = {
    bold: true,
  };

  const linesSheet = workbook.addWorksheet("Journal Lines");
  linesSheet.columns = [
    { header: "Job", key: "job", width: 32 },
    { header: "QB Company", key: "company", width: 22 },
    { header: "Customer", key: "customer", width: 28 },
    { header: "Type", key: "type", width: 14 },
    { header: "Year", key: "year", width: 8 },
    { header: "Month", key: "month", width: 9 },
    { header: "Date", key: "date", width: 12 },
    { header: "Journal Entry", key: "entry", width: 14 },
    { header: "Account", key: "account", width: 28 },
    { header: "Description", key: "description", width: 40 },
    { header: "Posting", key: "posting", width: 9 },
    { header: "Treatment", key: "treatment", width: 13 },
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
      year: yearOf(l.txn_date as string | null),
      month: l.txn_date ? (l.txn_date as string).slice(0, 7) : "",
      date: l.txn_date ? shortDate(l.txn_date as string) : "",
      entry: (l.qb_doc_number as string | null) ?? `#${l.qb_txn_id}`,
      account: (l.category as string | null) ?? "",
      description: (l.description as string | null) ?? "",
      posting: Number(l.amount ?? 0) < 0 ? "Credit" : "Debit",
      // Capitalized lines are labor credited off by an entry that debits a
      // capital asset; every other line is labor posted (a reversal nets
      // against it).
      treatment: CAP_LABOR_TREATMENT_LABELS[l.treatment as CapLaborTreatment],
      amount: Number(l.amount ?? 0),
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return new Response(Buffer.from(buffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="capitalized-labor-${period.fileTag}.xlsx"`,
    },
  });
}
