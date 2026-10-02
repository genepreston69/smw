// Budget (/financials/budget): a calendar-year budget built from a trailing-
// twelve-month baseline of ledger actuals, grown by per-company growth
// assumptions — a rate per account category, falling back to the company's
// revenue / expense rate (migrations 0026, 0028) — plus approved new
// initiatives (migrations 0026, 0029).
//
// Everything here is pure: the page fetches gl_pivot cells and the budget
// tables, and these helpers re-key them into synthetic PivotCells that feed
// the same buildCategoryStatement / buildEliminations as the Income
// Statement — so the budget has exactly the statement's layout, categories,
// direct-cost split, and benefits allocation.

import {
  buildCategoryStatement,
  buildEliminations,
  isDirectCostCategory,
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

export const INITIATIVE_STATUS_LABEL: Record<InitiativeStatus, string> = {
  proposed: "Proposed — not in budget",
  approved: "Approved — in budget",
  rejected: "Rejected",
};

export const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

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

/** Moves baseline month cells onto the budget columns, scaled per cell:
    each baseline month lands on the same calendar month of the budget year
    (Jul 2025 → Jul 2027, Jan 2026 → Jan 2027), so seasonality carries
    forward. */
function shiftCells(
  cells: PivotCell[],
  toCol: MonthToCol,
  factor: (c: PivotCell) => number,
): PivotCell[] {
  const out: PivotCell[] = [];
  for (const c of cells) {
    const month = Number(c.col_key.slice(5, 7));
    const col = toCol(month);
    if (col === null) continue;
    out.push({ ...c, col_key: col, amount: Number(c.amount) * factor(c) });
  }
  return out;
}

/**
 * Baseline account cells (row_dim account, col_dim month, one realm) grown
 * by that realm's assumptions — each account at its category's rate, looked
 * up in the realm's own account → category map — and moved onto the budget
 * year.
 */
export function growBaselineCells(
  cells: PivotCell[],
  assumption: BudgetAssumption | undefined,
  categoryByAccount: ReadonlyMap<string, string>,
  toCol: MonthToCol,
): PivotCell[] {
  return shiftCells(
    cells,
    toCol,
    (c) => 1 + growthPct(assumption, c.classification, categoryByAccount.get(c.row_key)) / 100,
  );
}

/**
 * A realm's overall revenue growth factor: grown baseline revenue ÷ baseline
 * revenue. Equals 1 + its default revenue % when no revenue category has a
 * rate of its own; falls back to that when the baseline has no revenue.
 */
export function revenueGrowthFactor(
  cells: PivotCell[],
  assumption: BudgetAssumption | undefined,
  categoryByAccount: ReadonlyMap<string, string>,
): number {
  let base = 0;
  let grown = 0;
  for (const c of cells) {
    if (c.classification !== "Revenue") continue;
    const v = Number(c.amount);
    base += v;
    grown += v * (1 + growthPct(assumption, "Revenue", categoryByAccount.get(c.row_key)) / 100);
  }
  if (Math.abs(base) < 0.005) return 1 + (assumption?.revenue_growth_pct ?? 0) / 100;
  return grown / base;
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

/**
 * Budgeted revenue-by-customer slices for the intercompany eliminations:
 * the realm's baseline customer cells, moved onto the budget columns. Customer
 * cells carry no account, so no category rate applies; they grow by the
 * realm's overall revenue growth (revenueGrowthFactor). Initiatives carry no
 * customer, so they never eliminate.
 */
export function growEliminationSlice(
  slice: RealmRevenueSlice,
  factor: number,
  toCol: MonthToCol,
): RealmRevenueSlice {
  return { ...slice, cells: shiftCells(slice.cells, toCol, () => factor) };
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
  /** Each company's own account → category map (companies order): growth
      rates follow the company's categories, while categoryByAccount below
      only decides where a row shows on a consolidated statement. */
  realmCategories: ReadonlyMap<string, string>[];
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
  const noCategories: ReadonlyMap<string, string> = new Map();
  const categoriesOf = (idx: number) => i.realmCategories[idx] ?? noCategories;
  const budgetCells = (toCol: MonthToCol): PivotCell[] =>
    i.companies.flatMap((c, idx) => [
      ...growBaselineCells(
        i.baselineByRealm[idx] ?? [],
        i.assumptions[c.realmId],
        categoriesOf(idx),
        toCol,
      ),
      ...initiativeCells(
        i.approved.filter((x) => x.realm_id === c.realmId),
        toCol,
      ),
    ]);
  const revenueFactors = i.wantEliminations
    ? i.companies.map((c, idx) =>
        revenueGrowthFactor(i.baselineByRealm[idx] ?? [], i.assumptions[c.realmId], categoriesOf(idx)),
      )
    : [];
  const budgetSlices = (toCol: MonthToCol): RealmRevenueSlice[] =>
    i.wantEliminations
      ? i.companies.map((c, idx) =>
          growEliminationSlice(
            { realmId: c.realmId, companyName: c.name, cells: i.eliminationCellsByRealm[idx] ?? [] },
            revenueFactors[idx],
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
 * Export URL for the budget workbook. Carries every company's rates on screen
 * — saved or not — so the file matches what's on screen: its defaults as
 * `growth=<realm>:<revenue>:<expense>` and each category rate as
 * `cgrowth=<realm>:<R|E>:<pct>:<category>` (category last, since a label may
 * contain colons).
 */
export function budgetExportHref(s: {
  company: string;
  cols: BudgetColDim;
  view: BudgetView;
  assumptions: BudgetAssumption[];
}): string {
  const params = new URLSearchParams({ company: s.company, cols: s.cols, view: s.view });
  for (const a of s.assumptions) {
    params.append("growth", `${a.realm_id}:${a.revenue_growth_pct}:${a.expense_growth_pct}`);
    for (const cls of ["Revenue", "Expense"] as const)
      for (const [category, pct] of Object.entries(a.category_growth[cls]))
        params.append("cgrowth", `${a.realm_id}:${cls[0]}:${pct}:${category}`);
  }
  return `/api/export/budget?${params}`;
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
