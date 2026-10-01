import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/supabase/fetchAll";
import {
  eliminationLabel,
  lastDayOfMonth,
  latestMonth,
  type PivotCell,
  type RealmRevenueSlice,
} from "@/lib/financials";
import {
  baselineRange,
  closedMonthsOf,
  type BudgetAssumption,
  type BudgetInitiative,
  type BudgetView,
} from "@/lib/budget";

// Budget data loading shared by /financials/budget and its Excel export
// (/api/export/budget), so both read exactly the same inputs. Callers verify
// the admin role first and pass the service-role client (same access pattern
// as every Financials read — see migrations 0014/0015).

export interface BudgetAccount {
  realm_id: string;
  name: string;
  fully_qualified_name: string | null;
  classification: "Revenue" | "Expense";
  category: string | null;
  active: boolean;
}

export interface LoadedBudget {
  year: number;
  /** Budget-year months already closed (0 = none). */
  closedThrough: number;
  realms: string[];
  wantEliminations: boolean;
  /** True when YTD actuals were loaded (variance view with a closed month). */
  wantActuals: boolean;
  baselineByRealm: PivotCell[][];
  /** Baseline customer cells pre-filtered to those an elimination uses. */
  eliminationCellsByRealm: PivotCell[][];
  /** YTD actual account cells, all realms, or null when not loaded. */
  actuals: PivotCell[] | null;
  actualEliminationSlices: RealmRevenueSlice[];
  accountRows: BudgetAccount[];
  /** Saved assumptions per realm (missing realms default to 0%). */
  assumptions: BudgetAssumption[];
  /** Initiatives for the selected realms, every status. */
  initiatives: BudgetInitiative[];
  categoryByAccount: Map<string, string>;
}

export async function loadBudget(
  db: SupabaseClient,
  opts: {
    year: number;
    company: string; // realm id or "all"
    realms: string[];
    companyByRealm: ReadonlyMap<string, string>;
    view: BudgetView;
  },
): Promise<LoadedBudget> {
  const { year, company, realms, companyByRealm, view } = opts;
  const baseline = baselineRange(year);
  const closedThrough = closedMonthsOf(year, latestMonth());

  // One budget_ledger_summary call per window (migration 0027): a single
  // ledger scan returning account × month and revenue customer × month cells
  // for every realm as one JSON row. Paged gl_pivot calls re-ran the whole
  // aggregation per 1000-row page, per company, and timed the page out.
  // Cells come back split per realm (in `realms` order) in gl_pivot's shape.
  const ledger = async (
    from: string,
    to: string,
    withCustomers: boolean,
  ): Promise<{ accounts: PivotCell[][]; customers: PivotCell[][] }> => {
    const { data, error } = await db.rpc("budget_ledger_summary", {
      p_start: `${from}-01`,
      p_end: lastDayOfMonth(to),
      p_realm_ids: realms,
      p_customers: withCustomers,
    });
    if (error) throw new Error(error.message);
    const summary = (data ?? { accounts: [], customers: [] }) as {
      accounts: [string, string, string | null, string, string, number | string][];
      customers: [string, string, string, number | string][];
    };
    const idx = new Map(realms.map((r, i) => [r, i]));
    const accounts: PivotCell[][] = realms.map(() => []);
    const customers: PivotCell[][] = realms.map(() => []);
    for (const [realm, classification, accountType, account, month, amount] of summary.accounts)
      accounts[idx.get(realm)!]?.push({
        classification,
        account_type: accountType,
        row_key: account,
        col_key: month,
        amount,
        line_count: 0,
      });
    for (const [realm, customer, month, amount] of summary.customers)
      customers[idx.get(realm)!]?.push({
        classification: "Revenue",
        account_type: null,
        row_key: customer,
        col_key: month,
        amount,
        line_count: 0,
      });
    return { accounts, customers };
  };

  const wantEliminations = company === "all";
  const wantActuals = view === "variance" && closedThrough > 0;
  const actualTo = `${year}-${String(closedThrough).padStart(2, "0")}`;
  const noLedger = { accounts: [] as PivotCell[][], customers: [] as PivotCell[][] };

  const [baselineLedger, actualLedger, accountRows, assumptionRows, initiativeRows] =
    await Promise.all([
      ledger(baseline.from, baseline.to, wantEliminations),
      wantActuals ? ledger(`${year}-01`, actualTo, wantEliminations) : noLedger,
      fetchAllRows((fromRow, toRow) =>
        db
          .from("gl_accounts")
          .select("realm_id, name, fully_qualified_name, classification, category, active")
          .in("classification", ["Revenue", "Expense"])
          .order("id")
          .range(fromRow, toRow),
      ) as Promise<BudgetAccount[]>,
      db
        .from("budget_assumptions")
        .select("realm_id, revenue_growth_pct, expense_growth_pct")
        .eq("budget_year", year),
      db
        .from("budget_initiatives")
        .select(
          "id, realm_id, name, description, start_month, status, created_at, approved_at, approved_by, budget_initiative_lines (account_name, classification, annual_amount)",
        )
        .eq("budget_year", year)
        .order("created_at"),
    ]);

  const saved = new Map(
    ((assumptionRows.data ?? []) as BudgetAssumption[]).map((a) => [a.realm_id, a]),
  );
  const assumptions: BudgetAssumption[] = realms.map((r) => ({
    realm_id: r,
    revenue_growth_pct: Number(saved.get(r)?.revenue_growth_pct ?? 0),
    expense_growth_pct: Number(saved.get(r)?.expense_growth_pct ?? 0),
  }));

  type InitiativeRow = Omit<BudgetInitiative, "lines" | "approved_by_name"> & {
    approved_by: string | null;
    budget_initiative_lines: {
      account_name: string;
      classification: "Revenue" | "Expense";
      annual_amount: number | string;
    }[];
  };
  const rawInitiatives = ((initiativeRows.data ?? []) as InitiativeRow[]).filter((i) =>
    realms.includes(i.realm_id),
  );
  const approverIds = [
    ...new Set(rawInitiatives.map((i) => i.approved_by).filter((v): v is string => !!v)),
  ];
  const { data: approverRows } = approverIds.length
    ? await db.from("profiles").select("id, full_name, email").in("id", approverIds)
    : { data: [] };
  const approverName = new Map(
    ((approverRows ?? []) as { id: string; full_name: string | null; email: string }[]).map(
      (p) => [p.id, p.full_name || p.email],
    ),
  );
  const initiatives: BudgetInitiative[] = rawInitiatives.map((i) => ({
    id: i.id,
    realm_id: i.realm_id,
    name: i.name,
    description: i.description,
    start_month: i.start_month,
    status: i.status,
    created_at: i.created_at,
    approved_at: i.approved_at,
    approved_by_name: i.approved_by ? (approverName.get(i.approved_by) ?? null) : null,
    lines: i.budget_initiative_lines.map((l) => ({
      account_name: l.account_name,
      classification: l.classification,
      annual_amount: Number(l.annual_amount),
    })),
  }));

  // Same account-name → category mapping as the Income Statement page.
  const categoryByAccount = new Map<string, string>();
  for (const a of accountRows) {
    if (!a.category) continue;
    if (company !== "all" && a.realm_id !== company) continue;
    const key = a.fully_qualified_name ?? a.name;
    if (!categoryByAccount.has(key)) categoryByAccount.set(key, a.category);
  }

  // Only the customer cells an intercompany elimination will use are kept —
  // the full customer × month slice is far larger.
  const eliminationOnly = (cells: PivotCell[], realmId: string) =>
    cells.filter(
      (c) => eliminationLabel(companyByRealm.get(realmId) ?? null, c.row_key) !== null,
    );

  return {
    year,
    closedThrough,
    realms,
    wantEliminations,
    wantActuals,
    baselineByRealm: baselineLedger.accounts,
    eliminationCellsByRealm: wantEliminations
      ? baselineLedger.customers.map((cells, idx) => eliminationOnly(cells, realms[idx]))
      : [],
    actuals: wantActuals ? actualLedger.accounts.flat() : null,
    actualEliminationSlices: wantEliminations
      ? actualLedger.customers.map((cells, idx) => ({
          realmId: realms[idx],
          companyName: companyByRealm.get(realms[idx]) ?? null,
          cells: eliminationOnly(cells, realms[idx]),
        }))
      : [],
    accountRows,
    assumptions,
    initiatives,
    categoryByAccount,
  };
}
