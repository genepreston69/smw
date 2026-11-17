// Balance Sheet: the pure half. Parsing QuickBooks' BalanceSheet report into a
// tree, laying several companies' trees side by side, and the calendar rules
// for which month is shown and when it rolls over.
//
// The Balance Sheet is NOT rebuilt from the imported ledger. gl_lines starts
// at the import window and carries no opening balances, so a balance summed
// from it would be wrong by everything posted before the window. Instead each
// company's own BalanceSheet report is pulled from QuickBooks as of a month
// end and stored as a snapshot (public.balance_sheet_snapshots, migration
// 0043) — it ties to QuickBooks because it is QuickBooks' own report.

/** One line of a balance sheet: an account, or a section with lines under it. */
export interface BsNode {
  label: string;
  /** QuickBooks account id, when the line is an account. */
  id: string | null;
  /** QuickBooks' own name for a standard section ("TotalAssets", "Equity"…). */
  group: string | null;
  /** The line's own balance: an account's, or a parent account's direct
      postings. Null on a pure section heading. */
  own: number | null;
  /** The section's total as QuickBooks printed it. Null on a plain account. */
  total: number | null;
  /** "Total Current Assets" — the label QuickBooks printed beside the total. */
  totalLabel: string | null;
  children: BsNode[];
}

export interface ParsedBalanceSheet {
  nodes: BsNode[];
  /** Number of account lines in the report. */
  accounts: number;
  totalAssets: number;
  totalLiabilitiesAndEquity: number;
}

// The shape of a QuickBooks report, as far as this parser reads it.
interface ReportCol {
  value?: string;
  id?: string;
}
export interface BsReportRow {
  type?: string;
  group?: string;
  ColData?: ReportCol[];
  Header?: { ColData?: ReportCol[] };
  Summary?: { ColData?: ReportCol[] };
  Rows?: { Row?: BsReportRow[] };
}
export interface BsReport {
  Header?: { EndPeriod?: string; ReportName?: string };
  Rows?: { Row?: BsReportRow[] };
}

const amountOf = (col: ReportCol | undefined): number | null => {
  const text = col?.value?.trim();
  if (!text) return null;
  const n = Number.parseFloat(text.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

const cents = (n: number) => Math.round(n * 100) / 100;

/** The amount a line contributes: a section's total, else its own balance. */
export const nodeValue = (n: Pick<BsNode, "own" | "total">): number =>
  n.total ?? n.own ?? 0;

function parseRow(row: BsReportRow): BsNode | null {
  const children = (row.Rows?.Row ?? [])
    .map(parseRow)
    .filter((n): n is BsNode => n !== null);
  const head = row.Header?.ColData;
  const summary = row.Summary?.ColData;

  if (head || summary || children.length > 0) {
    const label = head?.[0]?.value?.trim() || summary?.[0]?.value?.trim() || "";
    if (!label) return null;
    return {
      label,
      id: head?.[0]?.id ?? null,
      group: row.group ?? null,
      // A parent account with postings of its own carries them on its header.
      own: head ? amountOf(head[1]) : null,
      total: amountOf(summary?.[1]),
      totalLabel: summary?.[0]?.value?.trim() || null,
      children,
    };
  }

  const label = row.ColData?.[0]?.value?.trim();
  if (!label) return null;
  return {
    label,
    id: row.ColData?.[0]?.id ?? null,
    group: row.group ?? null,
    own: amountOf(row.ColData?.[1]) ?? 0,
    total: null,
    totalLabel: null,
    children: [],
  };
}

const countAccounts = (nodes: BsNode[]): number =>
  nodes.reduce(
    (n, node) =>
      n + (node.children.length === 0 ? 1 : countAccounts(node.children)),
    0,
  );

/** The first line, at any depth, that is one of QuickBooks' named sections. */
export function findSection<T extends { group: string | null; label: string; children: T[] }>(
  nodes: T[],
  group: string,
  label: RegExp,
): T | null {
  for (const node of nodes) {
    if (node.group === group || label.test(node.label)) return node;
    const inner = findSection(node.children, group, label);
    if (inner) return inner;
  }
  return null;
}

export const SECTIONS = {
  assets: { group: "TotalAssets", label: /^(total )?assets$/i },
  liabilitiesAndEquity: {
    group: "TotalLiabilitiesAndEquity",
    label: /^(total )?liabilities (and|&) equity$/i,
  },
  liabilities: { group: "Liabilities", label: /^(total )?liabilities$/i },
  equity: { group: "Equity", label: /^(total )?equity$/i },
} as const;

/**
 * QuickBooks' BalanceSheet report as a tree, checked before anything is
 * stored: the report must be for the date asked for, must have both halves,
 * and the halves must agree to the cent. A report that fails is a parsing
 * surprise or a cut-off response — either way it must not replace a good
 * snapshot, so this throws.
 */
export function parseBalanceSheetReport(
  report: BsReport,
  asOf: string,
): ParsedBalanceSheet {
  const end = report.Header?.EndPeriod;
  if (end && end !== asOf) {
    throw new Error(
      `QuickBooks returned a balance sheet as of ${end}, not the ${asOf} that was asked for`,
    );
  }
  const nodes = (report.Rows?.Row ?? [])
    .map(parseRow)
    .filter((n): n is BsNode => n !== null);
  // A company with nothing posted yet has an empty report.
  if (nodes.length === 0) {
    return { nodes, accounts: 0, totalAssets: 0, totalLiabilitiesAndEquity: 0 };
  }

  const assets = findSection(nodes, SECTIONS.assets.group, SECTIONS.assets.label);
  const liabEquity = findSection(
    nodes,
    SECTIONS.liabilitiesAndEquity.group,
    SECTIONS.liabilitiesAndEquity.label,
  );
  if (!assets || !liabEquity) {
    throw new Error(
      `QuickBooks' balance sheet is not in the expected layout (sections found: ${
        nodes.map((n) => n.label).join(", ") || "none"
      })`,
    );
  }
  const totalAssets = cents(nodeValue(assets));
  const totalLiabilitiesAndEquity = cents(nodeValue(liabEquity));
  if (Math.abs(totalAssets - totalLiabilitiesAndEquity) > 0.01) {
    throw new Error(
      `QuickBooks' balance sheet does not balance as read: assets ${totalAssets.toFixed(2)}, liabilities and equity ${totalLiabilitiesAndEquity.toFixed(2)}`,
    );
  }
  return {
    nodes,
    accounts: countAccounts(nodes),
    totalAssets,
    totalLiabilitiesAndEquity,
  };
}

// ---------------------------------------------------------------------------
// Several companies side by side
// ---------------------------------------------------------------------------

/** A line with one amount per company column. */
export interface BsLine {
  label: string;
  group: string | null;
  /** Own balances by column key; empty on a pure section heading. */
  own: Record<string, number>;
  /** Section totals by column key; empty on a plain account. */
  total: Record<string, number>;
  totalLabel: string | null;
  children: BsLine[];
}

const lineKey = (label: string) => label.trim().toLowerCase();

function mergeInto(target: BsLine[], nodes: BsNode[], col: string) {
  // A line this company has and earlier ones lack goes right after the last
  // line they share, so each company's own order survives the merge.
  let at = -1;
  for (const node of nodes) {
    let i = target.findIndex((l) => lineKey(l.label) === lineKey(node.label));
    if (i === -1) {
      i = at + 1;
      target.splice(i, 0, {
        label: node.label,
        group: node.group,
        own: {},
        total: {},
        totalLabel: node.totalLabel,
        children: [],
      });
    }
    const line = target[i];
    line.group ??= node.group;
    line.totalLabel ??= node.totalLabel;
    if (node.own !== null) line.own[col] = cents((line.own[col] ?? 0) + node.own);
    if (node.total !== null) {
      line.total[col] = cents((line.total[col] ?? 0) + node.total);
    }
    mergeInto(line.children, node.children, col);
    at = i;
  }
}

/** Column key of the all-companies column. */
export const COMBINED = "combined";

function addCombined(lines: BsLine[], cols: string[]) {
  const sum = (by: Record<string, number>) => {
    const present = cols.filter((c) => by[c] !== undefined);
    if (present.length > 0) {
      by[COMBINED] = cents(present.reduce((s, c) => s + by[c], 0));
    }
  };
  for (const line of lines) {
    // A line that is a section in one company and a plain account in another
    // must still add up across the row, so its total covers both.
    if (line.children.length > 0) {
      for (const c of cols) {
        if (line.total[c] === undefined && line.own[c] !== undefined) {
          line.total[c] = line.own[c];
        }
      }
    }
    sum(line.own);
    sum(line.total);
    addCombined(line.children, cols);
  }
}

/**
 * Each company's balance sheet as a column, lines matched by name within
 * their section. With more than one company a Combined column adds them up —
 * a plain sum, with no intercompany eliminations, like every other report
 * here.
 */
export function mergeBalanceSheets(
  sheets: { key: string; nodes: BsNode[] }[],
): BsLine[] {
  const lines: BsLine[] = [];
  for (const s of sheets) mergeInto(lines, s.nodes, s.key);
  if (sheets.length > 1) addCombined(lines, sheets.map((s) => s.key));
  return lines;
}

/** A line's amounts for display: a section's totals, else its own balances. */
export const lineAmounts = (line: BsLine): Record<string, number> =>
  line.children.length > 0 ? line.total : line.own;

/** One printed row of the statement, for the table and the Excel export. */
export interface BsRow {
  /** Stable path of labels, for React keys and collapse state. */
  path: string;
  label: string;
  depth: number;
  kind: "section" | "account" | "total";
  amounts: Record<string, number>;
}

/** The statement top to bottom: heading, lines, then "Total …" per section. */
export function flattenBalanceSheet(lines: BsLine[], depth = 0, parent = ""): BsRow[] {
  const rows: BsRow[] = [];
  for (const line of lines) {
    const path = `${parent}/${lineKey(line.label)}`;
    if (line.children.length === 0) {
      rows.push({ path, label: line.label, depth, kind: "account", amounts: line.own });
      continue;
    }
    rows.push({ path, label: line.label, depth, kind: "section", amounts: line.own });
    rows.push(...flattenBalanceSheet(line.children, depth + 1, path));
    rows.push({
      path: `${path}#total`,
      label: line.totalLabel ?? `Total ${line.label}`,
      depth,
      kind: "total",
      amounts: line.total,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Which month, and when it rolls over
// ---------------------------------------------------------------------------

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** The last day of the month before `localDate` (a `YYYY-MM-DD`). */
export function priorMonthEnd(localDate: string): string {
  const [y, m] = localDate.split("-").map(Number);
  return iso(new Date(Date.UTC(y, m - 1, 0)));
}

/** True for a real calendar month end, `YYYY-MM-DD`. */
export function isMonthEnd(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || iso(d) !== date) return false;
  return new Date(d.getTime() + 86_400_000).getUTCDate() === 1;
}

/** Hours after midnight on the 1st in which a tick may still start the
    month-end pull, so one missed tick doesn't cost the rollover. */
export const MONTH_END_WINDOW_HOURS = 3;

/**
 * True in the first hours of the 1st, local time: the month just ended at
 * midnight, so the Balance Sheet moves on to it.
 */
export function isMonthRollover(clock: { date: string; hour: number }): boolean {
  return clock.date.endsWith("-01") && clock.hour < MONTH_END_WINDOW_HOURS;
}

/** "October 31, 2026" */
export function asOfLabel(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * The period a page view shows: `?asOf=` when it is a real month end no later
 * than the prior month, otherwise the prior month.
 */
export function balanceSheetAsOf(
  param: string | null | undefined,
  localDate: string,
): string {
  const latest = priorMonthEnd(localDate);
  return param && isMonthEnd(param) && param <= latest ? param : latest;
}
