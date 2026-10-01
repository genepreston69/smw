// Budget (/financials/budget): a calendar-year budget built from a trailing-
// twelve-month baseline of ledger actuals, grown by per-company revenue and
// expense assumptions, plus approved new initiatives (migration 0026).
//
// Everything here is pure: the page fetches gl_pivot cells and the budget
// tables, and these helpers re-key them into synthetic PivotCells that feed
// the same buildCategoryStatement / buildEliminations as the Income
// Statement — so the budget has exactly the statement's layout, categories,
// direct-cost split, and benefits allocation.

import {
  buildCategoryStatement,
  buildEliminations,
  serializeEliminations,
  type CategoryStatement,
  type PivotCell,
  type PivotTotals,
  type RealmRevenueSlice,
  type StatementEliminations,
} from "@/lib/financials";

export const BUDGET_YEAR = 2027;

export type BudgetColDim = "month" | "quarter" | "total";

export const BUDGET_COL_DIMS: { key: BudgetColDim; label: string }[] = [
  { key: "month", label: "Month" },
  { key: "quarter", label: "Quarter" },
  { key: "total", label: "Total only" },
];

export type BudgetView = "budget" | "variance";

export const BUDGET_VIEWS: { key: BudgetView; label: string }[] = [
  { key: "budget", label: "Budget" },
  { key: "variance", label: "Budget vs Actual" },
];

export type InitiativeStatus = "proposed" | "approved" | "rejected";

export const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Baseline window: the twelve months ending June 30 of the prior year. */
export function baselineRange(year: number): { from: string; to: string } {
  return { from: `${year - 2}-07`, to: `${year - 1}-06` };
}

export interface BudgetAssumption {
  realm_id: string;
  revenue_growth_pct: number;
  expense_growth_pct: number;
}

export interface BudgetInitiativeLine {
  account_name: string;
  classification: "Revenue" | "Expense";
  annual_amount: number;
}

export interface BudgetInitiative {
  id: string;
  realm_id: string;
  name: string;
  description: string | null;
  start_month: number;
  status: InitiativeStatus;
  created_at: string;
  approved_at: string | null;
  approved_by_name: string | null;
  lines: BudgetInitiativeLine[];
}

/** Revenue and expense totals for one initiative (natural-signed amounts). */
export function initiativeTotals(i: BudgetInitiative): {
  revenue: number;
  expense: number;
  net: number;
} {
  let revenue = 0;
  let expense = 0;
  for (const l of i.lines) {
    if (l.classification === "Revenue") revenue += l.annual_amount;
    else expense += l.annual_amount;
  }
  return { revenue, expense, net: revenue - expense };
}

/** Column key for a budget month (1–12) under the chosen column layout. */
export function budgetColKey(
  year: number,
  month: number,
  colDim: BudgetColDim,
): string {
  if (colDim === "month") return `${year}-${String(month).padStart(2, "0")}`;
  if (colDim === "quarter") return `${year}-Q${Math.ceil(month / 3)}`;
  return "total";
}

export function budgetColLabel(colDim: BudgetColDim, key: string): string {
  if (colDim === "month") {
    const [y, m] = key.split("-").map(Number);
    return `${MONTH_NAMES[m - 1]} ${y}`;
  }
  if (colDim === "quarter") return key.replace("-", " ");
  return "Budget";
}

/** Maps a budget month (1–12) to the output column key; null drops the month. */
export type MonthToCol = (month: number) => string | null;

const growthFactor = (
  a: BudgetAssumption | undefined,
  classification: string | null,
): number => {
  if (!a) return 1;
  const pct =
    classification === "Revenue" ? a.revenue_growth_pct : a.expense_growth_pct;
  return 1 + pct / 100;
};

/**
 * Baseline cells (gl_pivot, row_dim account, col_dim month, one realm) grown
 * by that realm's assumptions and moved onto the budget year: each baseline
 * month lands on the same calendar month of the budget year (Jul 2025 → Jul
 * 2027, Jan 2026 → Jan 2027), so seasonality carries forward.
 */
export function growBaselineCells(
  cells: PivotCell[],
  assumption: BudgetAssumption | undefined,
  toCol: MonthToCol,
): PivotCell[] {
  const out: PivotCell[] = [];
  for (const c of cells) {
    const month = Number(c.col_key.slice(5, 7));
    const col = toCol(month);
    if (col === null) continue;
    out.push({
      ...c,
      col_key: col,
      amount: Number(c.amount) * growthFactor(assumption, c.classification),
    });
  }
  return out;
}

/**
 * Approved initiatives as account cells: each line's annual amount spread
 * evenly from the initiative's start month through December. Callers pass
 * only the initiatives that should be in the budget (approved ones).
 */
export function initiativeCells(
  initiatives: BudgetInitiative[],
  toCol: MonthToCol,
): PivotCell[] {
  const out: PivotCell[] = [];
  for (const i of initiatives) {
    const months = 13 - i.start_month;
    for (const l of i.lines) {
      const perMonth = l.annual_amount / months;
      for (let m = i.start_month; m <= 12; m++) {
        const col = toCol(m);
        if (col === null) continue;
        out.push({
          classification: l.classification,
          account_type: null,
          row_key: l.account_name,
          col_key: col,
          amount: perMonth,
          line_count: 0,
        });
      }
    }
  }
  return out;
}

/**
 * Budgeted revenue-by-customer slices for the intercompany eliminations:
 * the realm's baseline customer cells grown by its revenue growth, moved onto
 * the budget columns. Initiatives carry no customer, so they never eliminate.
 */
export function growEliminationSlice(
  slice: RealmRevenueSlice,
  assumption: BudgetAssumption | undefined,
  toCol: MonthToCol,
): RealmRevenueSlice {
  return { ...slice, cells: growBaselineCells(slice.cells, assumption, toCol) };
}

/** Re-key actual gl_pivot month cells (budget year) onto one column, keeping
    months up to `throughMonth`. */
export function actualCells(
  cells: PivotCell[],
  colKey: string,
  throughMonth: number,
): PivotCell[] {
  return cells
    .filter((c) => Number(c.col_key.slice(5, 7)) <= throughMonth)
    .map((c) => ({ ...c, col_key: colKey }));
}

/** Everything assembleBudget needs: the raw ledger inputs plus assumptions. */
export interface BudgetInputs {
  year: number;
  colDim: BudgetColDim;
  view: BudgetView;
  /** Budget-year months already closed (0 = none). */
  closedThrough: number;
  companies: { realmId: string; name: string }[];
  assumptions: Record<string, BudgetAssumption>;
  /** Baseline account × month cells, one array per company (companies order). */
  baselineByRealm: PivotCell[][];
  /** Baseline customer × month cells that feed an elimination, per company. */
  eliminationCellsByRealm: PivotCell[][];
  /** YTD actual account × month cells, all companies (null = not loaded). */
  actuals: PivotCell[] | null;
  actualEliminationSlices: RealmRevenueSlice[];
  approved: BudgetInitiative[];
  categoryByAccount: ReadonlyMap<string, string>;
  wantEliminations: boolean;
}

export interface AssembledBudget {
  statement: CategoryStatement;
  eliminations: StatementEliminations | null;
  /** Budget vs Actual: columns "fy", "budget" (YTD) and "actual" (YTD). */
  variance: {
    statement: CategoryStatement;
    eliminations: StatementEliminations | null;
  } | null;
}

/**
 * The budget statement (and, in the variance view, Budget vs Actual) from
 * raw inputs. Shared by the live page (BudgetWorkspace) and the Excel export
 * so the file always matches the screen.
 */
export function assembleBudget(i: BudgetInputs): AssembledBudget {
  const budgetCells = (toCol: MonthToCol): PivotCell[] =>
    i.companies.flatMap((c, idx) => [
      ...growBaselineCells(i.baselineByRealm[idx] ?? [], i.assumptions[c.realmId], toCol),
      ...initiativeCells(
        i.approved.filter((x) => x.realm_id === c.realmId),
        toCol,
      ),
    ]);
  const budgetSlices = (toCol: MonthToCol): RealmRevenueSlice[] =>
    i.wantEliminations
      ? i.companies.map((c, idx) =>
          growEliminationSlice(
            { realmId: c.realmId, companyName: c.name, cells: i.eliminationCellsByRealm[idx] ?? [] },
            i.assumptions[c.realmId],
            toCol,
          ),
        )
      : [];
  const eliminationsFor = (
    slices: RealmRevenueSlice[],
    s: CategoryStatement,
  ): StatementEliminations | null => {
    if (!i.wantEliminations) return null;
    const net: PivotTotals = {
      bycol: new Map(Object.entries(s.netIncome.cells)),
      total: s.netIncome.total,
    };
    const raw = buildEliminations(slices, net);
    return raw ? serializeEliminations(raw) : null;
  };

  const toCol: MonthToCol = (m) => budgetColKey(i.year, m, i.colDim);
  const statement = buildCategoryStatement(budgetCells(toCol), i.categoryByAccount);
  const eliminations = eliminationsFor(budgetSlices(toCol), statement);

  // Budget vs Actual: full-year budget, YTD budget, and YTD actual as three
  // columns of one statement, so every row lines up.
  let variance: AssembledBudget["variance"] = null;
  if (i.view === "variance" && i.actuals) {
    const fy: MonthToCol = () => "fy";
    const ytd: MonthToCol = (m) => (m <= i.closedThrough ? "budget" : null);
    const vStatement = buildCategoryStatement(
      [...budgetCells(fy), ...budgetCells(ytd), ...actualCells(i.actuals, "actual", i.closedThrough)],
      i.categoryByAccount,
    );
    variance = {
      statement: vStatement,
      eliminations: eliminationsFor(
        [
          ...budgetSlices(fy),
          ...budgetSlices(ytd),
          ...i.actualEliminationSlices.map((s) => ({
            ...s,
            cells: actualCells(s.cells, "actual", i.closedThrough),
          })),
        ],
        vStatement,
      ),
    };
  }
  return { statement, eliminations, variance };
}

/** Budget-year months already closed as of the last complete month. */
export function closedMonthsOf(year: number, latestMonth: string): number {
  if (latestMonth < `${year}-01`) return 0;
  if (latestMonth >= `${year}-12`) return 12;
  return Number(latestMonth.slice(5, 7));
}

/**
 * Export URL for the budget workbook. Carries the current growth % for each
 * company — saved or not — so the file matches what's on screen.
 */
export function budgetExportHref(s: {
  company: string;
  cols: BudgetColDim;
  view: BudgetView;
  assumptions: BudgetAssumption[];
}): string {
  const params = new URLSearchParams({ company: s.company, cols: s.cols, view: s.view });
  for (const a of s.assumptions)
    params.append("growth", `${a.realm_id}:${a.revenue_growth_pct}:${a.expense_growth_pct}`);
  return `/api/export/budget?${params}`;
}
