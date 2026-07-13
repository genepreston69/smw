import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/fetchAll";
import { getCustomerSummary } from "@/lib/customerSummary";
import { shortDate } from "@/lib/format";
import {
  JOB_VIEWS,
  JOB_VIEW_LABELS,
  classifyJobView,
  type JobView,
} from "@/lib/jobViews";

// One workbook, one sheet per Jobs dashboard view.
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Paged reads so the workbook includes every job past Supabase's
  // 1000-row cap; the dashboard (src/app/(app)/jobs/page.tsx) does the same.
  const [jobs, { data: connRows }, costRows, invRows] = await Promise.all([
    fetchAllRows((from, to) =>
      supabase
        .from("jobs")
        .select(
          "id, name, realm_id, active, last_synced_at, customer:customers(display_name, company_name)",
        )
        .order("name")
        .order("id")
        .range(from, to),
    ),
    supabase.from("qb_connection_status").select("realm_id, company_name"),
    fetchAllRows((from, to) =>
      supabase
        .from("job_cost_totals")
        .select(
          "job_id, total_amount, total_hours, materials_amount, labor_amount, other_amount, latest_txn_date",
        )
        .order("job_id")
        .range(from, to),
    ),
    fetchAllRows((from, to) =>
      supabase
        .from("job_invoice_totals")
        .select("job_id, total_invoiced, latest_invoice_date")
        .order("job_id")
        .range(from, to),
    ),
  ]);

  const companyByRealm = new Map(
    (connRows ?? []).map((c) => [c.realm_id, c.company_name]),
  );
  const costByJob = new Map(
    costRows.map((r) => [
      r.job_id as string,
      {
        amount: Number(r.total_amount ?? 0),
        hours: Number(r.total_hours ?? 0),
        materials: Number(r.materials_amount ?? 0),
        labor: Number(r.labor_amount ?? 0),
        other: Number(r.other_amount ?? 0),
        latestTxnDate: (r.latest_txn_date as string | null) ?? null,
      },
    ]),
  );
  const invoiceByJob = new Map(
    invRows.map((r) => [
      r.job_id as string,
      {
        invoiced: Number(r.total_invoiced ?? 0),
        latestInvoiceDate: (r.latest_invoice_date as string | null) ?? null,
      },
    ]),
  );

  // Latest activity across costs and invoices (YYYY-MM-DD string compare).
  const latestTxnDate = (jobId: string): string | null => {
    const cost = costByJob.get(jobId)?.latestTxnDate ?? null;
    const inv = invoiceByJob.get(jobId)?.latestInvoiceDate ?? null;
    if (cost && inv) return cost >= inv ? cost : inv;
    return cost ?? inv;
  };

  interface Row {
    id: string;
    name: string;
    realm_id: string | null;
    active: boolean;
    last_synced_at: string | null;
    customer: { display_name: string; company_name: string | null } | null;
  }

  const grouped: Record<JobView, Row[]> = {
    customer: [],
    transportation: [],
    intercompany: [],
    nonbillable: [],
    notransactions: [],
  };
  for (const j of jobs as unknown as Row[]) {
    grouped[
      classifyJobView({
        name: j.name,
        customerDisplayName: j.customer?.display_name,
        customerCompanyName: j.customer?.company_name,
        latestTxnDate: latestTxnDate(j.id),
      })
    ].push(j);
  }

  const workbook = new ExcelJS.Workbook();
  const moneyFmt = "#,##0.00";

  // First sheet: per-customer rollup, same aggregation as /customers/summary.
  const summary = await getCustomerSummary(supabase);
  const summarySheet = workbook.addWorksheet("Customer Summary");
  summarySheet.columns = [
    { header: "Customer", key: "customer", width: 32 },
    { header: "QB Company", key: "company", width: 22 },
    { header: "Intercompany", key: "intercompany", width: 13 },
    { header: "Jobs", key: "jobs", width: 8 },
    { header: "Materials", key: "materials", width: 14, style: { numFmt: moneyFmt } },
    { header: "Direct Labor", key: "labor", width: 14, style: { numFmt: moneyFmt } },
    { header: "Other Direct Costs", key: "other", width: 18, style: { numFmt: moneyFmt } },
    { header: "Actual Cost", key: "cost", width: 14, style: { numFmt: moneyFmt } },
    { header: "Actual Hours", key: "hours", width: 13, style: { numFmt: "#,##0.0" } },
    { header: "Invoiced Revenue", key: "invoiced", width: 16, style: { numFmt: moneyFmt } },
    { header: "Net", key: "net", width: 14, style: { numFmt: moneyFmt } },
  ];
  summarySheet.getRow(1).font = { bold: true };
  summarySheet.views = [{ state: "frozen", ySplit: 1 }];
  for (const r of summary.rows) {
    summarySheet.addRow({
      customer: r.name,
      company: r.companyName ?? "",
      intercompany: r.intercompany ? "Yes" : "No",
      jobs: r.jobs,
      materials: r.materials,
      labor: r.labor,
      other: r.other,
      cost: r.cost,
      hours: r.hours > 0 ? r.hours : null,
      invoiced: r.invoiced,
      net: r.net,
    });
  }
  const totalRow = summarySheet.addRow({
    customer: "Total",
    jobs: summary.totals.jobs,
    materials: summary.totals.materials,
    labor: summary.totals.labor,
    other: summary.totals.other,
    cost: summary.totals.cost,
    hours: summary.totals.hours > 0 ? summary.totals.hours : null,
    invoiced: summary.totals.invoiced,
    net: summary.totals.net,
  });
  totalRow.font = { bold: true };

  for (const view of JOB_VIEWS) {
    const sheet = workbook.addWorksheet(JOB_VIEW_LABELS[view]);
    sheet.columns = [
      { header: "Job", key: "job", width: 32 },
      { header: "QB Company", key: "company", width: 22 },
      { header: "Customer", key: "customer", width: 28 },
      { header: "Materials", key: "materials", width: 14, style: { numFmt: moneyFmt } },
      { header: "Direct Labor", key: "labor", width: 14, style: { numFmt: moneyFmt } },
      { header: "Other Direct Costs", key: "other", width: 18, style: { numFmt: moneyFmt } },
      { header: "Actual Cost", key: "total", width: 14, style: { numFmt: moneyFmt } },
      { header: "Actual Hours", key: "hours", width: 13, style: { numFmt: "#,##0.0" } },
      { header: "Invoiced Revenue", key: "invoiced", width: 16, style: { numFmt: moneyFmt } },
      { header: "Latest Transaction", key: "latest", width: 17 },
      { header: "Active", key: "active", width: 9 },
      { header: "Last Synced", key: "synced", width: 14 },
    ];
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: "frozen", ySplit: 1 }];

    for (const j of grouped[view]) {
      const cost = costByJob.get(j.id);
      const invoice = invoiceByJob.get(j.id);
      const latest = latestTxnDate(j.id);
      sheet.addRow({
        job: j.name,
        company: j.realm_id
          ? (companyByRealm.get(j.realm_id) ?? j.realm_id)
          : "",
        customer: j.customer?.display_name ?? "",
        materials: cost ? cost.materials : null,
        labor: cost ? cost.labor : null,
        other: cost ? cost.other : null,
        total: cost ? cost.amount : null,
        hours: cost && cost.hours > 0 ? cost.hours : null,
        invoiced: invoice ? invoice.invoiced : null,
        latest: latest ? shortDate(latest) : "",
        active: j.active ? "Yes" : "No",
        synced: j.last_synced_at ? shortDate(j.last_synced_at) : "",
      });
    }
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return new Response(Buffer.from(buffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="jobs-workbook.xlsx"',
    },
  });
}
