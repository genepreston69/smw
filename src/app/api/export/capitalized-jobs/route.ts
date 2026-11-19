import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { csvResponse, toCsv } from "@/lib/csv";
import {
  capLaborPeriodFromSearch,
  CAP_LABOR_BUCKET_LABELS,
  yearOf,
} from "@/lib/capitalizedLabor";
import {
  capJobApprovalsErrorMessage,
  capJobDocRef,
  capJobSourceLabel,
  CAP_JOB_KIND_ACCOUNTS,
  CAP_JOB_TREATMENT_LABELS,
} from "@/lib/capitalizedJobs";
import { loadCapJobs } from "@/lib/capitalizedJobsServer";
import { shortDate } from "@/lib/format";

// Line-level export of the Capitalized Jobs page: every counted direct-cost
// line (cap_job_lines, migration 0044) dated in the page's period (the same
// year / month / from-to params, parsed by capLaborPeriod) and posted to a
// non-billable or intercompany job, one row per line, so accounting can build
// the capitalization entry from it. Reads through loadCapJobs, the page's own
// loader, so the file matches the screen.
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const period = capLaborPeriodFromSearch(new URL(request.url).searchParams);
  const { jobs, lines, approvals, approvalsError } = await loadCapJobs(supabase, period);
  // A file would show the failed read as "not approved", so it fails instead.
  if (approvalsError) {
    return NextResponse.json(
      { error: capJobApprovalsErrorMessage(approvalsError) },
      { status: 503 },
    );
  }

  const csv = toCsv(
    [
      "Job",
      "QB Company",
      "Customer",
      "Type",
      "Approved",
      "Year",
      "Month",
      "Date",
      "Source",
      "Reference",
      "Vendor",
      "Direct Cost Account",
      "Account / Item",
      "Description",
      "Posting",
      "Treatment",
      "Amount",
    ],
    lines.map((l) => {
      const job = jobs.get(l.job_id)!;
      return [
        job.name,
        job.companyName ?? job.realmId ?? "",
        job.customerName,
        CAP_LABOR_BUCKET_LABELS[job.bucket],
        approvals.has(job.id) ? "Yes" : "",
        // Calendar year and month, so the export pivots the same way the
        // page's by-month breakdown splits the totals.
        l.txn_date ? String(yearOf(l.txn_date) ?? "") : "",
        l.txn_date ? l.txn_date.slice(0, 7) : "",
        l.txn_date ? shortDate(l.txn_date) : "",
        capJobSourceLabel(l.qb_txn_type),
        capJobDocRef(l),
        l.vendor_name,
        CAP_JOB_KIND_ACCOUNTS[l.kind],
        l.category,
        l.description,
        l.amount < 0 ? "Credit" : "Debit",
        // Capitalized lines are cost credited off by an entry that debits a
        // capital asset; every other line is cost posted (a refund, credit
        // or reversal nets against it).
        CAP_JOB_TREATMENT_LABELS[l.treatment],
        l.amount.toFixed(2),
      ];
    }),
  );

  return csvResponse(csv, `capitalized-jobs-${period.fileTag}.csv`);
}
