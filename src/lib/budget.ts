// Budget (/financials/budget): a calendar-year budget built from a trailing-
// twelve-month baseline of ledger actuals, grown by per-company revenue and
// expense assumptions, plus approved new initiatives (migration 0026).
//
// Everything here is pure: the page fetches gl_pivot cells and the budget
// tables, and these helpers re-key them into synthetic PivotCells that feed
// the same buildCategoryStatement / buildEliminations as the Income
// Statement — so the budget has exactly the statement's layout, categories,
// direct-cost split, and benefits allocation.

import type { PivotCell, RealmRevenueSlice } from "@/lib/financials";

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
