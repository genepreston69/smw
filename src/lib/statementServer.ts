import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/supabase/fetchAll";
import {
  MONTH_PARAM,
  STATEMENT_COL_DIMS,
  buildCategoryStatement,
  clampMonth,
  defaultFrom,
  lastDayOfMonth,
  latestMonth,
  type CategoryStatement,
  type PivotCell,
  type StatementColDim,
} from "@/lib/financials";
import { NO_CLASS, sortClasses } from "@/lib/budget";

// Income Statement data loading shared by /financials/statement and its Excel
// export (/api/export/statement), so the file always matches the screen.
// Callers verify the admin role first and pass the service-role client (same
// access pattern as every Financials read — see migrations 0014/0015).
//
// The statement shows one QuickBooks class at a time (or All classes). The
// ledger is read once as account × month × class cells through
// budget_ledger_summary (migrations 0027/0034/0035: one org-scoped,
// index-range-scanned JSON row), then the chosen class is kept and months are
// rolled into the chosen columns here. All classes is the plain sum of every
// class's cells, so the class statements always add up to it exactly.

export interface StatementState {
  company: string; // realm id or "all"
  from: string; // YYYY-MM
  to: string; // YYYY-MM
  cols: StatementColDim;
  /** QuickBooks class as gl_pivot keys it (NO_CLASS when none); null = All classes. */
  cls: string | null;
}

/** Page/export params → state; anything invalid falls back to the defaults. */
export function statementState(
  get: (key: string) => string | null | undefined,
  validRealms: ReadonlySet<string>,
): StatementState {
  const company = get("company");
  const from = get("from") ?? "";
  const to = get("to") ?? "";
  const cols = get("cols");
  const cls = (get("class") ?? "").trim();
  return {
    company: company && validRealms.has(company) ? company : "all",
    // The in-progress month is omitted app-wide: params are clamped to the
    // last complete month.
    from: MONTH_PARAM.test(from) ? clampMonth(from) : defaultFrom(),
    to: MONTH_PARAM.test(to) ? clampMonth(to) : latestMonth(),
    cols: STATEMENT_COL_DIMS.some((d) => d.key === cols)
      ? (cols as StatementColDim)
      : "month",
    cls: cls && cls !== "all" && cls.length <= 200 ? cls : null,
  };
}

/** Column key for a ledger month under the chosen column layout — the same
    keys gl_pivot produces, so pivotColLabel labels them unchanged. */
function colKeyFor(cols: StatementColDim, month: string, realm: string): string {
  switch (cols) {
    case "month":
      return month;
    case "quarter":
      return `${month.slice(0, 4)}-Q${Math.ceil(Number(month.slice(5, 7)) / 3)}`;
    case "year":
      return month.slice(0, 4);
    case "company":
      return realm;
    case "total":
      return "total";
  }
}

export interface LoadedStatement {
  statement: CategoryStatement;
  /** Every class with activity in the selection, sorted (NO_CLASS last). */
  classes: string[];
  /** Ledger cells behind the statement (0 = nothing to show). */
  cellCount: number;
}

export async function loadStatement(
  db: SupabaseClient,
  state: StatementState,
  /** Every connected company, in display order. */
  allRealms: string[],
): Promise<LoadedStatement> {
  const { company, from, to, cols, cls } = state;
  const realms = company === "all" ? allRealms : [company];
  if (realms.length === 0) {
    return { statement: buildCategoryStatement([], new Map()), classes: [], cellCount: 0 };
  }

  const [summaryRes, accountRows] = await Promise.all([
    db.rpc("budget_ledger_summary", {
      p_start: `${from}-01`,
      p_end: lastDayOfMonth(to),
      p_realm_ids: realms,
      p_customers: false,
    }),
    fetchAllRows((fromRow, toRow) =>
      db
        .from("gl_accounts")
        .select("realm_id, name, fully_qualified_name, category")
        .in("classification", ["Revenue", "Expense"])
        .order("id")
        .range(fromRow, toRow),
    ) as Promise<
      {
        realm_id: string;
        name: string;
        fully_qualified_name: string | null;
        category: string | null;
      }[]
    >,
  ]);
  if (summaryRes.error) throw new Error(summaryRes.error.message);
  const summary = (summaryRes.data ?? { accounts: [] }) as {
    accounts: [string, string, string | null, string, string, number | string, string?][];
  };

  const classSet = new Set<string>();
  const cells: PivotCell[] = [];
  for (const [realm, classification, accountType, account, month, amount, rawCls] of summary.accounts) {
    const cellCls = rawCls || NO_CLASS;
    classSet.add(cellCls);
    if (cls !== null && cellCls !== cls) continue;
    // buildCategoryStatement sums cells that share an account and column, so
    // classes (and companies) fold together with no separate merge step.
    cells.push({
      classification,
      account_type: accountType,
      row_key: account,
      col_key: colKeyFor(cols, month, realm),
      amount,
      line_count: 0,
    });
  }

  // The ledger's account key is the account's full name, merged across
  // companies under "All companies" — map name → category the same way,
  // first assigned category winning if realms ever disagree.
  const categoryByAccount = new Map<string, string>();
  for (const a of accountRows) {
    if (!a.category) continue;
    if (company !== "all" && a.realm_id !== company) continue;
    const key = a.fully_qualified_name ?? a.name;
    if (!categoryByAccount.has(key)) categoryByAccount.set(key, a.category);
  }

  return {
    statement: buildCategoryStatement(cells, categoryByAccount),
    classes: sortClasses(classSet),
    cellCount: cells.length,
  };
}
