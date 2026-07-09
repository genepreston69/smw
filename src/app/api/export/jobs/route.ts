import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { csvResponse, toCsv } from "@/lib/csv";
import { isEnterpriseName } from "@/lib/enterprise";
import { shortDate } from "@/lib/format";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [{ data: jobs }, { data: connRows }, { data: costRows }, { data: invRows }] =
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
          "job_id, total_amount, total_hours, materials_amount, labor_amount, other_amount, latest_txn_date",
        ),
      supabase
        .from("job_invoice_totals")
        .select("job_id, total_invoiced, latest_invoice_date"),
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
        latestTxnDate: (r.latest_txn_date as string | null) ?? null,
      },
    ]),
  );
  const invoiceByJob = new Map(
    (invRows ?? []).map((r) => [
      r.job_id as string,
      {
        invoiced: Number(r.total_invoiced ?? 0),
        latestInvoiceDate: (r.latest_invoice_date as string | null) ?? null,
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

  const csv = toCsv(
    [
      "Job",
      "QB Company",
      "Customer",
      "Intercompany",
      "Materials",
      "Labor",
      "Other Direct Costs",
      "Actual Cost",
      "Actual Hours",
      "Invoiced Revenue",
      "Latest Transaction",
      "Active",
      "Last Synced",
    ],
    ((jobs ?? []) as unknown as Row[]).map((j) => {
      const cost = costByJob.get(j.id);
      const invoice = invoiceByJob.get(j.id);
      const latestCost = cost?.latestTxnDate ?? null;
      const latestInv = invoice?.latestInvoiceDate ?? null;
      const latest =
        latestCost && latestInv
          ? latestCost >= latestInv
            ? latestCost
            : latestInv
          : (latestCost ?? latestInv);
      return [
        j.name,
        j.realm_id ? (companyByRealm.get(j.realm_id) ?? j.realm_id) : "",
        j.customer?.display_name,
        isEnterpriseName(j.customer?.display_name) ||
        isEnterpriseName(j.customer?.company_name)
          ? "Yes"
          : "No",
        cost ? cost.materials.toFixed(2) : "",
        cost ? cost.labor.toFixed(2) : "",
        cost ? cost.other.toFixed(2) : "",
        cost ? cost.amount.toFixed(2) : "",
        cost && cost.hours > 0 ? cost.hours.toFixed(1) : "",
        invoice ? invoice.invoiced.toFixed(2) : "",
        latest ? shortDate(latest) : "",
        j.active ? "Yes" : "No",
        j.last_synced_at ? shortDate(j.last_synced_at) : "",
      ];
    }),
  );

  return csvResponse(csv, "jobs.csv");
}
