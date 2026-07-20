import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/fetchAll";
import { csvResponse, toCsv } from "@/lib/csv";
import { capLaborBucket, CAP_LABOR_BUCKET_LABELS } from "@/lib/capitalizedLabor";
import { shortDate } from "@/lib/format";

// Line-level export of capitalized-labor candidates: every journal-entry
// labor line posted to a non-billable or intercompany job, one row per line,
// so accounting can build the capitalization entry from it. Must bucket
// identically to the dashboard (src/app/(app)/capitalized-labor/) — the rule
// lives in src/lib/capitalizedLabor.ts.
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Paged reads so the CSV includes every row past Supabase's 1000-row cap.
  const [jobs, { data: connRows }, lines] = await Promise.all([
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
      supabase
        .from("job_costs")
        .select(
          "id, job_id, qb_txn_id, qb_doc_number, txn_date, description, category, amount",
        )
        .eq("qb_txn_type", "JournalEntry")
        .eq("cost_type", "labor")
        .order("txn_date", { ascending: false, nullsFirst: false })
        .order("id")
        .range(from, to),
    ),
  ]);

  const companyByRealm = new Map(
    (connRows ?? []).map((c) => [c.realm_id, c.company_name]),
  );

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
    });
    if (bucket) candidateByJob.set(j.id, { job: j, bucket });
  }

  const csv = toCsv(
    [
      "Job",
      "QB Company",
      "Customer",
      "Type",
      "Date",
      "Journal Entry",
      "Account",
      "Description",
      "Amount",
    ],
    lines.flatMap((l) => {
      const candidate = candidateByJob.get(l.job_id as string);
      if (!candidate) return [];
      const { job, bucket } = candidate;
      return [
        [
          job.name,
          job.realm_id ? (companyByRealm.get(job.realm_id) ?? job.realm_id) : "",
          job.customer?.display_name,
          CAP_LABOR_BUCKET_LABELS[bucket],
          l.txn_date ? shortDate(l.txn_date as string) : "",
          (l.qb_doc_number as string | null) ?? `#${l.qb_txn_id}`,
          l.category as string | null,
          l.description as string | null,
          Number(l.amount ?? 0).toFixed(2),
        ],
      ];
    }),
  );

  return csvResponse(csv, "capitalized-labor.csv");
}
