import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/supabase/fetchAll";
import type { PivotCell } from "@/lib/financials";

/** gl_pivot's arguments (migration 0009). */
export interface PivotArgs {
  p_start: string;
  p_end: string;
  p_row_dim: string;
  p_col_dim: string;
  p_realm_id: string | null;
  p_classifications: string[] | null;
}

/**
 * Every cell of one ledger pivot, in one database round trip.
 *
 * Reads gl_pivot_cells (migration 0042), which returns the whole pivot as one
 * JSON value. Reading gl_pivot itself goes through the API's 1000-row pages,
 * and every page re-runs the entire aggregation — several scans of the ledger
 * for a single page view. Every ledger pivot the app shows comes through here
 * (Financials, Income Ratios, the line drill-down's total, Reconciliation and
 * the Financials export), so they all read the ledger once.
 *
 * Callers verify the admin role first and pass the service-role client, like
 * every Financials read.
 */
export async function loadPivotCells(
  db: SupabaseClient,
  args: PivotArgs,
): Promise<PivotCell[]> {
  const { data, error } = await db.rpc("gl_pivot_cells", args);
  if (!error) return (data ?? []) as PivotCell[];

  // PGRST202 = the function isn't there: migration 0042 hasn't been applied
  // yet. Fall back to the paged read so Financials keeps working (slowly)
  // rather than going down; the layout's banner tells admins what is missing.
  if (error.code !== "PGRST202") throw new Error(error.message);
  return (await fetchAllRows((fromRow, toRow) =>
    db
      .rpc("gl_pivot", args)
      .order("row_key")
      .order("col_key")
      .order("classification")
      .order("account_type")
      .range(fromRow, toRow),
  )) as PivotCell[];
}
