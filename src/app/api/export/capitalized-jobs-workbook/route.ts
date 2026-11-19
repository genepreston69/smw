import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  capLaborPeriodFromSearch,
  CAP_LABOR_BUCKET_LABELS,
  yearOf,
} from "@/lib/capitalizedLabor";
import {
  capJobApprovalsErrorMessage,
  capJobDocRef,
  capJobRows,
  capJobSourceLabel,
  capJobTotal,
  capJobsByMonth,
  CAP_JOB_KINDS,
  CAP_JOB_KIND_ACCOUNTS,
  CAP_JOB_KIND_LABELS,
  CAP_JOB_TREATMENT_LABELS,
} from "@/lib/capitalizedJobs";
import { loadCapJobs } from "@/lib/capitalizedJobsServer";
import { shortDate } from "@/lib/format";
import { monthLabel } from "@/lib/financials";

// Excel workbook for the Capitalized Jobs page: a Jobs sheet mirroring the
// page's table, a By Month sheet mirroring its by-month breakdown, and a Cost
// Lines sheet with the line-level detail accounting builds the capitalization
// entry from — all for the page's period (the same year / month / from-to
// params, parsed by capLaborPeriod). Reads through loadCapJobs and rolls up
// with the helpers in src/lib/capitalizedJobs.ts, the page's own, so the
// file matches the screen.
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const period = capLaborPeriodFromSearch(new URL(request.url).searchParams);
  const { jobs, lines, benefits, benefitError, approvals, approvalsError } = await loadCapJobs(
    supabase,
    period,
  );
  // A file would show the failed read as "not approved", so it fails instead.
  if (approvalsError) {
    return NextResponse.json(
      { error: capJobApprovalsErrorMessage(approvalsError) },
      { status: 503 },
    );
  }
  // The page shows a banner; a file would show the failed read as blank
  // Benefit Allocation cells, so it fails instead.
  if (benefitError) throw new Error(`Benefit allocation: ${benefitError}`);

  const rows = capJobRows(jobs, lines, benefits, approvals);
  const total = capJobTotal(rows);

  const workbook = new ExcelJS.Workbook();
  const moneyFmt = "#,##0.00";
  const money = (header: string, key: string, width = 15) => ({
    header,
    key,
    width,
    style: { numFmt: moneyFmt },
  });
  // The Direct Cost columns, then the totals — the same on both sheets.
  const costColumns = [
    ...CAP_JOB_KINDS.map((k) => money(CAP_JOB_KIND_LABELS[k], k, 16)),
    money("Total Cost", "posted"),
    money("Already Capitalized", "capitalized", 18),
    money("Awaiting Review", "net"),
    money("Benefit Allocation", "benefits", 17),
  ];

  const jobsSheet = workbook.addWorksheet("Jobs");
  jobsSheet.columns = [
    { header: "Job", key: "job", width: 32 },
    { header: "QB Company", key: "company", width: 22 },
    { header: "Customer", key: "customer", width: 28 },
    { header: "Type", key: "type", width: 14 },
    { header: "Transactions", key: "txns", width: 13 },
    { header: "Latest", key: "latest", width: 13 },
    ...costColumns,
    { header: "Approved", key: "approved", width: 10 },
    { header: "Approved By", key: "approvedBy", width: 24 },
    { header: "Approved On", key: "approvedOn", width: 13 },
  ];
  jobsSheet.getRow(1).font = { bold: true };
  jobsSheet.views = [{ state: "frozen", ySplit: 1 }];
  // Biggest dollars first, the page's order.
  for (const r of rows) {
    jobsSheet.addRow({
      ...r,
      job: r.name,
      company: r.companyName ?? r.realmId ?? "",
      customer: r.customerName ?? "",
      type: CAP_LABOR_BUCKET_LABELS[r.bucket],
      txns: r.txnCount,
      latest: r.latestDate ? shortDate(r.latestDate) : "",
      benefits: r.benefitAllocation,
      approved: r.approval ? "Yes" : "",
      approvedBy: r.approval?.by ?? "",
      approvedOn: r.approval ? shortDate(r.approval.at.slice(0, 10)) : "",
    });
  }
  jobsSheet.addRow({ ...total, job: `Total — ${period.label}` }).font = { bold: true };

  // The page's by-month breakdown, over every candidate job (the workbook
  // isn't scoped to a tab).
  const listed = new Set(rows.map((r) => r.id));
  const byMonth = capJobsByMonth(period, lines, benefits, (jobId) => listed.has(jobId));
  const monthSheet = workbook.addWorksheet("By Month");
  monthSheet.columns = [
    { header: "Month", key: "month", width: 14 },
    { header: "Jobs", key: "jobs", width: 8 },
    { header: "Transactions", key: "txns", width: 13 },
    ...costColumns,
  ];
  monthSheet.getRow(1).font = { bold: true };
  monthSheet.views = [{ state: "frozen", ySplit: 1 }];
  for (const m of byMonth.rows) {
    monthSheet.addRow({ ...m, month: monthLabel(m.month) });
  }
  monthSheet.addRow({ ...byMonth.total, month: `Total — ${period.label}` }).font = {
    bold: true,
  };

  const linesSheet = workbook.addWorksheet("Cost Lines");
  linesSheet.columns = [
    { header: "Job", key: "job", width: 32 },
    { header: "QB Company", key: "company", width: 22 },
    { header: "Customer", key: "customer", width: 28 },
    { header: "Type", key: "type", width: 14 },
    { header: "Approved", key: "approved", width: 10 },
    { header: "Year", key: "year", width: 8 },
    { header: "Month", key: "month", width: 9 },
    { header: "Date", key: "date", width: 12 },
    { header: "Source", key: "source", width: 14 },
    { header: "Reference", key: "ref", width: 14 },
    { header: "Vendor", key: "vendor", width: 26 },
    { header: "Direct Cost Account", key: "kind", width: 22 },
    { header: "Account / Item", key: "account", width: 28 },
    { header: "Description", key: "description", width: 40 },
    { header: "Posting", key: "posting", width: 9 },
    { header: "Treatment", key: "treatment", width: 13 },
    money("Amount", "amount", 14),
  ];
  linesSheet.getRow(1).font = { bold: true };
  linesSheet.views = [{ state: "frozen", ySplit: 1 }];
  for (const l of lines) {
    const job = jobs.get(l.job_id)!;
    linesSheet.addRow({
      job: job.name,
      company: job.companyName ?? job.realmId ?? "",
      customer: job.customerName ?? "",
      type: CAP_LABOR_BUCKET_LABELS[job.bucket],
      approved: approvals.has(job.id) ? "Yes" : "",
      year: yearOf(l.txn_date),
      month: l.txn_date ? l.txn_date.slice(0, 7) : "",
      date: l.txn_date ? shortDate(l.txn_date) : "",
      source: capJobSourceLabel(l.qb_txn_type),
      ref: capJobDocRef(l),
      vendor: l.vendor_name ?? "",
      kind: CAP_JOB_KIND_ACCOUNTS[l.kind],
      account: l.category ?? "",
      description: l.description ?? "",
      posting: l.amount < 0 ? "Credit" : "Debit",
      // Capitalized lines are cost credited off by an entry that debits a
      // capital asset; every other line is cost posted (a refund, credit or
      // reversal nets against it).
      treatment: CAP_JOB_TREATMENT_LABELS[l.treatment],
      amount: l.amount,
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return new Response(Buffer.from(buffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="capitalized-jobs-${period.fileTag}.xlsx"`,
    },
  });
}
