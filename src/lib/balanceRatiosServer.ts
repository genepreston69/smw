import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { COMBINED, mergeBalanceSheets, type BsNode } from "@/lib/balanceSheet";
import { balanceFigures, type BalanceFigures } from "@/lib/balanceRatios";
import { lastDayOfMonth } from "@/lib/financials";

// The balance sheet half of the Financial Ratios page: the stored QuickBooks
// balance sheets (balance_sheet_snapshots, migration 0043) for every month
// end in the period, reduced to the figures the ratios use.

export interface BalanceRatioPoint {
  /** The month end, `YYYY-MM-DD`. */
  asOf: string;
  figures: BalanceFigures;
  /** Connected companies in the selection with no balance sheet for this
      month end — the figures leave them out. */
  missing: string[];
}

export interface LoadedBalanceRatios {
  /** One per month end in the period that has a balance sheet, oldest first. */
  points: BalanceRatioPoint[];
  /** Set when migration 0043 has not been applied. */
  migrationMissing: boolean;
}

const isMissingTable = (error: { code?: string } | null) =>
  error?.code === "42P01" || error?.code === "PGRST205";

/**
 * Balance sheet figures for each month end from `from` through `to` (both
 * `YYYY-MM`): one company's when `company` is a realm id, every company's
 * plain sum when it is "all" — the same Combined the Balance Sheet page
 * shows, with no intercompany eliminations. Call only after verifying the
 * caller is an admin: `db` is the service-role client.
 */
export async function loadBalanceRatios(
  db: SupabaseClient,
  state: { from: string; to: string; company: string },
  companies: { realm_id: string; company_name: string | null }[],
): Promise<LoadedBalanceRatios> {
  // One row per company per month end, so even years of history stay far
  // under the API's 1000-row cap.
  let query = db
    .from("balance_sheet_snapshots")
    .select("realm_id, as_of, report")
    .gte("as_of", `${state.from}-01`)
    .lte("as_of", lastDayOfMonth(state.to))
    .order("as_of")
    .order("realm_id")
    .limit(1000);
  if (state.company !== "all") query = query.eq("realm_id", state.company);
  const { data, error } = await query;
  if (isMissingTable(error)) return { points: [], migrationMissing: true };
  if (error) {
    throw new Error(`Could not load the balance sheets: ${error.message}`);
  }

  const byDate = new Map<string, { key: string; nodes: BsNode[] }[]>();
  for (const row of (data ?? []) as {
    realm_id: string;
    as_of: string;
    report: { nodes?: BsNode[] } | null;
  }[]) {
    const sheets = byDate.get(row.as_of) ?? [];
    sheets.push({ key: row.realm_id, nodes: row.report?.nodes ?? [] });
    byDate.set(row.as_of, sheets);
  }

  const expected = companies.filter(
    (c) => state.company === "all" || c.realm_id === state.company,
  );
  const points: BalanceRatioPoint[] = [];
  for (const [asOf, sheets] of byDate) {
    const figures = balanceFigures(
      mergeBalanceSheets(sheets),
      sheets.length > 1 ? COMBINED : sheets[0].key,
    );
    // A company with nothing posted has an empty report and no figures.
    if (!figures) continue;
    points.push({
      asOf,
      figures,
      missing: expected
        .filter((c) => !sheets.some((s) => s.key === c.realm_id))
        .map((c) => c.company_name ?? `Company ${c.realm_id}`),
    });
  }
  return { points, migrationMissing: false };
}
