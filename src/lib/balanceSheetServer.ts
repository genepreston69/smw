import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  TOTAL_COL,
  balanceColumns,
  buildBalanceSheet,
  type BalanceCell,
  type BalanceSheet,
  type BalanceSheetState,
} from "@/lib/balanceSheet";

// Balance Sheet loading shared by /financials/balance-sheet and its Excel
// export (/api/export/balance-sheet), so the file always matches the screen.
// Callers verify the admin role first and pass the service-role client (same
// access pattern as every Financials read — see migrations 0014/0015). One
// gl_balance_sheet call (migration 0036) returns every stored month-end
// balance in view as a single JSON array.

export interface LoadedBalanceSheet {
  sheet: BalanceSheet;
  /** Stored balances behind the sheet (0 = nothing to show). */
  cellCount: number;
}

type BalanceTuple = [
  string, // realm_id
  string, // YYYY-MM
  string, // account_key
  string, // display name
  string | null, // section
  string | null, // account_type
  string | null, // account_number
  number | string, // amount
];

export async function loadBalanceSheet(
  db: SupabaseClient,
  state: BalanceSheetState,
  /** Every connected company, in display order. */
  allRealms: string[],
): Promise<LoadedBalanceSheet> {
  const realms = state.company === "all" ? allRealms : [state.company];
  const { months, colKeys } = balanceColumns(state, realms);
  if (realms.length === 0 || months.length === 0) {
    return { sheet: buildBalanceSheet([], colKeys, () => []), cellCount: 0 };
  }

  const { data, error } = await db.rpc("gl_balance_sheet", {
    p_months: months.map((m) => `${m}-01`),
    p_realm_ids: realms,
  });
  if (error) throw new Error(error.message);

  const cells: BalanceCell[] = ((data ?? []) as BalanceTuple[]).map(
    ([realm, month, accountKey, name, section, accountType, accountNumber, amount]) => ({
      realm,
      month,
      accountKey,
      name,
      section,
      accountType,
      accountNumber,
      amount: Number(amount),
    }),
  );

  const withTotal = colKeys.includes(TOTAL_COL);
  const colsFor =
    state.cols === "company"
      ? (c: BalanceCell) => (withTotal ? [c.realm, TOTAL_COL] : [c.realm])
      : (c: BalanceCell) => [c.month];

  return { sheet: buildBalanceSheet(cells, colKeys, colsFor), cellCount: cells.length };
}

/** A load failure as a banner message: the usual cause is the database
    update not being applied yet. */
export function balanceSheetLoadErrorMessage(message: string): string {
  if (/gl_balance_sheet|gl_balances|schema cache|does not exist/i.test(message))
    return "The Balance Sheet needs its database update: run supabase/migrations/0036_balance_sheet.sql in the Supabase SQL editor, then run Sync general ledger on the Settings page (or wait for the nightly sync) and reload.";
  return `The balance sheet couldn't be loaded: ${message}`;
}
