"use server";

import { createClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/fetchAll";
import { capLaborPeriod, type CapLaborPeriodParams } from "@/lib/capitalizedLabor";
import {
  parseCapMaterialLines,
  CAP_MATERIAL_LINE_COLUMNS,
  type CapMaterialLine,
} from "@/lib/capitalizedMaterials";

export type CapMaterialLinesResult =
  | { ok: true; lines: CapMaterialLine[] }
  | { ok: false; error: string };

/**
 * One job's counted expense lines, newest first (RLS: any signed-in user) —
 * the lines the page counts (cap_material_lines, migration 0036), dated in
 * the period on screen (the page's own period params, re-parsed here).
 */
export async function getCapMaterialLines(
  jobId: string,
  periodParams: CapLaborPeriodParams = {},
): Promise<CapMaterialLinesResult> {
  if (typeof jobId !== "string" || !jobId) {
    return { ok: false, error: "Unknown job" };
  }
  const supabase = await createClient();
  // Callers can send anything; capLaborPeriod drops what it can't use.
  const period = capLaborPeriod(
    periodParams && typeof periodParams === "object" ? periodParams : {},
  );
  try {
    // Paged read: a busy equipment job can exceed Supabase's 1000-row cap.
    // The id tie-break keeps pages stable when lines share a date.
    const rows = await fetchAllRows((from, to) =>
      supabase
        .from("cap_material_lines")
        .select(CAP_MATERIAL_LINE_COLUMNS)
        .eq("job_id", jobId)
        .gte("txn_date", period.from)
        .lte("txn_date", period.to)
        .order("txn_date", { ascending: false, nullsFirst: false })
        .order("id")
        .range(from, to),
    );
    return { ok: true, lines: parseCapMaterialLines(rows as Record<string, unknown>[]) };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Failed to load transactions",
    };
  }
}
