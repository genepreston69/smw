"use server";

import { createClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/fetchAll";
import { capLaborPeriod, type CapLaborPeriodParams } from "@/lib/capitalizedLabor";
import {
  capJobsErrorMessage,
  parseCapJobLines,
  CAP_JOB_LINE_COLUMNS,
  type CapJobLine,
} from "@/lib/capitalizedJobs";

export type CapJobLinesResult =
  | { ok: true; lines: CapJobLine[] }
  | { ok: false; error: string };

/**
 * One job's counted direct-cost lines, newest first (RLS: any signed-in
 * user) — the lines the page counts (cap_job_lines, migration 0044), dated in
 * the period on screen (the page's own period params, re-parsed here).
 */
export async function getCapJobLines(
  jobId: string,
  periodParams: CapLaborPeriodParams = {},
): Promise<CapJobLinesResult> {
  if (typeof jobId !== "string" || !jobId) {
    return { ok: false, error: "Unknown job" };
  }
  const supabase = await createClient();
  // Callers can send anything; capLaborPeriod drops what it can't use.
  const period = capLaborPeriod(
    periodParams && typeof periodParams === "object" ? periodParams : {},
  );
  try {
    // Paged read: a busy job can exceed Supabase's 1000-row cap. The id
    // tie-break keeps pages stable when lines share a date.
    const rows = await fetchAllRows((from, to) =>
      supabase
        .from("cap_job_lines")
        .select(CAP_JOB_LINE_COLUMNS)
        .eq("job_id", jobId)
        .gte("txn_date", period.from)
        .lte("txn_date", period.to)
        .order("txn_date", { ascending: false, nullsFirst: false })
        .order("id")
        .range(from, to),
    );
    return { ok: true, lines: parseCapJobLines(rows as Record<string, unknown>[]) };
  } catch (e) {
    return {
      ok: false,
      error: capJobsErrorMessage(e instanceof Error ? e.message : "Failed to load transactions"),
    };
  }
}
