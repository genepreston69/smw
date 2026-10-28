import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { capLaborPeriodFromSearch, yearOf } from "@/lib/capitalizedLabor";
import {
  capMaterialByCompany,
  capMaterialByMonth,
  capMaterialDocRef,
  capMaterialJobRows,
  capMaterialKind,
  capMaterialSourceLabel,
  capMaterialTotal,
  CAP_MATERIAL_BUCKET_LABELS,
  CAP_MATERIAL_KIND_LABELS,
  CAP_MATERIAL_TREATMENT_LABELS,
} from "@/lib/capitalizedMaterials";
import { loadCapMaterials } from "@/lib/capitalizedMaterialsServer";
import { shortDate } from "@/lib/format";
import { monthLabel } from "@/lib/financials";

// Excel workbook for the Capitalized Materials page: a Jobs sheet mirroring
// the page's table (with the kind split), By Company and By Month sheets
// mirroring its breakdowns, and an Expense Lines sheet with the line-level
// detail accounting builds the capitalization entry from — all for the
// page's period (the same year / month / from-to params, parsed by
// capLaborPeriod). Reads through loadCapMaterials and rolls up with the
// page's own helpers, so the file matches the screen (on every job — the
// workbook isn't scoped to a tab).
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const period = capLaborPeriodFromSearch(new URL(request.url).searchParams);
  const { jobs, lines } = await loadCapMaterials(supabase, period);
  const jobRows = capMaterialJobRows(jobs, lines);
  const total = capMaterialTotal(jobRows);

  const workbook = new ExcelJS.Workbook();
  const moneyFmt = "#,##0.00";
  const moneyCol = (header: string, key: string, width = 15) => ({
    header,
    key,
    width,
    style: { numFmt: moneyFmt },
  });
  const sheet = (name: string, columns: Partial<ExcelJS.Column>[]) => {
    const ws = workbook.addWorksheet(name);
    ws.columns = columns;
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: "frozen", ySplit: 1 }];
    return ws;
  };
  const totalLabel = `Total — ${period.label}`;

  const jobsSheet = sheet("Jobs", [
    { header: "Job", key: "job", width: 32 },
    { header: "QB Company", key: "company", width: 22 },
    { header: "Customer", key: "customer", width: 28 },
    { header: "Type", key: "type", width: 16 },
    { header: "Transactions", key: "txns", width: 13 },
    { header: "Latest", key: "latest", width: 12 },
    moneyCol("Materials", "materials"),
    moneyCol("Outside Labor", "outsideLabor"),
    moneyCol("Other Expenses", "other"),
    moneyCol("Expensed", "expensed"),
    moneyCol("Already Capitalized", "capitalized", 18),
    moneyCol("Awaiting Review", "net"),
  ]);
  // Biggest dollars first, matching the page's sort.
  for (const r of jobRows) {
    jobsSheet.addRow({
      ...r,
      job: r.name,
      company: r.companyName ?? r.realmId ?? "",
      customer: r.customerName ?? "",
      type: CAP_MATERIAL_BUCKET_LABELS[r.bucket],
      txns: r.txnCount,
      latest: r.latestDate ? shortDate(r.latestDate) : "",
    });
  }
  jobsSheet.addRow({ ...total, job: totalLabel }).font = { bold: true };

  const rollupColumns = (first: string, key: string, width: number) => [
    { header: first, key, width },
    { header: "Jobs", key: "jobs", width: 8 },
    { header: "Transactions", key: "txns", width: 13 },
    moneyCol("Materials", "materials"),
    moneyCol("Outside Labor", "outsideLabor"),
    moneyCol("Other Expenses", "other"),
    moneyCol("Expensed", "expensed"),
    moneyCol("Already Capitalized", "capitalized", 18),
    moneyCol("Awaiting Review", "net"),
  ];

  const companySheet = sheet("By Company", rollupColumns("QB Company", "company", 28));
  for (const c of capMaterialByCompany(jobRows)) companySheet.addRow(c);
  companySheet.addRow({ ...total, company: totalLabel }).font = { bold: true };

  const byMonth = capMaterialByMonth(period, lines, (jobId) => jobs.has(jobId));
  const monthSheet = sheet("By Month", rollupColumns("Month", "month", 14));
  for (const m of byMonth.rows) monthSheet.addRow({ ...m, month: monthLabel(m.month) });
  monthSheet.addRow({ ...byMonth.total, month: totalLabel }).font = { bold: true };

  const linesSheet = sheet("Expense Lines", [
    { header: "Job", key: "job", width: 32 },
    { header: "QB Company", key: "company", width: 22 },
    { header: "Customer", key: "customer", width: 28 },
    { header: "Type", key: "type", width: 16 },
    { header: "Year", key: "year", width: 8 },
    { header: "Month", key: "month", width: 9 },
    { header: "Date", key: "date", width: 12 },
    { header: "Transaction", key: "source", width: 14 },
    { header: "Doc Number", key: "doc", width: 13 },
    { header: "Vendor", key: "vendor", width: 26 },
    { header: "Account / Item", key: "account", width: 30 },
    { header: "Description", key: "description", width: 40 },
    { header: "Kind", key: "kind", width: 15 },
    { header: "Treatment", key: "treatment", width: 12 },
    moneyCol("Amount", "amount", 14),
  ]);
  for (const l of lines) {
    const job = jobs.get(l.job_id);
    if (!job) continue;
    linesSheet.addRow({
      job: job.name,
      company: job.companyName ?? job.realmId ?? "",
      customer: job.customerName ?? "",
      type: CAP_MATERIAL_BUCKET_LABELS[job.bucket],
      year: yearOf(l.txn_date),
      month: l.txn_date ? l.txn_date.slice(0, 7) : "",
      date: l.txn_date ? shortDate(l.txn_date) : "",
      source: capMaterialSourceLabel(l.qb_txn_type),
      doc: capMaterialDocRef(l),
      vendor: l.vendor_name ?? "",
      account: l.category ?? "",
      description: l.description ?? "",
      kind: CAP_MATERIAL_KIND_LABELS[capMaterialKind(l)],
      // Capitalized lines are cost credited off by an entry that debits a
      // capital asset; every other line is expensed (a refund, credit or
      // reversal nets against it).
      treatment: CAP_MATERIAL_TREATMENT_LABELS[l.treatment],
      amount: l.amount,
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return new Response(Buffer.from(buffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="capitalized-materials-${period.fileTag}.xlsx"`,
    },
  });
}
