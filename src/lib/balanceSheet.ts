// Balance Sheet (/financials/balance-sheet and /api/export/balance-sheet):
// QuickBooks' own month-end balances (gl_balances, migration 0036 — imported
// by syncBalanceSheet in src/lib/quickbooks.ts) assembled into Assets,
// Liabilities and Equity. Nothing is derived from ledger activity: every
// amount is the balance QuickBooks reports for that account at that month
// end, including QuickBooks' computed Net Income line, so each company's
// sheet ties to QuickBooks' Balance Sheet to the cent. All companies is the
// plain sum of the companies, merged by account full name like the Income
// Statement — as booked, no intercompany eliminations. Plain JSON throughout
// (records, not Maps) because the built sheet crosses into a client
// component.

import { MONTH_PARAM, latestMonth } from "@/lib/financials";

/** First month end on the Balance Sheet: where the frozen ledger history
    starts. The sync loads month ends from here. */
export const BALANCE_HISTORY_START = "2023-01";

export type BalanceColDim = "month" | "quarter" | "year" | "company";

export const BALANCE_COL_DIMS: { key: BalanceColDim; label: string }[] = [
  { key: "month", label: "Month-end" },
  { key: "quarter", label: "Quarter-end" },
  { key: "year", label: "Year-end" },
  { key: "company", label: "Company" },
];

/** The consolidated column in the Company layout. */
export const TOTAL_COL = "total";

export interface BalanceSheetState {
  company: string; // realm id or "all"
  from: string; // YYYY-MM
  to: string; // YYYY-MM — the "as of" month in the Company layout
  cols: BalanceColDim;
}

/** Default first column: the prior year end, so the default view reads as
    the opening position followed by each month end of the year so far. */
export function defaultBalanceFrom(): string {
  return `${Number(latestMonth().slice(0, 4)) - 1}-12`;
}

const clampToHistory = (month: string): string => {
  const max = latestMonth();
  if (month > max) return max;
  return month < BALANCE_HISTORY_START ? BALANCE_HISTORY_START : month;
};

/** Page/export params → state; anything invalid falls back to the defaults.
    Like every Financials view, the in-progress month is never reachable. */
export function balanceSheetState(
  get: (key: string) => string | null | undefined,
  validRealms: ReadonlySet<string>,
): BalanceSheetState {
  const company = get("company");
  const fromRaw = get("from") ?? "";
  const toRaw = get("to") ?? "";
  const cols = get("cols");
  const to = clampToHistory(MONTH_PARAM.test(toRaw) ? toRaw : latestMonth());
  const from = clampToHistory(MONTH_PARAM.test(fromRaw) ? fromRaw : defaultBalanceFrom());
  return {
    company: company && validRealms.has(company) ? company : "all",
    from: from > to ? to : from,
    to,
    cols: BALANCE_COL_DIMS.some((d) => d.key === cols) ? (cols as BalanceColDim) : "month",
  };
}

function stateParams(s: BalanceSheetState, all: boolean): URLSearchParams {
  const params = new URLSearchParams();
  if (all || s.company !== "all") params.set("company", s.company);
  if (all || s.from !== defaultBalanceFrom()) params.set("from", s.from);
  if (all || s.to !== latestMonth()) params.set("to", s.to);
  if (all || s.cols !== "month") params.set("cols", s.cols);
  return params;
}

/** Page URL for a filter state; defaults are omitted to keep URLs clean. */
export function balanceSheetHref(s: BalanceSheetState): string {
  const q = stateParams(s, false).toString();
  return q ? `/financials/balance-sheet?${q}` : "/financials/balance-sheet";
}

/** Excel export; carries the full state so the file matches the screen. */
export function balanceSheetExportHref(s: BalanceSheetState): string {
  return `/api/export/balance-sheet?${stateParams(s, true)}`;
}

/** Every month "YYYY-MM" from..to inclusive. */
export function monthsBetween(from: string, to: string): string[] {
  const months: string[] = [];
  let [y, m] = from.split("-").map(Number);
  for (;;) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    if (key > to) break;
    months.push(key);
    if (++m > 12) {
      m = 1;
      y++;
    }
  }
  return months;
}

/**
 * The month ends to read and the columns they become. Balances don't add
 * across time, so a quarter or year column is the balance at its last month
 * end in range (the "to" month closes the last, possibly partial, one). The
 * Company layout shows every company as of the "to" month, plus their total.
 */
export function balanceColumns(
  s: BalanceSheetState,
  realms: string[],
): { months: string[]; colKeys: string[] } {
  if (s.cols === "company") {
    return { months: [s.to], colKeys: realms.length > 1 ? [...realms, TOTAL_COL] : realms };
  }
  const months = monthsBetween(s.from, s.to).filter((m) => {
    if (m === s.to || s.cols === "month") return true;
    const mm = Number(m.slice(5, 7));
    return s.cols === "quarter" ? mm % 3 === 0 : mm === 12;
  });
  return { months, colKeys: months };
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09" → "Sep 30, 2026". */
export function monthEndLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${MONTH_NAMES[m - 1]} ${new Date(Date.UTC(y, m, 0)).getUTCDate()}, ${y}`;
}

export function balanceColLabel(
  cols: BalanceColDim,
  key: string,
  companyByRealm: ReadonlyMap<string, string>,
): string {
  if (cols !== "company") return monthEndLabel(key);
  return key === TOTAL_COL ? "Total" : (companyByRealm.get(key) ?? key);
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** One stored balance, as gl_balance_sheet returns it. */
export interface BalanceCell {
  realm: string;
  month: string; // YYYY-MM
  accountKey: string;
  /** Chart of accounts "Parent:Sub" path (the report label if unmatched). */
  name: string;
  section: string | null;
  accountType: string | null;
  accountNumber: string | null;
  amount: number;
}

export type SectionKey = "Asset" | "Liability" | "Equity" | "Other";

export interface BalanceTotals {
  cells: Record<string, number>;
}

export interface BalanceLine extends BalanceTotals {
  /** Account full name — also the ledger drill-down's account key. */
  key: string;
  /** A line QuickBooks computes (Net Income) rather than an account. */
  computed: boolean;
  accountNumber: string | null;
}

export interface BalanceGroup extends BalanceTotals {
  label: string;
  rows: BalanceLine[];
  /** Counts toward the section's current subtotal. */
  current: boolean;
  /** A computed line shown as one plain row rather than an expandable group. */
  single: boolean;
}

export interface BalanceSection extends BalanceTotals {
  key: SectionKey;
  label: string;
  groups: BalanceGroup[];
  /** Total current assets / liabilities; null when the section has none. */
  current: BalanceTotals | null;
}

export interface BalanceSheet {
  colKeys: string[];
  assets: BalanceSection;
  liabilities: BalanceSection;
  equity: BalanceSection;
  /** Lines QuickBooks placed in no recognizable section (normally empty). */
  other: BalanceSection;
  liabilitiesAndEquity: BalanceTotals;
  /** Assets − (liabilities + equity); null when every column balances. */
  difference: BalanceTotals | null;
}

// QuickBooks' Balance Sheet groups accounts by account type, in this order.
const TYPE_GROUPS: Record<string, { section: SectionKey; label: string; order: number; current: boolean }> = {
  Bank: { section: "Asset", label: "Bank accounts", order: 1, current: true },
  "Accounts Receivable": { section: "Asset", label: "Accounts receivable", order: 2, current: true },
  "Other Current Asset": { section: "Asset", label: "Other current assets", order: 3, current: true },
  "Fixed Asset": { section: "Asset", label: "Fixed assets", order: 4, current: false },
  "Other Asset": { section: "Asset", label: "Other assets", order: 5, current: false },
  "Accounts Payable": { section: "Liability", label: "Accounts payable", order: 1, current: true },
  "Credit Card": { section: "Liability", label: "Credit cards", order: 2, current: true },
  "Other Current Liability": { section: "Liability", label: "Other current liabilities", order: 3, current: true },
  "Long Term Liability": { section: "Liability", label: "Long-term liabilities", order: 4, current: false },
  Equity: { section: "Equity", label: "Equity", order: 1, current: false },
};

// Accounts whose type doesn't match their section (or is unknown) join the
// section's catch-all group.
const FALLBACK_GROUP: Record<SectionKey, string> = {
  Asset: "Other assets",
  Liability: "Other liabilities",
  Equity: "Equity",
  Other: "Other",
};

const SECTION_LABELS: Record<SectionKey, string> = {
  Asset: "Assets",
  Liability: "Liabilities",
  Equity: "Equity",
  Other: "Other",
};

const asSection = (s: string | null): SectionKey =>
  s === "Asset" || s === "Liability" || s === "Equity" ? s : "Other";

export function buildBalanceSheet(
  cells: BalanceCell[],
  colKeys: string[],
  /** The columns a stored balance lands in (Company layout: its company's
      and the total). */
  colsFor: (cell: BalanceCell) => string[],
): BalanceSheet {
  type GroupAcc = {
    label: string;
    order: number;
    current: boolean;
    single: boolean;
    lines: Map<string, BalanceLine>;
  };
  const sections = new Map<SectionKey, Map<string, GroupAcc>>(
    (["Asset", "Liability", "Equity", "Other"] as SectionKey[]).map((k) => [k, new Map()]),
  );

  for (const c of cells) {
    const cols = colsFor(c);
    if (cols.length === 0) continue;
    const section = asSection(c.section);
    const computed = c.accountKey.startsWith("row:");
    const type = c.accountType ? TYPE_GROUPS[c.accountType] : undefined;
    const def = computed
      ? { label: c.name, order: 90, current: false, single: true }
      : type && type.section === section
        ? { ...type, single: false }
        : { label: FALLBACK_GROUP[section], order: 80, current: false, single: false };
    const groups = sections.get(section)!;
    let group = groups.get(def.label);
    if (!group) {
      group = { ...def, lines: new Map() };
      groups.set(def.label, group);
    }
    let line = group.lines.get(c.name);
    if (!line) {
      line = { key: c.name, computed, accountNumber: c.accountNumber, cells: {} };
      group.lines.set(c.name, line);
    }
    for (const k of cols) line.cells[k] = (line.cells[k] ?? 0) + Number(c.amount);
  }

  const sum = (parts: BalanceTotals[]): BalanceTotals => {
    const out: BalanceTotals = { cells: {} };
    for (const p of parts)
      for (const [k, v] of Object.entries(p.cells)) out.cells[k] = (out.cells[k] ?? 0) + v;
    return out;
  };

  // Chart order within a group: account number (numeric-aware), then name —
  // which also keeps sub-accounts right under their parent.
  const byChartOrder = (a: BalanceLine, b: BalanceLine): number => {
    if (a.accountNumber && b.accountNumber && a.accountNumber !== b.accountNumber)
      return a.accountNumber.localeCompare(b.accountNumber, undefined, { numeric: true });
    if (a.accountNumber && !b.accountNumber) return -1;
    if (!a.accountNumber && b.accountNumber) return 1;
    return a.key.localeCompare(b.key, undefined, { numeric: true });
  };

  const buildSection = (key: SectionKey): BalanceSection => {
    const groups = [...sections.get(key)!.values()]
      .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
      .map((g): BalanceGroup => {
        const rows = [...g.lines.values()].sort(byChartOrder);
        return { label: g.label, rows, current: g.current, single: g.single, ...sum(rows) };
      });
    const currentGroups = groups.filter((g) => g.current);
    return {
      key,
      label: SECTION_LABELS[key],
      groups,
      current: currentGroups.length > 0 ? sum(currentGroups) : null,
      ...sum(groups),
    };
  };

  const assets = buildSection("Asset");
  const liabilities = buildSection("Liability");
  const equity = buildSection("Equity");
  const other = buildSection("Other");
  const liabilitiesAndEquity = sum([liabilities, equity]);
  const diff: BalanceTotals = {
    cells: Object.fromEntries(
      colKeys.map((k) => [
        k,
        Math.round(((assets.cells[k] ?? 0) - (liabilitiesAndEquity.cells[k] ?? 0)) * 100) / 100,
      ]),
    ),
  };
  return {
    colKeys,
    assets,
    liabilities,
    equity,
    other,
    liabilitiesAndEquity,
    difference: Object.values(diff.cells).some((v) => v !== 0) ? diff : null,
  };
}
