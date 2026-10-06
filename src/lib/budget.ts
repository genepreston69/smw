// Budget (/financials/budget): a calendar-year budget built from a trailing-
// twelve-month baseline of ledger actuals, grown by per-company growth
// assumptions — a rate per account category, falling back to the company's
// revenue / expense rate (migrations 0026, 0028) — with any account-month an
// admin typed over replacing its growth-based amount (migration 0031), plus
// approved new initiatives (migrations 0026, 0029).
//
// The budget is built per QuickBooks class and rolls up (migration 0034):
// every baseline cell, typed figure, and initiative belongs to one class, a
// company's budget is the sum of its classes, and All companies is the sum of
// the companies. Growth rates are per company and apply to every class.
//
// Everything here is pure: the page fetches gl_pivot cells and the budget
// tables, and these helpers re-key them into synthetic PivotCells that feed
// the same buildCategoryStatement as the Income Statement — so the budget
// has exactly the statement's layout, categories, and direct-cost split.

import {
  buildCategoryStatement,
  isDirectCostCategory,
  type CategoryStatement,
  type PivotCell,
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

export const INITIATIVE_STATUS_LABEL: Record<InitiativeStatus, string> = {
  proposed: "Proposed — not in budget",
  approved: "Approved — in budget",
  rejected: "Rejected",
};

export const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** The class key for ledger lines with no QuickBooks class — gl_pivot's own
    key for them (migration 0009), so budget classes line up with the
    Financials pivot's Class dimension. */
export const NO_CLASS = "(no class)";

/** A budget input cell: one account × month of ledger activity in one
    QuickBooks class (gl_pivot's shape plus the class). */
export interface BudgetCell extends PivotCell {
  /** QuickBooks class, keyed as gl_pivot keys it (NO_CLASS when none). */
  class_name: string;
}

/** Class filter: one class, or null for every class (the company roll-up). */
export type BudgetClass = string | null;

/** Keeps the rows of one class; a null class keeps everything. */
export const inBudgetClass =
  (cls: BudgetClass) =>
  (x: { class_name: string }): boolean =>
    cls === null || x.class_name === cls;

/** Class order everywhere: alphabetical, NO_CLASS last. */
export const compareClasses = (a: string, b: string): number =>
  a === b ? 0 : a === NO_CLASS ? 1 : b === NO_CLASS ? -1 : a.localeCompare(b);

/** Distinct classes in compareClasses order. */
export const sortClasses = (classes: Iterable<string>): string[] =>
  [...new Set(classes)].sort(compareClasses);

/** Baseline window: the twelve months ending June 30 of the prior year. */
export function baselineRange(year: number): { from: string; to: string } {
  return { from: `${year - 2}-07`, to: `${year - 1}-06` };
}

export type GrowthClass = "Revenue" | "Expense";

/** Category growth % by classification, then category label (exactly as
    gl_accounts.category groups the statement). */
export type CategoryGrowth = Record<GrowthClass, Record<string, number>>;

export const emptyCategoryGrowth = (): CategoryGrowth => ({ Revenue: {}, Expense: {} });

export interface BudgetAssumption {
  realm_id: string;
  /** Default for revenue accounts whose category has no rate of its own. */
  revenue_growth_pct: number;
  /** Default for expense accounts whose category has no rate of its own. */
  expense_growth_pct: number;
  category_growth: CategoryGrowth;
}

/** A company's assumption with nothing set: every rate 0%. */
export const zeroAssumption = (realmId: string): BudgetAssumption => ({
  realm_id: realmId,
  revenue_growth_pct: 0,
  expense_growth_pct: 0,
  category_growth: emptyCategoryGrowth(),
});

const growthClass = (classification: string | null): GrowthClass =>
  classification === "Revenue" ? "Revenue" : "Expense";

/**
 * Growth % for one account: its category's rate for the company when one is
 * set, else the company's revenue or expense default. Uncategorized accounts
 * always take the default.
 */
export function growthPct(
  a: BudgetAssumption | undefined,
  classification: string | null,
  category: string | undefined,
): number {
  if (!a) return 0;
  const cls = growthClass(classification);
  const rates = a.category_growth[cls];
  if (category !== undefined && Object.hasOwn(rates, category)) return rates[category];
  return cls === "Revenue" ? a.revenue_growth_pct : a.expense_growth_pct;
}

/** True when two assumptions apply exactly the same rates. */
export function sameAssumption(a: BudgetAssumption, b: BudgetAssumption): boolean {
  if (a.revenue_growth_pct !== b.revenue_growth_pct) return false;
  if (a.expense_growth_pct !== b.expense_growth_pct) return false;
  return (["Revenue", "Expense"] as const).every((cls) => {
    const x = a.category_growth[cls];
    const y = b.category_growth[cls];
    const keys = Object.keys(x);
    return (
      keys.length === Object.keys(y).length &&
      keys.every((k) => Object.hasOwn(y, k) && x[k] === y[k])
    );
  });
}

/** One category row of the growth assumptions grid. */
export interface GrowthCategory {
  classification: GrowthClass;
  category: string;
  /** An expense category the statement shows under Direct Costs. */
  direct: boolean;
  /** Companies with at least one account in this category. */
  realms: string[];
}

/**
 * Categories that can carry a growth rate: every (classification, category)
 * on the given companies' revenue and expense accounts. Ordered like the
 * statement — income, then direct costs, then other expenses — and by name
 * within each.
 */
export function growthCategories(
  accounts: { realm_id: string; classification: string; category: string | null }[],
  realms: readonly string[],
): GrowthCategory[] {
  const byKey = new Map<string, GrowthCategory>();
  for (const a of accounts) {
    if (!a.category || !realms.includes(a.realm_id)) continue;
    if (a.classification !== "Revenue" && a.classification !== "Expense") continue;
    const key = `${a.classification}:${a.category}`;
    let row = byKey.get(key);
    if (!row) {
      row = {
        classification: a.classification,
        category: a.category,
        direct: a.classification === "Expense" && isDirectCostCategory(a.category),
        realms: [],
      };
      byKey.set(key, row);
    }
    if (!row.realms.includes(a.realm_id)) row.realms.push(a.realm_id);
  }
  const rank = (r: GrowthCategory) =>
    r.classification === "Revenue" ? 0 : r.direct ? 1 : 2;
  return [...byKey.values()]
    .map((r) => ({ ...r, realms: realms.filter((x) => r.realms.includes(x)) }))
    .sort((x, y) => rank(x) - rank(y) || x.category.localeCompare(y.category));
}

export interface BudgetInitiativeLine {
  account_name: string;
  classification: "Revenue" | "Expense";
  annual_amount: number;
}

export interface BudgetInitiative {
  id: string;
  realm_id: string;
  /** QuickBooks class the initiative budgets (NO_CLASS when none). */
  class_name: string;
  name: string;
  description: string | null;
  /** First and last budget-year month (1–12) the amounts are spread over. */
  start_month: number;
  end_month: number;
  status: InitiativeStatus;
  created_at: string;
  approved_at: string | null;
  approved_by_name: string | null;
  lines: BudgetInitiativeLine[];
}

/** Number of budget months an initiative runs (start through end, inclusive). */
export const initiativeMonthCount = (i: Pick<BudgetInitiative, "start_month" | "end_month">) =>
  i.end_month - i.start_month + 1;

/** "Jul – Dec 2027", or "Jul 2027" for a one-month run. */
export function initiativePeriodLabel(
  i: Pick<BudgetInitiative, "start_month" | "end_month">,
  year: number,
): string {
  const from = MONTH_NAMES[i.start_month - 1];
  const to = MONTH_NAMES[i.end_month - 1];
  return i.start_month === i.end_month ? `${from} ${year}` : `${from} – ${to} ${year}`;
}

/**
 * One initiative line spread over the budget year: twelve amounts (Jan–Dec),
 * the line's amount divided evenly over the initiative's run and 0 outside it.
 * The single source of the spread — the budget (initiativeCells) and the
 * initiative exports both use it, so the file matches the budget.
 */
export function spreadInitiativeLine(
  i: Pick<BudgetInitiative, "start_month" | "end_month">,
  amount: number,
): number[] {
  const perMonth = amount / initiativeMonthCount(i);
  return Array.from({ length: 12 }, (_, idx) =>
    idx + 1 >= i.start_month && idx + 1 <= i.end_month ? perMonth : 0,
  );
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

/** A budget figure typed over one account × class × month (migrations 0031,
    0034). It replaces that class's growth-based amount for the month, so
    growth edits no longer move it; approved initiatives still add on top. */
export interface BudgetOverride {
  realm_id: string;
  /** Account full name, as the statement's account rows show it. */
  account: string;
  /** QuickBooks class the figure budgets (NO_CLASS when none). */
  class_name: string;
  classification: "Revenue" | "Expense";
  /** Budget month, 1–12. */
  month: number;
  amount: number;
}

/** One account's budget per month in one class, before initiatives (index
    0 = January). */
export interface AccountMonths {
  account: string;
  class_name: string;
  classification: string | null;
  account_type: string | null;
  months: number[];
  /** Months with a baseline cell or a typed figure: the ones that become
      statement cells. */
  present: boolean[];
  /** Months typed over (overrides). */
  typed: boolean[];
}

const twelve = <T,>(v: T): T[] => Array.from({ length: 12 }, () => v);

/** accountBaseMonths' key for one account in one class. */
export const accountClassKey = (account: string, cls: string) => `${cls}\u0000${account}`;

/**
 * Each account's budget per class and month before initiatives: its
 * baseline month in that class (the same calendar month a year earlier, so
 * seasonality carries forward — Jul 2025 → Jul 2027, Jan 2026 → Jan 2027)
 * grown at its category's rate, looked up in the realm's own account →
 * category map — except months typed over, which take the typed figure for
 * that class only. Keyed by accountClassKey. `cells` and `overrides` are one
 * realm's.
 */
export function accountBaseMonths(
  cells: readonly BudgetCell[],
  assumption: BudgetAssumption | undefined,
  categoryByAccount: ReadonlyMap<string, string>,
  overrides: readonly BudgetOverride[] = [],
): Map<string, AccountMonths> {
  const out = new Map<string, AccountMonths>();
  const entry = (
    account: string,
    cls: string,
    classification: string | null,
    accountType: string | null,
  ) => {
    const key = accountClassKey(account, cls);
    let a = out.get(key);
    if (!a) {
      a = {
        account,
        class_name: cls,
        classification,
        account_type: accountType,
        months: twelve(0),
        present: twelve(false),
        typed: twelve(false),
      };
      out.set(key, a);
    }
    return a;
  };
  for (const c of cells) {
    const m = Number(c.col_key.slice(5, 7)) - 1;
    if (!(m >= 0 && m < 12)) continue;
    const a = entry(c.row_key, c.class_name, c.classification, c.account_type);
    const factor =
      1 + growthPct(assumption, c.classification, categoryByAccount.get(c.row_key)) / 100;
    a.months[m] += Number(c.amount) * factor;
    a.present[m] = true;
  }
  for (const o of overrides) {
    const m = o.month - 1;
    if (!(m >= 0 && m < 12)) continue;
    const a = entry(o.account, o.class_name, o.classification, null);
    a.months[m] = o.amount;
    a.present[m] = true;
    a.typed[m] = true;
  }
  return out;
}

/**
 * Baseline account cells (account × month × class, one realm) as budget
 * cells: grown by that realm's assumptions, typed months replacing the
 * growth-based amount of their class (accountBaseMonths), and moved onto the
 * budget columns. Classes merge into their account's row.
 */
export function growBaselineCells(
  cells: readonly BudgetCell[],
  assumption: BudgetAssumption | undefined,
  categoryByAccount: ReadonlyMap<string, string>,
  toCol: MonthToCol,
  overrides: readonly BudgetOverride[] = [],
): PivotCell[] {
  const out: PivotCell[] = [];
  for (const a of accountBaseMonths(cells, assumption, categoryByAccount, overrides).values()) {
    for (let m = 0; m < 12; m++) {
      if (!a.present[m]) continue;
      const col = toCol(m + 1);
      if (col === null) continue;
      out.push({
        classification: a.classification,
        account_type: a.account_type,
        row_key: a.account,
        col_key: col,
        amount: a.months[m],
        line_count: 0,
      });
    }
  }
  return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Twelve months re-spread to a new annual total in the shape they already
 * have (each month scaled by total ÷ current total), or evenly when the
 * current months add up to nothing. Rounded to cents; any rounding
 * remainder lands on the largest month so the months add up to the total
 * exactly.
 */
export function respreadTotal(months: readonly number[], total: number): number[] {
  const current = months.reduce((s, v) => s + v, 0);
  const spread =
    Math.abs(current) >= 0.005
      ? months.map((v) => round2((v * total) / current))
      : twelve(round2(total / 12));
  const diff = round2(total - spread.reduce((s, v) => s + v, 0));
  if (diff !== 0) {
    let at = 11;
    for (let m = 0; m < 12; m++) if (Math.abs(spread[m]) > Math.abs(spread[at])) at = m;
    spread[at] = round2(spread[at] + diff);
  }
  return spread;
}

/**
 * Approved initiatives as account cells: each line's amount spread evenly
 * from the initiative's start month through its end month
 * (spreadInitiativeLine). Callers pass only the initiatives that should be in
 * the budget (approved ones).
 */
export function initiativeCells(
  initiatives: BudgetInitiative[],
  toCol: MonthToCol,
): PivotCell[] {
  const out: PivotCell[] = [];
  for (const i of initiatives) {
    for (const l of i.lines) {
      const months = spreadInitiativeLine(i, l.annual_amount);
      for (let m = i.start_month; m <= i.end_month; m++) {
        const col = toCol(m);
        if (col === null) continue;
        out.push({
          classification: l.classification,
          account_type: null,
          row_key: l.account_name,
          col_key: col,
          amount: months[m - 1],
          line_count: 0,
        });
      }
    }
  }
  return out;
}

/** Re-key actual gl_pivot month cells (budget year) onto one column, keeping
    months up to `throughMonth`. */
export function actualCells(
  cells: readonly PivotCell[],
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
  /** One class, or null for every class (inputs of other classes are
      ignored, so callers may pass every class's inputs). */
  cls: BudgetClass;
  /** Budget-year months already closed (0 = none). */
  closedThrough: number;
  companies: { realmId: string; name: string }[];
  assumptions: Record<string, BudgetAssumption>;
  /** Baseline account × month × class cells, one array per company
      (companies order). */
  baselineByRealm: BudgetCell[][];
  /** Each company's own account → category map (companies order): growth
      rates follow the company's categories, while categoryByAccount below
      only decides where a row shows on a consolidated statement. */
  realmCategories: ReadonlyMap<string, string>[];
  /** YTD actual account × month × class cells, all companies (null = not
      loaded). */
  actuals: BudgetCell[] | null;
  approved: BudgetInitiative[];
  /** Account × class months typed over, all companies (migrations 0031,
      0034). */
  overrides: readonly BudgetOverride[];
  categoryByAccount: ReadonlyMap<string, string>;
}

export interface AssembledBudget {
  statement: CategoryStatement;
  /** Budget vs Actual: columns "fy", "budget" (YTD) and "actual" (YTD). */
  variance: CategoryStatement | null;
}

/**
 * The budget statement (and, in the variance view, Budget vs Actual) from
 * raw inputs. Shared by the live page (BudgetWorkspace) and the Excel export
 * so the file always matches the screen.
 */
export function assembleBudget(i: BudgetInputs): AssembledBudget {
  const noCategories: ReadonlyMap<string, string> = new Map();
  const categoriesOf = (idx: number) => i.realmCategories[idx] ?? noCategories;
  const keep = inBudgetClass(i.cls);
  const budgetCells = (toCol: MonthToCol): PivotCell[] =>
    i.companies.flatMap((c, idx) => [
      ...growBaselineCells(
        (i.baselineByRealm[idx] ?? []).filter(keep),
        i.assumptions[c.realmId],
        categoriesOf(idx),
        toCol,
        i.overrides.filter((o) => o.realm_id === c.realmId && keep(o)),
      ),
      ...initiativeCells(
        i.approved.filter((x) => x.realm_id === c.realmId && keep(x)),
        toCol,
      ),
    ]);

  const toCol: MonthToCol = (m) => budgetColKey(i.year, m, i.colDim);
  const statement = buildCategoryStatement(budgetCells(toCol), i.categoryByAccount);

  // Budget vs Actual: full-year budget, YTD budget, and YTD actual as three
  // columns of one statement, so every row lines up.
  let variance: CategoryStatement | null = null;
  if (i.view === "variance" && i.actuals) {
    const fy: MonthToCol = () => "fy";
    const ytd: MonthToCol = (m) => (m <= i.closedThrough ? "budget" : null);
    variance = buildCategoryStatement(
      [
        ...budgetCells(fy),
        ...budgetCells(ytd),
        ...actualCells(i.actuals.filter(keep), "actual", i.closedThrough),
      ],
      i.categoryByAccount,
    );
  }
  return { statement, variance };
}

/** Budget-year months already closed as of the last complete month. */
export function closedMonthsOf(year: number, latestMonth: string): number {
  if (latestMonth < `${year}-01`) return 0;
  if (latestMonth >= `${year}-12`) return 12;
  return Number(latestMonth.slice(5, 7));
}

/**
 * Export URL for the budget workbook — or, with `perClass`, a zip holding one
 * workbook per class (/api/export/budget-classes). Carries the class filter
 * (`class`, absent for every class) and every company's rates on screen —
 * saved or not — so the file matches what's on screen: its defaults as
 * `growth=<realm>:<revenue>:<expense>` and each category rate as
 * `cgrowth=<realm>:<R|E>:<pct>:<category>` (category last, since a label may
 * contain colons).
 */
export function budgetExportHref(s: {
  company: string;
  cls: BudgetClass;
  cols: BudgetColDim;
  view: BudgetView;
  assumptions: BudgetAssumption[];
  perClass?: boolean;
}): string {
  const params = new URLSearchParams({ company: s.company, cols: s.cols, view: s.view });
  if (s.cls !== null) params.set("class", s.cls);
  for (const a of s.assumptions) {
    params.append("growth", `${a.realm_id}:${a.revenue_growth_pct}:${a.expense_growth_pct}`);
    for (const cls of ["Revenue", "Expense"] as const)
      for (const [category, pct] of Object.entries(a.category_growth[cls]))
        params.append("cgrowth", `${a.realm_id}:${cls[0]}:${pct}:${category}`);
  }
  return `/api/export/${s.perClass ? "budget-classes" : "budget"}?${params}`;
}

const validPct = (n: number) => Number.isFinite(n) && n >= -100 && n <= 1000;

/**
 * The export's rates: the saved assumption per company, replaced wholesale
 * by the on-screen rates from budgetExportHref's params. A company whose
 * `growth` param is missing or malformed keeps its saved rates; malformed
 * `cgrowth` entries are dropped (that category falls back to the default).
 */
export function assumptionsFromParams(
  sp: URLSearchParams,
  saved: readonly BudgetAssumption[],
): Record<string, BudgetAssumption> {
  const out: Record<string, BudgetAssumption> = Object.fromEntries(
    saved.map((a) => [a.realm_id, a]),
  );
  const overridden = new Set<string>();
  for (const g of sp.getAll("growth")) {
    const [realm, rev, exp] = g.split(":");
    const r = Number(rev);
    const e = Number(exp);
    if (!Object.hasOwn(out, realm) || !validPct(r) || !validPct(e)) continue;
    out[realm] = {
      realm_id: realm,
      revenue_growth_pct: r,
      expense_growth_pct: e,
      category_growth: emptyCategoryGrowth(),
    };
    overridden.add(realm);
  }
  for (const g of sp.getAll("cgrowth")) {
    const m = /^([^:]*):([RE]):([^:]*):([\s\S]+)$/.exec(g);
    if (!m || !overridden.has(m[1])) continue;
    const pct = Number(m[3]);
    if (m[3].trim() === "" || !validPct(pct)) continue;
    out[m[1]].category_growth[m[2] === "R" ? "Revenue" : "Expense"][m[4]] = pct;
  }
  return out;
}
