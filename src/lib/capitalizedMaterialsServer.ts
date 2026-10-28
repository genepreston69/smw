import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/supabase/fetchAll";
import type { CapLaborWindow } from "@/lib/capitalizedLabor";
import {
  capMaterialBucket,
  parseCapMaterialLines,
  CAP_MATERIAL_LINE_COLUMNS,
  type CapMaterialJob,
  type CapMaterialLine,
} from "@/lib/capitalizedMaterials";

// Job ids per line read. The list rides in the request URL, so it is kept
// well under the gateway's limit; each read is an index range scan on
// job_costs_job_date_idx (job_id, txn_date).
const JOB_CHUNK = 100;

export interface CapMaterials {
  /** Every non-billable job in every QuickBooks company. */
  jobs: Map<string, CapMaterialJob>;
  /** Their counted lines (cap_material_lines) dated in the period, newest
      first. */
  lines: CapMaterialLine[];
  /** More than one QuickBooks company is connected. */
  multiCompany: boolean;
}

/**
 * Shared by the Capitalized Materials page and both exports so all three
 * see exactly the same jobs and lines. Job costs are readable by any
 * signed-in user (RLS), so callers pass the user's own client.
 */
export async function loadCapMaterials(
  db: SupabaseClient,
  period: CapLaborWindow,
): Promise<CapMaterials> {
  // Paged reads (fetchAllRows) so nothing is cut off at Supabase's 1000-row
  // cap; .order("id") tie-breaks for stable pages.
  const [jobRows, { data: connRows, error: connError }] = await Promise.all([
    fetchAllRows((from, to) =>
      db
        .from("jobs")
        .select(
          "id, name, realm_id, customer:customers(display_name, company_name)",
        )
        .order("name")
        .order("id")
        .range(from, to),
    ),
    db.from("qb_connection_status").select("realm_id, company_name"),
  ]);
  if (connError) throw new Error(connError.message);

  const companyByRealm = new Map(
    ((connRows ?? []) as { realm_id: string; company_name: string | null }[]).map(
      (c) => [c.realm_id, c.company_name],
    ),
  );

  const jobs = new Map<string, CapMaterialJob>();
  for (const j of jobRows as unknown as {
    id: string;
    name: string;
    realm_id: string | null;
    customer: { display_name: string; company_name: string | null } | null;
  }[]) {
    const companyName = (j.realm_id && companyByRealm.get(j.realm_id)) || null;
    const bucket = capMaterialBucket({
      name: j.name,
      customerDisplayName: j.customer?.display_name,
      customerCompanyName: j.customer?.company_name,
      qbCompanyName: companyName,
    });
    if (!bucket) continue;
    jobs.set(j.id, {
      id: j.id,
      name: j.name,
      realmId: j.realm_id,
      companyName,
      customerName: j.customer?.display_name ?? null,
      bucket,
    });
  }

  // Lines for the non-billable jobs only — reading every job's costs and
  // discarding the billable ones would pull nearly the whole table.
  const ids = [...jobs.keys()];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += JOB_CHUNK) chunks.push(ids.slice(i, i + JOB_CHUNK));
  const pages = await Promise.all(
    chunks.map((chunk) =>
      fetchAllRows((from, to) =>
        db
          .from("cap_material_lines")
          .select(CAP_MATERIAL_LINE_COLUMNS)
          .in("job_id", chunk)
          .gte("txn_date", period.from)
          .lte("txn_date", period.to)
          .order("id")
          .range(from, to),
      ),
    ),
  );
  const lines = parseCapMaterialLines(pages.flat() as Record<string, unknown>[]);
  lines.sort(
    (a, b) =>
      (b.txn_date ?? "").localeCompare(a.txn_date ?? "") || a.id.localeCompare(b.id),
  );

  return { jobs, lines, multiCompany: companyByRealm.size > 1 };
}
