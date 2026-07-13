import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { csvResponse, toCsv } from "@/lib/csv";
import { getCustomerSummary } from "@/lib/customerSummary";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { rows, totals } = await getCustomerSummary(supabase);

  const csv = toCsv(
    [
      "Customer",
      "QB Company",
      "Intercompany",
      "Jobs",
      "Materials",
      "Direct Labor",
      "Contract Services",
      "Actual Cost",
      "Actual Hours",
      "Invoiced Revenue",
      "Net",
    ],
    [
      ...rows.map((r) => [
        r.name,
        r.companyName ?? "",
        r.intercompany ? "Yes" : "No",
        String(r.jobs),
        r.materials.toFixed(2),
        r.labor.toFixed(2),
        r.other.toFixed(2),
        r.cost.toFixed(2),
        r.hours > 0 ? r.hours.toFixed(1) : "",
        r.invoiced.toFixed(2),
        r.net.toFixed(2),
      ]),
      [
        "Total",
        "",
        "",
        String(totals.jobs),
        totals.materials.toFixed(2),
        totals.labor.toFixed(2),
        totals.other.toFixed(2),
        totals.cost.toFixed(2),
        totals.hours > 0 ? totals.hours.toFixed(1) : "",
        totals.invoiced.toFixed(2),
        totals.net.toFixed(2),
      ],
    ],
  );

  return csvResponse(csv, "customer-summary.csv");
}
