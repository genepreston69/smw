import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
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

  const [{ data: jobs }, { data: connRows }, { data: costRows }] =
    await Promise.all([
      supabase
        .from("jobs")
        .select(
          "id, name, realm_id, active, last_synced_at, customer:customers(display_name, company_name)",
        )
        .order("name"),
      supabase.from("qb_connection_status").select("realm_id, company_name"),
      supabase
        .from("job_cost_totals")
        .select(
          "job_id, total_amount, total_hours, materials_amount, labor_amount, other_amount",
        ),
    ]);

  const companyByRealm = new Map(
    (connRows ?? []).map((c) => [c.realm_id, c.company_name]),
  );
  const costByJob = new Map(
    (costRows ?? []).map((r) => [
      r.job_id as string,
      {
        amount: Number(r.total_amount ?? 0),
        hours: Number(r.total_hours ?? 0),
        materials: Number(r.materials_amount ?? 0),
        labor: Number(r.labor_amount ?? 0),
        other: Number(r.other_amount ?? 0),
      },
    ]),
  );

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
    intercompany: [],
    nonbillable: [],
    notransactions: [],
  };
  for (const j of (jobs ?? []) as unknown as Row[]) {
    grouped[
      classifyJobView({
        name: j.name,
        customerDisplayName: j.customer?.display_name,
        customerCompanyName: j.customer?.company_name,
        hasTransactions: costByJob.has(j.id),
      })
    ].push(j);
  }

  const workbook = new ExcelJS.Workbook();
  const moneyFmt = "#,##0.00";

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
      { header: "Active", key: "active", width: 9 },
      { header: "Last Synced", key: "synced", width: 14 },
    ];
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: "frozen", ySplit: 1 }];

    for (const j of grouped[view]) {
      const cost = costByJob.get(j.id);
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
