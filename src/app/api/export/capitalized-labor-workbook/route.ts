import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/fetchAll";
import {
  capLaborAmounts,
  capLaborBucket,
  capLaborYears,
  CAP_LABOR_BUCKET_LABELS,
  CAP_LABOR_TREATMENT_LABELS,
  yearOf,
  type CapLaborTreatment,
} from "@/lib/capitalizedLabor";
import { shortDate } from "@/lib/format";

// Excel workbook for the Capitalized Labor dashboard: a Jobs sheet mirroring
// the dashboard table (all-time amounts), a By Year sheet mirroring its
// by-year breakdown, and a Journal Lines sheet with the line-level detail
// accounting builds the capitalization entry from. Must bucket identically to
// the dashboard (src/app/(app)/capitalized-labor/) and the CSV export — the
// rule lives in src/lib/capitalizedLabor.ts.
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Paged reads so the workbook includes every row past Supabase's 1000-row cap.
  const [jobs, { data: connRows }, lines, { data: benefitData }] = await Promise.all([
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
      // Counted journal lines only — wages and employer taxes, each tagged
      // posted or capitalized; withholdings never appear (migration 0030).
      supabase
        .from("cap_labor_lines")
        .select(
          "id, job_id, qb_txn_id, qb_doc_number, txn_date, description, category, amount, treatment",
        )
        .order("txn_date", { ascending: false, nullsFirst: false })
        .order("id")
        .range(from, to),
    ),
    // Employee-benefit allocation per job and calendar year, in one
    // statement (migration 0024) — same figure as the dashboard's Benefit
    // allocation column, and summing a job's years gives its all-time
    // total. Reading the month-grain view row by row instead re-ran the
    // whole allocation once per page of results.
    supabase.rpc("job_benefit_allocation_summary"),
  ]);

  const companyByRealm = new Map(
    (connRows ?? []).map((c) => [c.realm_id, c.company_name]),
  );
  // Compact [job, year, amount] tuples, covering every year of history.
  const benefitYears =
    ((benefitData ?? {}) as { years?: [string, number, number][] }).years ?? [];
  const benefitByJob = new Map<string, number>();
  const benefitByJobYear = new Map<string, Map<number, number>>();
  for (const [jobId, year, raw] of benefitYears) {
    const amount = Number(raw ?? 0);
    benefitByJob.set(jobId, (benefitByJob.get(jobId) ?? 0) + amount);
    let perYear = benefitByJobYear.get(jobId);
    if (!perYear) benefitByJobYear.set(jobId, (perYear = new Map()));
    perYear.set(year, (perYear.get(year) ?? 0) + amount);
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
  // The same rollup split by calendar year, for the By Year sheet — the
  // dashboard's by-year breakdown in workbook form.
  interface YearAgg {
    posted: number;
    capitalized: number;
    entryIds: Set<string>;
    jobIds: Set<string>;
  }
  const aggByYear = new Map<number, YearAgg>();
  let earliestDate: string | null = null;
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
    if (date && (!earliestDate || date < earliestDate)) earliestDate = date;
    const year = yearOf(date);
    if (year != null) {
      let yearAgg = aggByYear.get(year);
      if (!yearAgg) {
        aggByYear.set(
          year,
          (yearAgg = {
            posted: 0,
            capitalized: 0,
            entryIds: new Set(),
            jobIds: new Set(),
          }),
        );
      }
      yearAgg.posted += split.posted;
      yearAgg.capitalized += split.capitalized;
      yearAgg.entryIds.add(l.qb_txn_id as string);
      yearAgg.jobIds.add(jobId);
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
    job: "Total",
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

  // By Year: the dashboard's by-year breakdown — every calendar year of
  // imported history, candidate jobs only.
  const yearSheet = workbook.addWorksheet("By Year");
  yearSheet.columns = [
    { header: "Year", key: "year", width: 10 },
    { header: "Jobs", key: "jobs", width: 9 },
    { header: "Entries", key: "entries", width: 9 },
    { header: "Labor Posted", key: "posted", width: 14, style: { numFmt: moneyFmt } },
    { header: "Already Capitalized", key: "capitalized", width: 18, style: { numFmt: moneyFmt } },
    { header: "Awaiting Review", key: "net", width: 15, style: { numFmt: moneyFmt } },
    { header: "Benefit Allocation", key: "benefits", width: 17, style: { numFmt: moneyFmt } },
  ];
  yearSheet.getRow(1).font = { bold: true };
  yearSheet.views = [{ state: "frozen", ySplit: 1 }];

  const candidateBenefitYear = (year: number) => {
    let sum = 0;
    for (const jobId of candidateByJob.keys()) {
      sum += benefitByJobYear.get(jobId)?.get(year) ?? 0;
    }
    return sum;
  };
  const yearTotals = { entries: 0, posted: 0, capitalized: 0, benefits: 0 };
  for (const year of capLaborYears(earliestDate)) {
    const agg = aggByYear.get(year);
    const benefits = candidateBenefitYear(year);
    const posted = agg?.posted ?? 0;
    const capitalized = agg?.capitalized ?? 0;
    yearSheet.addRow({
      year,
      jobs: agg?.jobIds.size ?? 0,
      entries: agg?.entryIds.size ?? 0,
      posted,
      capitalized,
      net: posted - capitalized,
      benefits,
    });
    yearTotals.entries += agg?.entryIds.size ?? 0;
    yearTotals.posted += posted;
    yearTotals.capitalized += capitalized;
    yearTotals.benefits += benefits;
  }
  const yearTotalRow = yearSheet.addRow({
    year: "All years",
    // A job active across several years counts once per year above, so the
    // total counts distinct jobs rather than summing the year rows.
    jobs: aggByJob.size,
    entries: yearTotals.entries,
    posted: yearTotals.posted,
    capitalized: yearTotals.capitalized,
    net: yearTotals.posted - yearTotals.capitalized,
    benefits: yearTotals.benefits,
  });
  yearTotalRow.font = { bold: true };

  const linesSheet = workbook.addWorksheet("Journal Lines");
  linesSheet.columns = [
    { header: "Job", key: "job", width: 32 },
    { header: "QB Company", key: "company", width: 22 },
    { header: "Customer", key: "customer", width: 28 },
    { header: "Type", key: "type", width: 14 },
    { header: "Year", key: "year", width: 8 },
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
      "Content-Disposition": 'attachment; filename="capitalized-labor.xlsx"',
    },
  });
}
