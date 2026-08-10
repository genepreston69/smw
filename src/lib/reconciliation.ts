// Reconciliation of a QuickBooks Profit and Loss export against the general
// ledger imported into this app (gl_lines, sliced through gl_pivot).
//
// The flow: /financials/reconciliation uploads the workbook QuickBooks
// produces from Reports → Profit and Loss (monthly columns), the server
// action parses it into account × month amounts, truncates the result at the
// last complete month (omitMonthsAfter — the in-progress month is omitted
// app-wide, and a partial month can never tie anyway), pulls the same period
// from gl_pivot (row_dim 'account', col_dim 'month', all companies, Revenue +
// Expense), and this module lines the two up. Both sides use QuickBooks'
// natural sign convention — income positive, expenses positive — so amounts
// compare directly with no sign flipping.
//
// Everything here is pure and JSON-serializable: the result crosses the
// server-action boundary into a client component.

import {
  buildEliminations,
  type PivotCell,
  type RealmRevenueSlice,
} from "@/lib/financials";

/** Amounts at or under half a cent apart are the same number — both sides
    round to cents, so anything smaller is floating-point noise. */
export const RECONCILE_TOLERANCE = 0.005;

/* ---------------------------------------------------------------------------
   Workbook parsing. Input is the sheet as a plain value grid (the server
   action flattens ExcelJS cells) so this stays testable and library-free.
--------------------------------------------------------------------------- */

export type GridValue = string | number | Date | null;

export interface PlColumn {
  /** gl_pivot month key: YYYY-MM. */
  key: string;
  /** Header text as it appeared in the export ("Jan 2026", "Aug 1-10 2026"). */
  label: string;
  /** First/last covered day, ISO dates. Partial-month headers narrow these. */
  start: string;
  end: string;
}

export interface ParsedPlRow {
  section: string;
  account: string;
  cells: Record<string, number>;
  /** Sum of the month cells (not the export's own Total column). */
  total: number;
}

export interface ParsedPl {
  columns: PlColumn[];
  rows: ParsedPlRow[];
  /** The export's own "Net Income" row, when present. */
  reportedNetIncome: { cells: Record<string, number>; total: number } | null;
  /** Overall covered period, from the month columns. */
  start: string;
  end: string;
  warnings: string[];
}

export class PlParseError extends Error {}

const MONTH_NUMBERS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// Subtotal/derived rows a P&L export interleaves with its account rows.
const COMPUTED_ROW_LABELS = new Set([
  "gross profit",
  "net operating income",
  "net other income",
  "net income",
  "net earnings",
]);

const normalize = (s: string): string =>
  s.toLowerCase().replace(/\s+/g, " ").trim();

/** Match key for one account: QuickBooks sub-accounts render as just their
    own name in the P&L, while gl_pivot keys them by "Parent:Sub" path — the
    last path segment is the common form. */
export const accountMatchKey = (name: string): string => {
  const parts = name.split(":");
  return normalize(parts[parts.length - 1]);
};

const pad2 = (n: number): string => String(n).padStart(2, "0");

const lastDay = (year: number, month: number): number =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

interface HeaderMatch {
  year: number;
  month: number;
  day1: number | null;
  day2: number | null;
}

function parseMonthHeader(value: GridValue): HeaderMatch | null {
  if (value instanceof Date) {
    return {
      year: value.getUTCFullYear(),
      month: value.getUTCMonth() + 1,
      day1: null,
      day2: null,
    };
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  // "Jan 2026" / "January 2026"
  let m = /^([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(text);
  if (m) {
    const month = MONTH_NUMBERS[m[1].slice(0, 3).toLowerCase()];
    if (!month) return null;
    return { year: Number(m[2]), month, day1: null, day2: null };
  }
  // Partial month: "Aug 1-10 2026" / "Aug 1-10, 2026"
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})\s*[-–]\s*(\d{1,2}),?\s+(\d{4})$/.exec(text);
  if (m) {
    const month = MONTH_NUMBERS[m[1].slice(0, 3).toLowerCase()];
    if (!month) return null;
    return { year: Number(m[4]), month, day1: Number(m[2]), day2: Number(m[3]) };
  }
  return null;
}

function asNumber(value: GridValue): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  // Formatted exports can carry "1,234.56" or "(123.45)" as text.
  const text = value.trim();
  if (text === "") return null;
  const negative = /^\(.*\)$/.test(text);
  const cleaned = text.replace(/[(),$\s]/g, "");
  if (cleaned === "" || !/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return negative ? -n : n;
}

/**
 * Parse a QuickBooks Profit and Loss export (monthly columns) into account
 * rows grouped by statement section. Throws PlParseError when the sheet
 * doesn't look like a P&L with month columns.
 */
export function parsePlWorkbook(grid: GridValue[][]): ParsedPl {
  const warnings: string[] = [];

  // Header row: the first row with at least one month-shaped header past the
  // label column.
  let headerRowIdx = -1;
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] ?? [];
    if (row.slice(1).some((v) => parseMonthHeader(v) !== null)) {
      headerRowIdx = r;
      break;
    }
  }
  if (headerRowIdx === -1) {
    throw new PlParseError(
      "No month columns found. Export the Profit and Loss report from QuickBooks with columns displayed by month.",
    );
  }

  // Map sheet columns to month buckets. Two partial columns of the same
  // month (rare) merge into one bucket spanning both.
  const headerRow = grid[headerRowIdx] ?? [];
  const columnByKey = new Map<string, PlColumn>();
  const bucketBySheetCol = new Map<number, string>();
  for (let c = 1; c < headerRow.length; c++) {
    const value = headerRow[c];
    const match = parseMonthHeader(value);
    if (!match) {
      const text = typeof value === "string" ? value.trim() : "";
      if (text !== "" && !/^total$/i.test(text)) {
        warnings.push(
          `Column "${text}" isn't a month or Total header and was ignored.`,
        );
      }
      continue;
    }
    const key = `${match.year}-${pad2(match.month)}`;
    const start = `${key}-${pad2(match.day1 ?? 1)}`;
    const end = `${key}-${pad2(match.day2 ?? lastDay(match.year, match.month))}`;
    const label =
      value instanceof Date ? `${key}` : String(value).trim();
    const existing = columnByKey.get(key);
    if (existing) {
      existing.start = existing.start < start ? existing.start : start;
      existing.end = existing.end > end ? existing.end : end;
    } else {
      columnByKey.set(key, { key, label, start, end });
    }
    bucketBySheetCol.set(c, key);
  }
  const columns = [...columnByKey.values()].sort((a, b) =>
    a.key.localeCompare(b.key),
  );
  if (columns.length === 0) {
    throw new PlParseError(
      "No month columns found. Export the Profit and Loss report from QuickBooks with columns displayed by month.",
    );
  }

  // Account rows, grouped under the section header above them. Sections are
  // any label-only row that isn't a subtotal; QuickBooks emits Income /
  // Cost of Goods Sold / Expenses / Other Income / Other Expenses.
  const rowByKey = new Map<string, ParsedPlRow>();
  const order: string[] = [];
  let reportedNetIncome: ParsedPl["reportedNetIncome"] = null;
  let section = "Income";
  for (let r = headerRowIdx + 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const label = typeof row[0] === "string" ? row[0].trim() : "";
    if (label === "") continue;

    const cells: Record<string, number> = {};
    let total = 0;
    let hasAmount = false;
    for (const [sheetCol, key] of bucketBySheetCol) {
      const n = asNumber(row[sheetCol]);
      if (n === null) continue;
      hasAmount = true;
      cells[key] = (cells[key] ?? 0) + n;
      total += n;
    }

    const norm = normalize(label);
    if (norm === "net income" && hasAmount) {
      reportedNetIncome = { cells, total };
      continue;
    }
    if (COMPUTED_ROW_LABELS.has(norm) || norm.startsWith("total for ")) continue;
    if (!hasAmount) {
      // A label with no amounts is a section header (or a parent account
      // whose activity lives on its child rows).
      section = label;
      continue;
    }

    // The same display name can appear twice (a parent account's own
    // activity next to a group header of the same name); fold into one row.
    const key = `${accountMatchKey(label)}`;
    const existing = rowByKey.get(key);
    if (existing) {
      for (const [k, v] of Object.entries(cells)) {
        existing.cells[k] = (existing.cells[k] ?? 0) + v;
      }
      existing.total += total;
    } else {
      rowByKey.set(key, { section, account: label, cells, total });
      order.push(key);
    }
  }

  if (order.length === 0) {
    throw new PlParseError(
      "No account rows found under the month columns — this doesn't look like a Profit and Loss export.",
    );
  }

  return {
    columns,
    rows: order.map((k) => rowByKey.get(k)!),
    reportedNetIncome,
    start: columns[0].start,
    end: columns[columns.length - 1].end,
    warnings,
  };
}

/**
 * Drop every month column after maxMonthKey (YYYY-MM) from a parsed export —
 * the reconciliation always runs against complete months only, so the
 * caller passes the last complete month and any current-month column
 * (full or partial, e.g. "Aug 1-10, 2026") falls away. Account rows are
 * re-totaled over the surviving columns; rows whose only activity was in
 * dropped months disappear with them. Throws PlParseError when nothing
 * survives — an export covering only the in-progress month can't reconcile.
 */
export function omitMonthsAfter(parsed: ParsedPl, maxMonthKey: string): ParsedPl {
  const kept = parsed.columns.filter((c) => c.key <= maxMonthKey);
  if (kept.length === parsed.columns.length) return parsed;
  if (kept.length === 0) {
    throw new PlParseError(
      "The export only covers the current month, which is excluded — reconciliation runs through the last complete month. Export a Profit and Loss that includes prior months.",
    );
  }
  const dropped = parsed.columns.filter((c) => c.key > maxMonthKey);
  const keptKeys = new Set(kept.map((c) => c.key));
  const filterCells = (cells: Record<string, number>) => {
    const out: Record<string, number> = {};
    let total = 0;
    for (const [k, v] of Object.entries(cells)) {
      if (!keptKeys.has(k)) continue;
      out[k] = v;
      total += v;
    }
    return { cells: out, total };
  };

  return {
    columns: kept,
    rows: parsed.rows
      .map((r) => ({ ...r, ...filterCells(r.cells) }))
      .filter((r) => Object.keys(r.cells).length > 0),
    reportedNetIncome: parsed.reportedNetIncome
      ? { ...filterCells(parsed.reportedNetIncome.cells) }
      : null,
    start: kept[0].start,
    end: kept[kept.length - 1].end,
    warnings: [
      ...parsed.warnings,
      `${dropped.length === 1 ? "Column" : "Columns"} ${dropped.map((c) => `"${c.label}"`).join(", ")} ${dropped.length === 1 ? "was" : "were"} excluded — reconciliation runs through the last complete month, so the in-progress month never enters the tie-out.`,
    ],
  };
}

/* ---------------------------------------------------------------------------
   Comparison against gl_pivot cells.
--------------------------------------------------------------------------- */

export interface MonthDiff {
  key: string;
  qb: number;
  gl: number;
  diff: number;
}

export type ReconStatus = "tied" | "variance" | "qb_only" | "gl_only";

/** Display names for each status — shared by the page and the Excel export. */
export const RECON_STATUS_LABELS: Record<ReconStatus, string> = {
  tied: "Tied",
  variance: "Variance",
  qb_only: "Missing from GL",
  gl_only: "Not in export",
};

export interface AccountRecon {
  account: string;
  status: ReconStatus;
  qbTotal: number;
  glTotal: number;
  diff: number;
  /** Months where the two sides disagree (empty when tied). */
  monthDiffs: MonthDiff[];
}

export interface ReconSection {
  label: string;
  rows: AccountRecon[];
  qbTotal: number;
  glTotal: number;
  diff: number;
}

export interface ReconEliminationLine {
  label: string;
  cells: Record<string, number>;
  /** Signed effect on GL net income: negative backs the revenue out. */
  total: number;
}

export interface ReconciliationResult {
  period: { start: string; end: string };
  columns: PlColumn[];
  sections: ReconSection[];
  netIncome: {
    qb: number;
    gl: number;
    diff: number;
    monthDiffs: MonthDiff[];
  };
  /** Intercompany eliminations applied to the GL side — the same
      adjustment the Financials and Income Statement pages show. Null when
      no intercompany revenue falls in the period. A consolidated QuickBooks
      report that nets out intercompany activity ties to the
      after-eliminations net income, not the raw one; the eliminated revenue
      itself surfaces at account level as "Not in export" / variance rows. */
  eliminations: {
    lines: ReconEliminationLine[];
    netIncome: { qb: number; gl: number; diff: number; monthDiffs: MonthDiff[] };
  } | null;
  summary: {
    tied: number;
    variance: number;
    qbOnly: number;
    glOnly: number;
  };
  warnings: string[];
}

/** Whether a section's accounts add to or subtract from net income. */
const sectionSign = (label: string): 1 | -1 => {
  const n = normalize(label);
  return n.includes("income") && !n.includes("expense") ? 1 : -1;
};

// Section for a ledger account that never appears in the export, from its
// QuickBooks account type.
const GL_SECTION_BY_TYPE: Record<string, string> = {
  Income: "Income",
  "Cost of Goods Sold": "Cost of Goods Sold",
  "Other Income": "Other Income",
  "Other Expense": "Other Expenses",
};

const tie = (diff: number): boolean => Math.abs(diff) <= RECONCILE_TOLERANCE;

export function buildReconciliation(
  parsed: ParsedPl,
  glCells: PivotCell[],
  eliminationSlices: RealmRevenueSlice[] = [],
): ReconciliationResult {
  const monthKeys = new Set(parsed.columns.map((c) => c.key));

  // Fold GL cells by account match key. gl_pivot returns one row per
  // (classification, type, account, month); consolidated means realms and
  // duplicate names sum together, mirroring the consolidated QB report.
  interface GlAccount {
    name: string;
    classification: string;
    accountType: string;
    cells: Record<string, number>;
    total: number;
  }
  const glByKey = new Map<string, GlAccount>();
  const glNetByMonth: Record<string, number> = {};
  let glNetTotal = 0;
  for (const c of glCells) {
    if (!monthKeys.has(c.col_key)) continue; // outside the report's columns
    const amount = Number(c.amount);
    const key = accountMatchKey(c.row_key);
    let acct = glByKey.get(key);
    if (!acct) {
      const parts = c.row_key.split(":");
      acct = {
        name: parts[parts.length - 1].trim(),
        classification: c.classification ?? "",
        accountType: c.account_type ?? "",
        cells: {},
        total: 0,
      };
      glByKey.set(key, acct);
    }
    acct.cells[c.col_key] = (acct.cells[c.col_key] ?? 0) + amount;
    acct.total += amount;

    const sign = c.classification === "Revenue" ? 1 : -1;
    glNetByMonth[c.col_key] = (glNetByMonth[c.col_key] ?? 0) + sign * amount;
    glNetTotal += sign * amount;
  }

  const monthDiffsFor = (
    qbCells: Record<string, number>,
    glCellsByMonth: Record<string, number>,
  ): MonthDiff[] => {
    const out: MonthDiff[] = [];
    for (const col of parsed.columns) {
      const qb = qbCells[col.key] ?? 0;
      const gl = glCellsByMonth[col.key] ?? 0;
      const diff = qb - gl;
      if (!tie(diff)) out.push({ key: col.key, qb, gl, diff });
    }
    return out;
  };

  // One recon row per export account, in sheet order, grouped by section.
  const sectionByLabel = new Map<string, ReconSection>();
  const sectionFor = (label: string): ReconSection => {
    let s = sectionByLabel.get(label);
    if (!s) {
      s = { label, rows: [], qbTotal: 0, glTotal: 0, diff: 0 };
      sectionByLabel.set(label, s);
    }
    return s;
  };

  const summary = { tied: 0, variance: 0, qbOnly: 0, glOnly: 0 };
  const matchedGlKeys = new Set<string>();
  for (const row of parsed.rows) {
    const key = accountMatchKey(row.account);
    const gl = glByKey.get(key);
    if (gl) matchedGlKeys.add(key);
    const glTotal = gl?.total ?? 0;
    const diff = row.total - glTotal;
    const monthDiffs = monthDiffsFor(row.cells, gl?.cells ?? {});
    const status: ReconStatus = !gl
      ? "qb_only"
      : monthDiffs.length === 0
        ? "tied"
        : "variance";
    if (status === "tied") summary.tied++;
    else if (status === "variance") summary.variance++;
    else summary.qbOnly++;

    const section = sectionFor(row.section);
    section.rows.push({
      account: row.account,
      status,
      qbTotal: row.total,
      glTotal,
      diff,
      monthDiffs,
    });
    section.qbTotal += row.total;
    section.glTotal += glTotal;
    section.diff += diff;
  }

  // Ledger accounts with activity in the period that the export never
  // mentions — the other direction of "doesn't tie".
  const glOnly = [...glByKey.entries()]
    .filter(
      ([key, acct]) =>
        !matchedGlKeys.has(key) && !tie(acct.total),
    )
    .sort((a, b) => Math.abs(b[1].total) - Math.abs(a[1].total));
  for (const [, acct] of glOnly) {
    summary.glOnly++;
    const label =
      GL_SECTION_BY_TYPE[acct.accountType] ??
      (acct.classification === "Revenue" ? "Income" : "Expenses");
    const section = sectionFor(label);
    section.rows.push({
      account: acct.name,
      status: "gl_only",
      qbTotal: 0,
      glTotal: acct.total,
      diff: -acct.total,
      monthDiffs: monthDiffsFor({}, acct.cells),
    });
    section.glTotal += acct.total;
    section.diff -= acct.total;
  }

  // Net income both ways: QB from its account rows (signed by section), GL
  // from Revenue − Expense. The export's own Net Income row cross-checks the
  // parse itself.
  const qbNetByMonth: Record<string, number> = {};
  let qbNetTotal = 0;
  for (const row of parsed.rows) {
    const sign = sectionSign(row.section);
    for (const [k, v] of Object.entries(row.cells)) {
      qbNetByMonth[k] = (qbNetByMonth[k] ?? 0) + sign * v;
    }
    qbNetTotal += sign * row.total;
  }

  // Intercompany eliminations, same rules as the Financials and Income
  // Statement pages (buildEliminations): revenue Superior Marine bills as
  // agent for its sister companies is recognized on two companies' books, so
  // the raw GL net income is overstated against a consolidated report that
  // nets it out. Slices outside the report's columns are trimmed first so
  // the adjustment covers exactly the reconciled period.
  const slicesInPeriod = eliminationSlices.map((s) => ({
    ...s,
    cells: s.cells.filter((c) => monthKeys.has(c.col_key)),
  }));
  const rawElims = buildEliminations(slicesInPeriod, {
    bycol: new Map(Object.entries(glNetByMonth)),
    total: glNetTotal,
  });
  const eliminations: ReconciliationResult["eliminations"] = rawElims
    ? {
        lines: rawElims.lines.map((l) => ({
          label: l.label,
          cells: Object.fromEntries(l.totals.bycol),
          total: l.totals.total,
        })),
        netIncome: {
          qb: qbNetTotal,
          gl: rawElims.adjusted.total,
          diff: qbNetTotal - rawElims.adjusted.total,
          monthDiffs: monthDiffsFor(
            qbNetByMonth,
            Object.fromEntries(rawElims.adjusted.bycol),
          ),
        },
      }
    : null;

  const warnings = [...parsed.warnings];
  if (
    parsed.reportedNetIncome &&
    !tie(parsed.reportedNetIncome.total - qbNetTotal)
  ) {
    warnings.push(
      "The export's Net Income row doesn't equal the sum of its account rows — some rows may not have parsed. Treat account-level results with care.",
    );
  }

  return {
    period: { start: parsed.start, end: parsed.end },
    columns: parsed.columns,
    sections: [...sectionByLabel.values()],
    netIncome: {
      qb: qbNetTotal,
      gl: glNetTotal,
      diff: qbNetTotal - glNetTotal,
      monthDiffs: monthDiffsFor(qbNetByMonth, glNetByMonth),
    },
    eliminations,
    summary,
    warnings,
  };
}
