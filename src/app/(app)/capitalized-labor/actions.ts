"use server";

import { createClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/fetchAll";

export interface CapLaborLine {
  id: string;
  txn_date: string | null;
  qb_txn_id: string;
  qb_doc_number: string | null;
  description: string | null;
  /** QuickBooks account the journal line posted to. */
  category: string | null;
  amount: number;
}

export type CapLaborLinesResult =
  | { ok: true; lines: CapLaborLine[] }
  | { ok: false; error: string };

/**
 * Journal-entry labor lines for one job, newest first (RLS: any signed-in
 * user). Only journal entries count — bills, purchases, and time entries are
 * regular job cost, not capitalization candidates.
 */
export async function getCapLaborLines(
  jobId: string,
): Promise<CapLaborLinesResult> {
  const supabase = await createClient();
  let data: CapLaborLine[];
  try {
    // Paged read: heavy payroll allocation can exceed Supabase's 1000-row
    // cap. The id tie-break keeps pages stable when lines share a date.
    data = await fetchAllRows((from, to) =>
      supabase
        .from("job_costs")
        .select("id, txn_date, qb_txn_id, qb_doc_number, description, category, amount")
        .eq("job_id", jobId)
        .eq("qb_txn_type", "JournalEntry")
        .eq("cost_type", "labor")
        .order("txn_date", { ascending: false, nullsFirst: false })
        .order("id")
        .range(from, to),
    );
  } catch (e) {
    return {
      ok: false,
      error:
        e instanceof Error ? e.message : "Failed to load journal entries",
    };
  }
  return {
    ok: true,
    lines: data.map((r) => ({ ...r, amount: Number(r.amount ?? 0) })),
  };
}
