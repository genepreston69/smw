import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  COMBINED,
  SECTIONS,
  balanceSheetAsOf,
  findSection,
  flattenBalanceSheet,
  lineAmounts,
  mergeBalanceSheets,
  type BsLine,
  type BsNode,
  type BsRow,
} from "@/lib/balanceSheet";
import { SYNC_TIMEZONE, localClock } from "@/lib/qbSyncSchedule";

// The Balance Sheet page and its Excel export share this loader and param
// parser, so the file always matches the screen.

export interface BalanceSheetColumn {
  key: string;
  label: string;
}

export interface LoadedBalanceSheet {
  /** The month end shown. */
  asOf: string;
  /** The prior month end — what the page shows by default. */
  latest: string;
  /** Every month end with a stored snapshot, newest first. */
  periods: string[];
  /** One per company with a snapshot, then Combined when there are several. */
  columns: BalanceSheetColumn[];
  lines: BsLine[];
  rows: BsRow[];
  /** Headline totals by column key. */
  totals: {
    assets: Record<string, number>;
    liabilities: Record<string, number>;
    equity: Record<string, number>;
  };
  /** When the oldest snapshot in view was pulled from QuickBooks. */
  fetchedAt: string | null;
  /** Connected companies with no snapshot for this month end. */
  missing: string[];
  timezone: string;
  /** Set when migration 0043 has not been applied. */
  migrationMissing: boolean;
}

/** The period a request asks for (`?asOf=`), defaulting to the prior month. */
export function balanceSheetState(get: (key: string) => string | null | undefined): {
  asOf: string;
  latest: string;
} {
  const today = localClock().date;
  return {
    asOf: balanceSheetAsOf(get("asOf"), today),
    latest: balanceSheetAsOf(null, today),
  };
}

const isMissingTable = (error: { code?: string } | null) =>
  error?.code === "42P01" || error?.code === "PGRST205";

/**
 * The stored balance sheets as of one month end, every connected company
 * side by side. Call only after verifying the caller is an admin: `db` is the
 * service-role client.
 */
export async function loadBalanceSheet(
  db: SupabaseClient,
  state: { asOf: string; latest: string },
  companies: { realm_id: string; company_name: string | null }[],
): Promise<LoadedBalanceSheet> {
  const empty: LoadedBalanceSheet = {
    ...state,
    periods: [],
    columns: [],
    lines: [],
    rows: [],
    totals: { assets: {}, liabilities: {}, equity: {} },
    fetchedAt: null,
    missing: [],
    timezone: SYNC_TIMEZONE,
    migrationMissing: false,
  };

  const [periodRes, snapRes] = await Promise.all([
    // One short row per company per month: years of history stay far under
    // the API's 1000-row cap.
    db
      .from("balance_sheet_snapshots")
      .select("as_of")
      .order("as_of", { ascending: false })
      .limit(1000),
    db
      .from("balance_sheet_snapshots")
      .select("realm_id, report, fetched_at")
      .eq("as_of", state.asOf),
  ]);
  if (isMissingTable(periodRes.error) || isMissingTable(snapRes.error)) {
    return { ...empty, migrationMissing: true };
  }
  for (const res of [periodRes, snapRes]) {
    if (res.error) {
      throw new Error(`Could not load the balance sheet: ${res.error.message}`);
    }
  }

  const periods = [
    ...new Set((periodRes.data ?? []).map((r) => r.as_of as string)),
  ];
  const byRealm = new Map(
    ((snapRes.data ?? []) as {
      realm_id: string;
      report: { nodes?: BsNode[] } | null;
      fetched_at: string;
    }[]).map((s) => [s.realm_id, s]),
  );

  // Connection order, so the columns match the other Financials pages. A
  // company disconnected since keeps its stored month.
  const nameOf = (realm: string) =>
    companies.find((c) => c.realm_id === realm)?.company_name ?? `Company ${realm}`;
  const realms = [
    ...companies.map((c) => c.realm_id).filter((r) => byRealm.has(r)),
    ...[...byRealm.keys()].filter((r) => !companies.some((c) => c.realm_id === r)),
  ];

  const lines = mergeBalanceSheets(
    realms.map((r) => ({ key: r, nodes: byRealm.get(r)!.report?.nodes ?? [] })),
  );
  const columns: BalanceSheetColumn[] = realms.map((r) => ({ key: r, label: nameOf(r) }));
  if (realms.length > 1) columns.push({ key: COMBINED, label: "Combined" });

  const amounts = (s: { group: string; label: RegExp }) => {
    const line = findSection(lines, s.group, s.label);
    return line ? lineAmounts(line) : {};
  };

  return {
    ...empty,
    periods,
    columns,
    lines,
    rows: flattenBalanceSheet(lines),
    totals: {
      assets: amounts(SECTIONS.assets),
      liabilities: amounts(SECTIONS.liabilities),
      equity: amounts(SECTIONS.equity),
    },
    fetchedAt:
      realms.map((r) => byRealm.get(r)!.fetched_at).sort()[0] ?? null,
    missing: companies
      .filter((c) => !byRealm.has(c.realm_id))
      .map((c) => c.company_name ?? `Company ${c.realm_id}`),
  };
}
