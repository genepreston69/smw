// Shared definitions for the Financials pivot (/financials) and its
// drill-down (/financials/lines). Dimension keys must match the CASE
// branches in the gl_pivot and gl_lines_detail SQL functions
// (migrations 0009 / 0010) — the database does the grouping and filtering,
// these are just the vocabulary.

export type RowDim =
  | "account"
  | "class"
  | "customer"
  | "vendor"
  | "txn_type"
  | "month";
export type ColDim = "month" | "quarter" | "year" | "class" | "company" | "total";
export type Scope = "pl" | "income" | "expense" | "all";

export const ROW_DIMS: { key: RowDim; label: string }[] = [
  { key: "account", label: "Account" },
  { key: "class", label: "Class" },
  { key: "customer", label: "Customer" },
  { key: "vendor", label: "Vendor" },
  { key: "txn_type", label: "Transaction type" },
  { key: "month", label: "Month" },
];

export const COL_DIMS: { key: ColDim; label: string }[] = [
  { key: "month", label: "Month" },
  { key: "quarter", label: "Quarter" },
  { key: "year", label: "Year" },
  { key: "class", label: "Class" },
  { key: "company", label: "Company" },
  { key: "total", label: "Total only" },
];

export const SCOPES: { key: Scope; label: string }[] = [
  { key: "pl", label: "Net income" },
  { key: "income", label: "Income only" },
  { key: "expense", label: "Expenses only" },
  { key: "all", label: "All accounts" },
];

// Which account classifications each scope pulls from the ledger.
export const SCOPE_CLASSIFICATIONS: Record<Scope, string[] | null> = {
  pl: ["Revenue", "Expense"],
  income: ["Revenue"],
  expense: ["Expense"],
  all: null,
};

export const MONTH_PARAM = /^\d{4}-\d{2}$/;

export function currentMonth(): string {
  const today = new Date();
  return `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function defaultFrom(): string {
  return `${new Date().getUTCFullYear()}-01`;
}

export function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${y}`;
}

export function lastDayOfMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

export interface FinancialsState {
  company: string; // realm id or "all"
  from: string; // YYYY-MM
  to: string; // YYYY-MM
  rows: RowDim;
  cols: ColDim;
  scope: Scope;
}

/** Pivot-page URL for a filter state; defaults are omitted to keep URLs clean. */
export function financialsHref(s: FinancialsState): string {
  const params = new URLSearchParams();
  if (s.company !== "all") params.set("company", s.company);
  if (s.from !== defaultFrom()) params.set("from", s.from);
  if (s.to !== currentMonth()) params.set("to", s.to);
  if (s.rows !== "account") params.set("rows", s.rows);
  if (s.cols !== "month") params.set("cols", s.cols);
  if (s.scope !== "pl") params.set("scope", s.scope);
  const q = params.toString();
  return q ? `/financials?${q}` : "/financials";
}

/** Drill-down URL for one pivot cell (null key = no filter on that axis). */
export function linesHref(
  s: FinancialsState,
  rowKey: string | null,
  colKey: string | null,
  page?: number,
): string {
  const params = new URLSearchParams({
    company: s.company,
    from: s.from,
    to: s.to,
    rows: s.rows,
    cols: s.cols,
    scope: s.scope,
  });
  if (rowKey !== null) params.set("rowkey", rowKey);
  if (colKey !== null) params.set("colkey", colKey);
  if (page && page > 1) params.set("page", String(page));
  return `/financials/lines?${params}`;
}
