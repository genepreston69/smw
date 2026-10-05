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

import type { PivotCell } from "@/lib/financials";

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
  /** QuickBooks statement section: Income, Cost of Goods Sold, Expenses,
      Other Income, Other Expenses. */
  section: string;
  /** Account path as the export nests it — parent accounts, then the detail
      account itself — the same shape as gl_accounts.fully_qualified_name. */
  path: string[];
  /** Display form of path ("Parent:Sub"). */
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

// QuickBooks' own statement sections. They open a fresh section even when the
// previous one had no "Total for …" row to close it.
const SECTION_LABELS = new Set([
  "income",
  "cost of goods sold",
  "cost of sales",
  "expenses",
  "expense",
  "other income",
  "other expenses",
  "other expense",
]);

// Subtotal/derived rows a P&L export interleaves with its account rows.
const COMPUTED_ROW_LABELS = new Set([
  "gross profit",
  "net operating income",
  "net ordinary income",
  "net other income",
  "net income",
  "net earnings",
]);

const normalize = (s: string): string =>
  s.toLowerCase().replace(/\s+/g, " ").trim();

/** Match key for one detail account: its full "Parent:Sub" path, each
    segment normalized. gl_pivot keys ledger accounts by
    gl_accounts.fully_qualified_name, and the parser rebuilds the same path
    from the export's parent-account groups. */
export const accountMatchKey = (path: string | string[]): string =>
  (typeof path === "string" ? path.split(":") : path)
    .map((seg) => normalize(seg))
    .join(":");

/** The detail account's own name (last path segment), normalized — the
    fallback match when a path can't be lined up. */
const leafMatchKey = (path: string | string[]): string => {
  const parts = typeof path === "string" ? path.split(":") : path;
  return normalize(parts[parts.length - 1]);
};

/** "Total for X" / "Total X" → the normalized X it closes, else null. */
const totalTarget = (norm: string): string | null => {
  const m = /^total\s+(?:for\s+)?(.+)$/.exec(norm);
  return m ? m[1] : null;
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

  // Every account row is reconciled on its own — the detail account, never
  // a rollup. QuickBooks nests a parent account's sub-accounts between a
  // label-only header row and a "Total for <parent>" row, inside the same
  // header/total pair for each statement section. A stack of the open groups
  // rebuilds each row's full path: stack[0] is the section, the rest are
  // parent accounts. A label-only row only opens a group when a matching
  // total closes it later; otherwise it's an account with no amounts in
  // these months and is skipped (so it can't swallow its siblings).
  const totalTargets = new Set<string>();
  for (let r = headerRowIdx + 1; r < grid.length; r++) {
    const label = grid[r]?.[0];
    if (typeof label !== "string") continue;
    const target = totalTarget(normalize(label));
    if (target) totalTargets.add(target);
  }

  const rowByKey = new Map<string, ParsedPlRow>();
  const order: string[] = [];
  let reportedNetIncome: ParsedPl["reportedNetIncome"] = null;
  let stack: string[] = [];
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
    if (COMPUTED_ROW_LABELS.has(norm)) continue;

    // A total closes its group (and anything left open inside it).
    const target = totalTarget(norm);
    if (target !== null) {
      const idx = stack.findLastIndex((g) => normalize(g) === target);
      if (idx >= 0) {
        stack = stack.slice(0, idx);
        continue;
      }
      if (norm.startsWith("total for ")) continue;
    }

    if (!hasAmount) {
      if (SECTION_LABELS.has(norm) || stack.length === 0) stack = [label];
      else if (totalTargets.has(norm)) stack.push(label);
      continue;
    }

    const section = stack[0] ?? "Income";
    const parents = stack.slice(1);
    // A parent account's own postings appear inside its group under the
    // parent's own name — that row is the parent account itself.
    const path =
      parents.length > 0 && normalize(parents[parents.length - 1]) === norm
        ? parents
        : [...parents, label];
    const key = accountMatchKey(path);
    const existing = rowByKey.get(key);
    if (existing) {
      for (const [k, v] of Object.entries(cells)) {
        existing.cells[k] = (existing.cells[k] ?? 0) + v;
      }
      existing.total += total;
    } else {
      rowByKey.set(key, { section, path, account: path.join(":"), cells, total });
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
): ReconciliationResult {
  const monthKeys = new Set(parsed.columns.map((c) => c.key));

  // Fold GL cells by detail account: gl_pivot's account row key is the
  // account's fully qualified name ("Parent:Sub"), one row per
  // (classification, type, account, month). The app's own Chart of Accounts
  // categories never enter the rec. Consolidated means realms sharing an
  // account path sum together, mirroring the consolidated QB report.
  interface GlAccount {
    /** Fully qualified name, as posted. */
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
      acct = {
        name: c.row_key.trim(),
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

  // Line each export account up with one ledger account. First by full path
  // — the detail account under the same parents. Then, for anything left, by
  // the account's own name, but only when that name is unique among the
  // unmatched accounts on both sides, so two different accounts can never be
  // netted into one line (e.g. when an export prints a parent's own postings
  // ahead of its sub-accounts instead of inside the group).
  const glKeyForRow = new Map<ParsedPlRow, string>();
  const matchedGlKeys = new Set<string>();
  for (const row of parsed.rows) {
    const key = accountMatchKey(row.path);
    if (glByKey.has(key)) {
      glKeyForRow.set(row, key);
      matchedGlKeys.add(key);
    }
  }
  const countBy = <T>(items: T[], keyOf: (item: T) => string) => {
    const out = new Map<string, T[]>();
    for (const item of items) {
      const k = keyOf(item);
      out.set(k, [...(out.get(k) ?? []), item]);
    }
    return out;
  };
  const qbByLeaf = countBy(
    parsed.rows.filter((r) => !glKeyForRow.has(r)),
    (r) => leafMatchKey(r.path),
  );
  const glByLeaf = countBy(
    [...glByKey.keys()].filter((k) => !matchedGlKeys.has(k)),
    (k) => leafMatchKey(k),
  );
  for (const [leaf, rows] of qbByLeaf) {
    const gls = glByLeaf.get(leaf);
    if (rows.length === 1 && gls?.length === 1) {
      glKeyForRow.set(rows[0], gls[0]);
      matchedGlKeys.add(gls[0]);
    }
  }

  // An export run with sub-accounts collapsed shows a parent as one line
  // while the ledger posts to its sub-accounts — flag it, since only an
  // expanded export can tie account by account.
  const collapsed = new Set<string>();
  for (const row of parsed.rows) {
    const prefix = `${glKeyForRow.get(row) ?? accountMatchKey(row.path)}:`;
    for (const [key, acct] of glByKey)
      if (!matchedGlKeys.has(key) && key.startsWith(prefix) && !tie(acct.total))
        collapsed.add(row.account);
  }

  const summary = { tied: 0, variance: 0, qbOnly: 0, glOnly: 0 };
  for (const row of parsed.rows) {
    const glKey = glKeyForRow.get(row);
    const gl = glKey ? glByKey.get(glKey) : undefined;
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
  // mentions — the other direction of "doesn't tie". Any month off counts,
  // so activity that nets to zero over the period still shows.
  const glOnly = [...glByKey.entries()]
    .filter(
      ([key, acct]) =>
        !matchedGlKeys.has(key) &&
        Object.values(acct.cells).some((v) => !tie(v)),
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

  const warnings = [...parsed.warnings];
  if (collapsed.size > 0) {
    const names = [...collapsed];
    warnings.push(
      `${names.slice(0, 5).map((n) => `"${n}"`).join(", ")}${names.length > 5 ? ` and ${names.length - 5} more` : ""} ${names.length === 1 ? "shows" : "show"} in the export as a single line, but the ledger posts to sub-accounts under ${names.length === 1 ? "it" : "them"}. Run the QuickBooks Profit and Loss with sub-accounts expanded (not collapsed) so every detail account ties on its own.`,
    );
  }
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
    summary,
    warnings,
  };
}
