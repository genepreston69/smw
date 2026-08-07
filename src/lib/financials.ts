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
export type DisplayMode = "amount" | "pct";

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

// Common-size display: every cell as a percent of the same column's total
// revenue (classification = Revenue) instead of dollars.
export const DISPLAY_MODES: { key: DisplayMode; label: string }[] = [
  { key: "amount", label: "Amounts" },
  { key: "pct", label: "% of revenue" },
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
  display: DisplayMode;
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
  if (s.display !== "amount") params.set("display", s.display);
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
    display: s.display,
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
    display: s.display,
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

/** Total revenue per column from a pivot slice — the % of revenue denominators. */
export function revenueByCol(cells: PivotCell[]): PivotTotals {
  const bycol = new Map<string, number>();
  let total = 0;
  for (const c of cells) {
    if (c.classification !== "Revenue") continue;
    const v = Number(c.amount);
    bycol.set(c.col_key, (bycol.get(c.col_key) ?? 0) + v);
    total += v;
  }
  return { bycol, total };
}

/* ---------------------------------------------------------------------------
   Income statement assembly for /financials/ratios. Buckets gl_pivot account
   cells (Revenue + Expense classifications) into statement lines by QuickBooks
   account type — Other Income / Cost of Goods Sold / Other Expense split out,
   everything else is operating revenue or operating expense — and derives the
   subtotals. Ratios divide by totalRevenue (all Revenue activity, other
   income included) so the net margin here always matches Net income ÷ revenue
   on the common-size Financials view.
--------------------------------------------------------------------------- */

export interface IncomeStatement {
  colKeys: string[];
  revenue: PivotTotals; // operating revenue (Revenue minus Other Income types)
  otherIncome: PivotTotals;
  totalRevenue: PivotTotals; // revenue + otherIncome; the ratio denominator
  cogs: PivotTotals;
  grossProfit: PivotTotals; // revenue - cogs
  opex: PivotTotals; // Expense classification, plain Expense account type
  operatingIncome: PivotTotals; // grossProfit - opex
  otherExpense: PivotTotals;
  netIncome: PivotTotals; // operatingIncome + otherIncome - otherExpense
}

export function buildIncomeStatement(cells: PivotCell[]): IncomeStatement {
  const colKeys = [...new Set(cells.map((c) => c.col_key))].sort();
  const make = (): PivotTotals => ({ bycol: new Map(), total: 0 });
  const revenue = make();
  const otherIncome = make();
  const cogs = make();
  const opex = make();
  const otherExpense = make();

  for (const c of cells) {
    let bucket: PivotTotals;
    const type = c.account_type ?? "";
    if (c.classification === "Revenue") {
      bucket = type === "Other Income" ? otherIncome : revenue;
    } else if (c.classification === "Expense") {
      bucket =
        type === "Cost of Goods Sold"
          ? cogs
          : type === "Other Expense"
            ? otherExpense
            : opex;
    } else {
      continue;
    }
    const v = Number(c.amount);
    bucket.bycol.set(c.col_key, (bucket.bycol.get(c.col_key) ?? 0) + v);
    bucket.total += v;
  }

  const merge = (parts: [PivotTotals, 1 | -1][]): PivotTotals => {
    const out = make();
    for (const [t, sign] of parts) {
      for (const [k, v] of t.bycol)
        out.bycol.set(k, (out.bycol.get(k) ?? 0) + sign * v);
      out.total += sign * t.total;
    }
    return out;
  };

  const grossProfit = merge([
    [revenue, 1],
    [cogs, -1],
  ]);
  const operatingIncome = merge([
    [grossProfit, 1],
    [opex, -1],
  ]);
  const netIncome = merge([
    [operatingIncome, 1],
    [otherIncome, 1],
    [otherExpense, -1],
  ]);
  const totalRevenue = merge([
    [revenue, 1],
    [otherIncome, 1],
  ]);

  return {
    colKeys,
    revenue,
    otherIncome,
    totalRevenue,
    cogs,
    grossProfit,
    opex,
    operatingIncome,
    otherExpense,
    netIncome,
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

/* ---------------------------------------------------------------------------
   Category-grouped income statement for /financials/statement. Groups
   account-level gl_pivot cells (Revenue + Expense classifications) by the
   admin-assigned Category on gl_accounts (edited on the Chart of Accounts
   page), one expandable group per category. Everything is plain JSON —
   records, not Maps — because the built statement crosses the server →
   client boundary into the collapsible table component.
--------------------------------------------------------------------------- */

export const UNCATEGORIZED = "Uncategorized";

// Expense categories treated as direct costs: they render between Income and
// the operating expense categories, and Gross profit = income − direct costs.
// Matched on the normalized category name so "Direct Costs", "direct cost",
// or a COGS-style label all work.
const DIRECT_COST_CATEGORIES = new Set([
  "direct costs",
  "direct cost",
  "direct labor",
  "cost of goods sold",
  "cost of sales",
  "cogs",
]);

/** Lowercase, collapse whitespace, and fold "&" to "and" so user-typed
    category labels match regardless of spacing/ampersand style. */
const normalizeLabel = (label: string): string =>
  label
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\s+/g, " ")
    .trim();

export function isDirectCostCategory(label: string): boolean {
  return DIRECT_COST_CATEGORIES.has(normalizeLabel(label));
}

// Employee-benefits allocation: the direct-labor share of each employee-
// benefits category is reclassified above the gross profit line. Per column,
// the share is Direct Labor ÷ (Direct Labor + Salaries & Wages). Direct Labor
// is matched by account name anywhere in the expense sections (or by
// membership in a category named "Direct Labor"); Salaries & Wages and
// Employee Benefits are matched by category name.
const SALARY_WAGE_CATEGORIES = new Set(["salaries and wages"]);

const EMPLOYEE_BENEFIT_CATEGORIES = new Set(["employee benefits"]);

export const ALLOCATED_BENEFITS_LABEL = "Employee Benefits (Allocated)";

function isSalaryWageCategory(label: string): boolean {
  return SALARY_WAGE_CATEGORIES.has(normalizeLabel(label));
}

function isEmployeeBenefitsCategory(label: string): boolean {
  return EMPLOYEE_BENEFIT_CATEGORIES.has(normalizeLabel(label));
}

function isDirectLaborCategory(label: string): boolean {
  return normalizeLabel(label) === "direct labor";
}

function isDirectLaborAccount(name: string): boolean {
  // "710 Labor Cost" is the direct-labor account in the SMW chart of
  // accounts; "direct labor" covers conventionally named accounts.
  const n = normalizeLabel(name);
  return n.includes("direct labor") || n.includes("710 labor cost");
}

export interface StatementTotals {
  cells: Record<string, number>;
  total: number;
}

export interface StatementLine extends StatementTotals {
  /** Account full name (gl_pivot account row key). */
  key: string;
}

export interface StatementGroup extends StatementTotals {
  /** Category label; UNCATEGORIZED for accounts with none assigned. */
  label: string;
  rows: StatementLine[];
}

export interface StatementSection extends StatementTotals {
  label: string;
  groups: StatementGroup[];
}

/** Serializable form of Eliminations for the statement's client table. */
export interface StatementEliminations {
  lines: ({ label: string } & StatementTotals)[];
  adjusted: StatementTotals;
}

/** Re-key an Eliminations result to plain records for the client boundary. */
export function serializeEliminations(
  e: Eliminations,
): StatementEliminations {
  const toTotals = (t: PivotTotals): StatementTotals => ({
    cells: Object.fromEntries(t.bycol),
    total: t.total,
  });
  return {
    lines: e.lines.map((l) => ({ label: l.label, ...toTotals(l.totals) })),
    adjusted: toTotals(e.adjusted),
  };
}

export interface CategoryStatement {
  colKeys: string[];
  income: StatementSection;
  /** Expense categories matching isDirectCostCategory; empty when none. */
  directCosts: StatementSection;
  /** income − directCosts. Null when no direct-cost category is assigned —
      showing income as "gross profit" would be misleading. */
  grossProfit: StatementTotals | null;
  /** The remaining (operating) expense categories. */
  expenses: StatementSection;
  /** income − directCosts − expenses, per column and overall. */
  netIncome: StatementTotals;
}

export function buildCategoryStatement(
  cells: PivotCell[],
  categoryByAccount: ReadonlyMap<string, string>,
): CategoryStatement {
  const colKeys = [...new Set(cells.map((c) => c.col_key))].sort();

  // classification → category → account → line
  const byClass = new Map<string, Map<string, Map<string, StatementLine>>>([
    ["Revenue", new Map()],
    ["Expense", new Map()],
  ]);
  for (const c of cells) {
    const groups = byClass.get(c.classification ?? "");
    if (!groups) continue;
    const category = categoryByAccount.get(c.row_key) ?? UNCATEGORIZED;
    let group = groups.get(category);
    if (!group) {
      group = new Map();
      groups.set(category, group);
    }
    let line = group.get(c.row_key);
    if (!line) {
      line = { key: c.row_key, cells: {}, total: 0 };
      group.set(c.row_key, line);
    }
    const v = Number(c.amount);
    line.cells[c.col_key] = (line.cells[c.col_key] ?? 0) + v;
    line.total += v;
  }

  const sum = (parts: StatementTotals[]): StatementTotals => {
    const out: StatementTotals = { cells: {}, total: 0 };
    for (const p of parts) {
      for (const [k, v] of Object.entries(p.cells))
        out.cells[k] = (out.cells[k] ?? 0) + v;
      out.total += p.total;
    }
    return out;
  };

  // Largest total first, Uncategorized always last.
  const byTotalDesc = (a: StatementGroup, b: StatementGroup): number => {
    if (a.label === UNCATEGORIZED) return 1;
    if (b.label === UNCATEGORIZED) return -1;
    return b.total - a.total;
  };

  const buildGroups = (classification: string): StatementGroup[] =>
    [...byClass.get(classification)!.entries()]
      .map(([category, lines]): StatementGroup => {
        const rows = [...lines.values()].sort((a, b) => b.total - a.total);
        return { label: category, rows, ...sum(rows) };
      })
      .sort(byTotalDesc);

  // Reclassify the direct-labor share of Employee Benefits into Direct Costs,
  // per column: moved = benefits × Direct Labor ÷ (Direct Labor + Salaries &
  // Wages). Mutates both group arrays; net income is unchanged. The source
  // category keeps its full account rows plus a "Less:" contra line so the
  // ledger amounts stay auditable against QuickBooks.
  const allocateBenefits = (
    direct: StatementGroup[],
    opex: StatementGroup[],
  ): void => {
    const benefitGroups = opex.filter((g) => isEmployeeBenefitsCategory(g.label));
    if (direct.length === 0 || benefitGroups.length === 0) return;

    // Direct Labor may be categorized anywhere in the expense sections —
    // match by account name, or take a whole category named "Direct Labor".
    const laborByCol: Record<string, number> = {};
    for (const g of [...direct, ...opex])
      for (const r of g.rows)
        if (isDirectLaborCategory(g.label) || isDirectLaborAccount(r.key))
          for (const [k, v] of Object.entries(r.cells))
            laborByCol[k] = (laborByCol[k] ?? 0) + v;

    const salariesByCol: Record<string, number> = {};
    for (const g of opex)
      if (isSalaryWageCategory(g.label))
        for (const [k, v] of Object.entries(g.cells))
          salariesByCol[k] = (salariesByCol[k] ?? 0) + v;

    const ratio = (k: string): number => {
      const labor = laborByCol[k] ?? 0;
      const denom = labor + (salariesByCol[k] ?? 0);
      if (labor <= 0 || denom <= 0) return 0;
      return Math.min(1, labor / denom);
    };

    const allocated: StatementGroup = {
      label: ALLOCATED_BENEFITS_LABEL,
      rows: [],
      cells: {},
      total: 0,
    };
    for (const g of benefitGroups) {
      const moved: StatementTotals = { cells: {}, total: 0 };
      for (const k of colKeys) {
        const v = (g.cells[k] ?? 0) * ratio(k);
        if (v === 0) continue;
        moved.cells[k] = v;
        moved.total += v;
      }
      if (Object.keys(moved.cells).length === 0) continue;

      g.rows.push({
        key: "Less: allocated to Direct Costs",
        cells: Object.fromEntries(
          Object.entries(moved.cells).map(([k, v]) => [k, -v]),
        ),
        total: -moved.total,
      });
      for (const [k, v] of Object.entries(moved.cells))
        g.cells[k] = (g.cells[k] ?? 0) - v;
      g.total -= moved.total;

      allocated.rows.push({
        key: `Allocated from ${g.label}`,
        cells: moved.cells,
        total: moved.total,
      });
      for (const [k, v] of Object.entries(moved.cells))
        allocated.cells[k] = (allocated.cells[k] ?? 0) + v;
      allocated.total += moved.total;
    }
    if (allocated.rows.length > 0) {
      direct.push(allocated);
      direct.sort(byTotalDesc);
      opex.sort(byTotalDesc);
    }
  };

  const section = (label: string, groups: StatementGroup[]): StatementSection =>
    ({ label, groups, ...sum(groups) });

  const subtract = (a: StatementTotals, b: StatementTotals): StatementTotals => ({
    cells: Object.fromEntries(
      colKeys.map((k) => [k, (a.cells[k] ?? 0) - (b.cells[k] ?? 0)]),
    ),
    total: a.total - b.total,
  });

  const expenseGroups = buildGroups("Expense");
  const directGroups = expenseGroups.filter((g) => isDirectCostCategory(g.label));
  const opexGroups = expenseGroups.filter((g) => !isDirectCostCategory(g.label));
  allocateBenefits(directGroups, opexGroups);

  const income = section("Income", buildGroups("Revenue"));
  const directCosts = section("Direct Costs", directGroups);
  const expenses = section(
    directCosts.groups.length > 0 ? "Operating Expenses" : "Expenses",
    opexGroups,
  );
  const grossProfit =
    directCosts.groups.length > 0 ? subtract(income, directCosts) : null;
  const netIncome = subtract(subtract(income, directCosts), expenses);
  return { colKeys, income, directCosts, grossProfit, expenses, netIncome };
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
    display?: string;
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
    display: DISPLAY_MODES.some((d) => d.key === sp.display)
      ? (sp.display as DisplayMode)
      : "amount",
  };
}
