import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/supabase/fetchAll";
import { throwIfError } from "@/lib/supabase/throwIfError";
import { loadAppSettings } from "@/lib/appSettingsServer";
import { capLaborBucket, type CapLaborWindow } from "@/lib/capitalizedLabor";
import {
  parseCapJobLines,
  CAP_JOB_LINE_COLUMNS,
  type CapJob,
  type CapJobApproval,
  type CapJobBenefit,
  type CapJobLine,
} from "@/lib/capitalizedJobs";

// Job ids per line read. The list rides in the request URL, so it is kept
// well under the gateway's limit; each read is an index range scan on
// job_costs_job_date_idx (job_id, txn_date).
const JOB_CHUNK = 100;

interface ApprovalRow {
  job_id: string;
  approved_at: string;
  approver: { full_name: string | null; email: string | null } | null;
}

export interface CapJobs {
  /** Every candidate job (non-billable or intercompany) in every QuickBooks
      company. */
  jobs: Map<string, CapJob>;
  /** Their counted lines (cap_job_lines) dated in the period, newest first. */
  lines: CapJobLine[];
  /** Benefit allocation per job per month for the period's months. Empty
      when the read failed — see benefitError. */
  benefits: CapJobBenefit[];
  /** Why the benefit allocation is missing, or null. The page shows it as a
      banner; a file must not present a failed read as "nothing allocated". */
  benefitError: string | null;
  /** Jobs approved for capitalization, by job id (cap_job_approvals,
      migration 0045). Empty when the read failed — see approvalsError. */
  approvals: Map<string, CapJobApproval>;
  /** Why the approvals are missing, or null. Never present a failed read as
      "nothing approved": the page shows a banner and disables the boxes. */
  approvalsError: string | null;
  /** More than one QuickBooks company is connected. */
  multiCompany: boolean;
}

/**
 * Shared by the Capitalized Jobs page and both exports so all three see
 * exactly the same jobs and lines. Job costs are readable by any signed-in
 * user (RLS), so callers pass the user's own client.
 */
export async function loadCapJobs(
  db: SupabaseClient,
  period: CapLaborWindow,
): Promise<CapJobs> {
  // The sister-company list is a setting; every screen and export that
  // buckets jobs loads the same one.
  const { intercompany } = await loadAppSettings(db);
  // Paged reads (fetchAllRows) so nothing is cut off at Supabase's 1000-row
  // cap; .order("id") tie-breaks for stable pages.
  const [jobRows, { data: connRows, error: connError }, benefit, approval] = await Promise.all([
    fetchAllRows((from, to) =>
      db
        .from("jobs")
        .select("id, name, realm_id, customer:customers(display_name, company_name)")
        .order("name")
        .order("id")
        .range(from, to),
    ),
    db.from("qb_connection_status").select("realm_id, company_name"),
    // Employee-benefit allocation per job per month — the same figure as the
    // Jobs dashboard's column — read from the precomputed cache (migration
    // 0025: an indexed scan, never the live derivation, which blows the
    // statement timeout). It is month-grain, so a partial month counts in
    // full.
    fetchAllRows((from, to) =>
      db
        .from("job_benefit_allocation_cache")
        .select("job_id, month, amount")
        .gte("month", `${period.fromMonth}-01`)
        .lte("month", `${period.toMonth}-01`)
        .order("job_id")
        .order("month")
        .range(from, to),
    ).then(
      (rows) => ({ rows: rows as CapJobBenefit[], error: null as string | null }),
      (e: unknown) => ({
        rows: [] as CapJobBenefit[],
        error: e instanceof Error ? e.message : String(e),
      }),
    ),
    // Approvals, with the approver's name. Code can reach production before
    // migration 0045, so a failed read is reported, not thrown.
    fetchAllRows((from, to) =>
      db
        .from("cap_job_approvals")
        .select("job_id, approved_at, approver:profiles(full_name, email)")
        .order("job_id")
        .range(from, to),
    ).then(
      (rows) => ({ rows: rows as unknown as ApprovalRow[], error: null as string | null }),
      (e: unknown) => ({
        rows: [] as ApprovalRow[],
        error: e instanceof Error ? e.message : String(e),
      }),
    ),
  ]);
  throwIfError("the connected QuickBooks companies", connError);

  const companyByRealm = new Map(
    ((connRows ?? []) as { realm_id: string; company_name: string | null }[]).map(
      (c) => [c.realm_id, c.company_name],
    ),
  );

  const jobs = new Map<string, CapJob>();
  for (const j of jobRows as unknown as {
    id: string;
    name: string;
    realm_id: string | null;
    customer: { display_name: string; company_name: string | null } | null;
  }[]) {
    const companyName = (j.realm_id && companyByRealm.get(j.realm_id)) || null;
    const bucket = capLaborBucket(
      {
        name: j.name,
        customerDisplayName: j.customer?.display_name,
        customerCompanyName: j.customer?.company_name,
        qbCompanyName: companyName,
      },
      intercompany,
    );
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

  // Lines for the candidate jobs only — reading every job's costs and
  // discarding the customer work would pull nearly the whole table.
  const ids = [...jobs.keys()];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += JOB_CHUNK) chunks.push(ids.slice(i, i + JOB_CHUNK));
  const pages = await Promise.all(
    chunks.map((chunk) =>
      fetchAllRows((from, to) =>
        db
          .from("cap_job_lines")
          .select(CAP_JOB_LINE_COLUMNS)
          .in("job_id", chunk)
          .gte("txn_date", period.from)
          .lte("txn_date", period.to)
          .order("id")
          .range(from, to),
      ),
    ),
  );
  const lines = parseCapJobLines(pages.flat() as Record<string, unknown>[]);
  lines.sort(
    (a, b) =>
      (b.txn_date ?? "").localeCompare(a.txn_date ?? "") || a.id.localeCompare(b.id),
  );

  return {
    jobs,
    lines,
    benefits: benefit.rows.filter((b) => jobs.has(b.job_id)),
    benefitError: benefit.error,
    approvals: new Map(
      approval.rows
        .filter((a) => jobs.has(a.job_id))
        .map((a) => [
          a.job_id,
          { at: a.approved_at, by: a.approver?.full_name || a.approver?.email || null },
        ]),
    ),
    approvalsError: approval.error,
    multiCompany: companyByRealm.size > 1,
  };
}
