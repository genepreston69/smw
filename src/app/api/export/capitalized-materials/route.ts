import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { csvResponse, toCsv } from "@/lib/csv";
import { capLaborPeriodFromSearch, yearOf } from "@/lib/capitalizedLabor";
import {
  capMaterialDocRef,
  capMaterialKind,
  capMaterialSourceLabel,
  CAP_MATERIAL_BUCKET_LABELS,
  CAP_MATERIAL_KIND_LABELS,
  CAP_MATERIAL_TREATMENT_LABELS,
} from "@/lib/capitalizedMaterials";
import { loadCapMaterials } from "@/lib/capitalizedMaterialsServer";
import { shortDate } from "@/lib/format";

// Line-level export of capitalized-materials candidates: every expense line
// cap_material_lines counts (migration 0036) on a non-billable job in any
// QuickBooks company, dated in the page's period (the same year / month /
// from-to params, parsed by capLaborPeriod), one row per line, so accounting
// can build the capitalization entry from it. Reads through loadCapMaterials,
// the page's own loader, so the file matches the screen.
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

  const csv = toCsv(
    [
      "Job",
      "QB Company",
      "Customer",
      "Type",
      "Year",
      "Month",
      "Date",
      "Transaction",
      "Doc Number",
      "Vendor",
      "Account / Item",
      "Description",
      "Kind",
      "Treatment",
      "Amount",
    ],
    lines.flatMap((l) => {
      const job = jobs.get(l.job_id);
      if (!job) return [];
      return [
        [
          job.name,
          job.companyName ?? job.realmId ?? "",
          job.customerName,
          CAP_MATERIAL_BUCKET_LABELS[job.bucket],
          // Calendar year and month, so the export pivots the same way the
          // page's by-month breakdown splits the totals.
          l.txn_date ? String(yearOf(l.txn_date) ?? "") : "",
          l.txn_date ? l.txn_date.slice(0, 7) : "",
          l.txn_date ? shortDate(l.txn_date) : "",
          capMaterialSourceLabel(l.qb_txn_type),
          capMaterialDocRef(l),
          l.vendor_name,
          l.category,
          l.description,
          CAP_MATERIAL_KIND_LABELS[capMaterialKind(l)],
          // Capitalized lines are cost credited off by an entry that debits a
          // capital asset; every other line is expensed (a refund, credit or
          // reversal nets against it).
          CAP_MATERIAL_TREATMENT_LABELS[l.treatment],
          l.amount.toFixed(2),
        ],
      ];
    }),
  );

  return csvResponse(csv, `capitalized-materials-${period.fileTag}.csv`);
}
