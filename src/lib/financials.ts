// Shared definitions for the Financials pivot (/financials) and its
// drill-down (/financials/lines). Dimension keys must match the CASE
// branches in the gl_pivot and gl_lines_detail SQL functions
// (migrations 0009 / 0010) — the database does the grouping and filtering,
// these are just the vocabulary.

import { isEnterpriseName } from "@/lib/enterprise";

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

/** Excel export of the pivot; carries the full state so the file matches the screen. */
export function financialsExportHref(s: FinancialsState): string {
  const params = new URLSearchParams({
    company: s.company,
    from: s.from,
    to: s.to,
    rows: s.rows,
    cols: s.cols,
    scope: s.scope,
  });
  return `/api/export/financials?${params}`;
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

/* ---------------------------------------------------------------------------
   Pivot assembly. The Financials page and the Excel export
   (src/app/api/export/financials/) must lay out identical tables from the
   gl_pivot cells, so the assembly lives here.
--------------------------------------------------------------------------- */

/** One aggregated cell from the gl_pivot SQL function. */
export interface PivotCell {
  classification: string | null;
  account_type: string | null;
  row_key: string;
  col_key: string;
  amount: number | string;
  line_count: number;
}

export interface PivotDisplayRow {
  key: string;
  classification: string;
  accountType: string;
  cells: Map<string, number>;
  total: number;
}

export interface PivotTotals {
  bycol: Map<string, number>;
  total: number;
}

export interface PivotSection {
  label: string;
  rows: PivotDisplayRow[];
  /** Section subtotal; only present on the sectioned account view. */
  subtotal: PivotTotals | null;
}

export interface PivotTable {
  colKeys: string[];
  /** True when rows are accounts grouped into statement sections. */
  sectioned: boolean;
  sections: PivotSection[];
  grand: PivotTotals;
  /** Income minus Expenses per column; only on the account view under pl. */
  netIncome: PivotTotals | null;
  /** Label for the bottom summary row shown when netIncome is null. */
  totalLabel: string;
}

// Statement section order and display names for the account row dimension.
const ACCOUNT_SECTIONS: { classification: string; label: string }[] = [
  { classification: "Revenue", label: "Income" },
  { classification: "Expense", label: "Expenses" },
  { classification: "Asset", label: "Assets" },
  { classification: "Liability", label: "Liabilities" },
  { classification: "Equity", label: "Equity" },
  { classification: "", label: "Other" },
];

export function pivotColLabel(
  colDim: ColDim,
  key: string,
  companyByRealm?: ReadonlyMap<string, string>,
): string {
  if (colDim === "month") return monthLabel(key);
  if (colDim === "company") return companyByRealm?.get(key) ?? key;
  if (colDim === "total") return "Amount";
  return key;
}

export function buildPivot(
  cells: PivotCell[],
  rowDim: RowDim,
  scope: Scope,
): PivotTable {
  const colKeys = [...new Set(cells.map((c) => c.col_key))].sort();

  // Net-income sign: on the account view every account shows its natural
  // amount; on every other row dimension, expense activity counts against
  // the slice so the Net income scope reads as profit contribution.
  const signed = (c: PivotCell): number => {
    const amount = Number(c.amount);
    if (rowDim === "account" || scope !== "pl") return amount;
    return c.classification === "Expense" ? -amount : amount;
  };

  const rowByKey = new Map<string, PivotDisplayRow>();
  for (const c of cells) {
    // Off the account view the same row key can span several account
    // classifications; fold them into one display row.
    const mapKey =
      rowDim === "account" ? `${c.classification}|${c.row_key}` : c.row_key;
    let row = rowByKey.get(mapKey);
    if (!row) {
      row = {
        key: c.row_key,
        classification: c.classification ?? "",
        accountType: c.account_type ?? "",
        cells: new Map(),
        total: 0,
      };
      rowByKey.set(mapKey, row);
    }
    const v = signed(c);
    row.cells.set(c.col_key, (row.cells.get(c.col_key) ?? 0) + v);
    row.total += v;
  }
  const allRows = [...rowByKey.values()];

  const sums = (rows: PivotDisplayRow[]): PivotTotals => {
    const bycol = new Map<string, number>();
    let total = 0;
    for (const r of rows) {
      for (const [k, v] of r.cells) bycol.set(k, (bycol.get(k) ?? 0) + v);
      total += r.total;
    }
    return { bycol, total };
  };

  // Account view: statement sections with subtotals (and a Net income line
  // under the P&L scope). Other dimensions: one flat list, largest first.
  const sectioned = rowDim === "account";
  const sections: PivotSection[] = sectioned
    ? ACCOUNT_SECTIONS.filter((s) =>
        allRows.some((r) => (r.classification || "") === s.classification),
      ).map((s) => {
        const rows = allRows
          .filter((r) => (r.classification || "") === s.classification)
          .sort(
            (a, b) =>
              a.accountType.localeCompare(b.accountType) ||
              a.key.localeCompare(b.key),
          );
        return { label: s.label, rows, subtotal: sums(rows) };
      })
    : [
        {
          label: SCOPES.find((s) => s.key === scope)!.label,
          rows: allRows.sort((a, b) => b.total - a.total),
          subtotal: null,
        },
      ];

  // Natural amounts make net income = income - expenses on the account view.
  let netIncome: PivotTotals | null = null;
  if (sectioned && scope === "pl") {
    const revenue = sums(allRows.filter((r) => r.classification === "Revenue"));
    const bycol = new Map(revenue.bycol);
    let total = revenue.total;
    for (const r of allRows.filter((r) => r.classification === "Expense")) {
      for (const [k, v] of r.cells) bycol.set(k, (bycol.get(k) ?? 0) - v);
      total -= r.total;
    }
    netIncome = { bycol, total };
  }

  return {
    colKeys,
    sectioned,
    sections,
    grand: sums(allRows),
    netIncome,
    totalLabel: !sectioned && scope === "pl" ? "Net income" : "Total",
  };
}

/* ---------------------------------------------------------------------------
   Intercompany eliminations. Superior Marine acts as billing agent for its
   sister companies, so the same revenue is recognized on two companies'
   books and the consolidated Net income line is overstated. The eliminations
   section shown below Net income backs out the duplicate side, always
   keeping the agent's customer-facing invoice:

     1. Revenue whose customer is a sister company (Precision Paint invoicing
        Superior Marine for work SMW billed on to the end customer), matched
        with the same fuzzy naming (isEnterpriseName) that buckets
        Intercompany jobs on the dashboard.
     2. Revenue under a "Marathon" customer booked by any company other than
        Superior Marine — SMW is always the billing agent for Marathon
        invoices, so the operating company's (IRDC's) own booking is the
        duplicate.

   Feed it one slice per company: gl_pivot cells with row_dim = 'customer',
   classifications = ['Revenue'], p_realm_id set to that company.
--------------------------------------------------------------------------- */

const AGENCY_CUSTOMER_PHRASE = "marathon";
const BILLING_AGENT_PHRASE = "superior marine";

export interface RealmRevenueSlice {
  realmId: string;
  companyName: string | null;
  /** gl_pivot cells: row_dim 'customer', Revenue only, this realm. */
  cells: PivotCell[];
}

export interface EliminationLine {
  label: string;
  /** Signed effect on net income: negative backs the revenue out. */
  totals: PivotTotals;
}

export interface Eliminations {
  lines: EliminationLine[];
  /** Net income after applying every elimination line. */
  adjusted: PivotTotals;
}

export function buildEliminations(
  slices: RealmRevenueSlice[],
  netIncome: PivotTotals,
): Eliminations | null {
  const lines: EliminationLine[] = [];
  const collect = (
    label: string,
    match: (slice: RealmRevenueSlice, customer: string) => boolean,
  ) => {
    const bycol = new Map<string, number>();
    let total = 0;
    let any = false;
    for (const s of slices) {
      for (const c of s.cells) {
        if (!match(s, c.row_key)) continue;
        any = true;
        const v = -Number(c.amount);
        bycol.set(c.col_key, (bycol.get(c.col_key) ?? 0) + v);
        total += v;
      }
    }
    if (any) lines.push({ label, totals: { bycol, total } });
  };

  collect(
    "Intercompany revenue (Precision Paint)",
    (_s, customer) => isEnterpriseName(customer),
  );
  // Guarded with !isEnterpriseName so a line can never be eliminated twice.
  collect(
    "Intercompany revenue (other sister company)",
    (s, customer) =>
      !isEnterpriseName(customer) &&
      customer.toLowerCase().includes(AGENCY_CUSTOMER_PHRASE) &&
      !(s.companyName ?? "").toLowerCase().includes(BILLING_AGENT_PHRASE),
  );

  if (lines.length === 0) return null;
  const bycol = new Map(netIncome.bycol);
  let total = netIncome.total;
  for (const l of lines) {
    for (const [k, v] of l.totals.bycol) bycol.set(k, (bycol.get(k) ?? 0) + v);
    total += l.totals.total;
  }
  return { lines, adjusted: { bycol, total } };
}

/** Validate raw search params into a FinancialsState (bad values → defaults). */
export function resolveFinancialsState(
  sp: {
    company?: string;
    from?: string;
    to?: string;
    rows?: string;
    cols?: string;
    scope?: string;
  },
  validRealms: ReadonlySet<string>,
): FinancialsState {
  return {
    company: sp.company && validRealms.has(sp.company) ? sp.company : "all",
    from: MONTH_PARAM.test(sp.from ?? "") ? sp.from! : defaultFrom(),
    to: MONTH_PARAM.test(sp.to ?? "") ? sp.to! : currentMonth(),
    rows: ROW_DIMS.some((d) => d.key === sp.rows)
      ? (sp.rows as RowDim)
      : "account",
    cols: COL_DIMS.some((d) => d.key === sp.cols)
      ? (sp.cols as ColDim)
      : "month",
    scope: SCOPES.some((s) => s.key === sp.scope) ? (sp.scope as Scope) : "pl",
  };
}
