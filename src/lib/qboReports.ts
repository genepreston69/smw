// QuickBooks Online Reports API: the shared report shape, the cell-limit
// truncation rule, and the BalanceSheet report parser. Plain functions with
// no server-only imports, so the parsers can be exercised outside Next.js;
// src/lib/quickbooks.ts does the fetching and storing.

export interface QboReportColData {
  value?: string;
  id?: string;
}

export interface QboReportRow {
  type?: string; // "Section" | "Data"
  group?: string; // QuickBooks' own section name, e.g. "TotalAssets", "Equity"
  ColData?: QboReportColData[];
  Header?: { ColData?: QboReportColData[] };
  Summary?: { ColData?: QboReportColData[] };
  Rows?: { Row?: QboReportRow[] };
}

export interface QboReport {
  Header?: { Option?: { Name?: string; Value?: string }[] };
  Columns?: {
    Column?: {
      ColTitle?: string;
      ColType?: string;
      MetaData?: { Name?: string; Value?: string }[];
    }[];
  };
  Rows?: { Row?: QboReportRow[] };
}

// The Reports API caps a response at 400,000 cells and, past that, does not
// fail: the report just stops, ending with an "Unable to display more data.
// Please reduce the date range." row. The GeneralLedger report lists accounts
// in chart order — balance sheet, income, cost of goods sold, expenses, then
// other income / other expense — so a cut-off window silently loses the
// accounts at the end (interest expense among them). A report that carries
// the notice, or that comes close enough to the cap that it may have been
// cut without one, counts as truncated.
export const REPORT_CELL_LIMIT = 400_000;
export const REPORT_TRUNCATED_CELLS = REPORT_CELL_LIMIT * 0.95;
const REPORT_TRUNCATED_TEXT = "unable to display more data";

export const mentionsTruncation = (text: string | undefined) =>
  !!text && text.toLowerCase().includes(REPORT_TRUNCATED_TEXT);

// ---------------------------------------------------------------------------
// BalanceSheet report, summarized by month
// ---------------------------------------------------------------------------

export type BalanceSection = "Asset" | "Liability" | "Equity";

export interface ReportBalance {
  /** First day of the month; the amount is the balance at its last day. */
  month: string;
  /** QuickBooks account id, or `row:<label>` for a line QuickBooks computes
      rather than posts to (Net Income). */
  accountKey: string;
  accountQbId: string | null;
  accountName: string;
  /** Where the report placed the line; null if no enclosing section said. */
  section: BalanceSection | null;
  /** Natural signed, rounded to the cent; never zero. */
  amount: number;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "YYYY-MM" a report column reports the month-end balance of, or null for
    the label column (and any total column). Prefers the column's EndDate
    metadata; falls back to a title ending in a month and year ("Jan 2025",
    "Jan 31, 2025"). */
function columnMonth(column: {
  ColTitle?: string;
  ColType?: string;
  MetaData?: { Name?: string; Value?: string }[];
}): string | null {
  if (column.ColType === "Account") return null;
  const colKey = column.MetaData?.find((m) => m.Name === "ColKey")?.Value;
  if (/^total$/i.test(colKey ?? "") || /^total$/i.test(column.ColTitle?.trim() ?? "")) {
    return null;
  }
  const end = column.MetaData?.find((m) => m.Name === "EndDate")?.Value;
  if (end && /^\d{4}-\d{2}-\d{2}$/.test(end)) return end.slice(0, 7);
  const title = /([A-Za-z]{3})[A-Za-z]*\.?(?:\s+\d{1,2})?,?\s+(\d{4})\s*$/.exec(
    column.ColTitle?.trim() ?? "",
  );
  if (!title) return null;
  const m = MONTHS.indexOf(title[1].toLowerCase());
  return m === -1 ? null : `${title[2]}-${String(m + 1).padStart(2, "0")}`;
}

/** The statement section a report section stands for, from QuickBooks' group
    name and header label ("TotalAssets"/"ASSETS", "Liabilities", "Equity").
    Null when it names none, or both ("LIABILITIES AND EQUITY"), so the
    nearest enclosing section that does name one wins. */
function sectionOf(group: string | undefined, label: string | undefined): BalanceSection | null {
  const s = `${group ?? ""} ${label ?? ""}`.toLowerCase();
  const asset = s.includes("asset");
  const liability = s.includes("liabilit");
  const equity = s.includes("equity");
  if (liability && !equity && !asset) return "Liability";
  if (equity && !liability && !asset) return "Equity";
  if (asset && !liability && !equity) return "Asset";
  return null;
}

/** A report amount: "" means zero; tolerates thousands separators and
    parenthesized negatives. */
function amountOf(value: string | undefined): number {
  let t = (value ?? "").replace(/[,$\s]/g, "");
  if (!t) return 0;
  let sign = 1;
  if (/^\(.*\)$/.test(t)) {
    sign = -1;
    t = t.slice(1, -1);
  }
  const n = Number(t);
  return Number.isFinite(n) ? sign * n : 0;
}

const cents = (v: number) => Math.round(v * 100) / 100;

/**
 * Every account's month-end balance from a BalanceSheet report requested with
 * summarize_column_by=Month for exactly `months` ("YYYY-MM", ascending).
 *
 * The report nests sections — ASSETS › Current Assets › Bank Accounts — down
 * to Data rows, one per account. A parent account with sub-accounts is
 * itself a section whose header carries the account id; its own balance
 * (separate from its subs) is its "Total for …" summary less its children,
 * which holds however QuickBooks lays the parent out (amount on the header,
 * a Data row of its own, or neither). A header without an id whose summary
 * still exceeds its children is kept under the header's label, so every
 * total the report shows is accounted for. Net Income is a Data row with no
 * account id: QuickBooks computes it, and it is kept as `row:Net Income`.
 *
 * Throws when the columns aren't the months asked for — storing a report
 * that's laid out differently than expected would replace good balances with
 * wrong ones. `truncated` means rows were cut at the cell limit and the
 * months must be re-fetched in smaller pieces.
 */
export function parseBalanceSheetReport(
  report: QboReport,
  months: string[],
): { balances: ReportBalance[]; truncated: boolean } {
  const columns = report.Columns?.Column ?? [];
  const monthCols: { index: number; month: string }[] = [];
  columns.forEach((c, index) => {
    const month = columnMonth(c);
    if (month) monthCols.push({ index, month });
  });
  const found = monthCols.map((c) => c.month);
  if (found.length !== months.length || found.some((m, i) => m !== months[i])) {
    throw new Error(
      `QuickBooks BalanceSheet report columns (${found.join(", ") || "none"}) don't match the months requested (${months[0]}..${months[months.length - 1]})`,
    );
  }

  const zeros = () => monthCols.map(() => 0);
  const values = (cols: QboReportColData[] | undefined): number[] =>
    monthCols.map((c) => amountOf(cols?.[c.index]?.value));

  const byAccount = new Map<
    string,
    { qbId: string | null; name: string; section: BalanceSection | null; amounts: number[] }
  >();
  const add = (
    qbId: string | null,
    name: string,
    section: BalanceSection | null,
    amounts: number[],
  ) => {
    const key = qbId ? qbId : `row:${name}`;
    const entry = byAccount.get(key) ?? { qbId, name, section, amounts: zeros() };
    byAccount.set(key, entry);
    amounts.forEach((v, i) => (entry.amounts[i] += v));
  };

  let cells = 0;
  let truncated = (report.Header?.Option ?? []).some(
    (o) => mentionsTruncation(o.Name) || mentionsTruncation(o.Value),
  );
  const noticeIn = (cols: QboReportColData[] | undefined) =>
    !!cols?.some((c) => mentionsTruncation(c.value));

  // Returns the per-month total of `rows`, recording every account on the way.
  const walk = (rows: QboReportRow[], section: BalanceSection | null): number[] => {
    const total = zeros();
    const plus = (v: number[]) => v.forEach((x, i) => (total[i] += x));
    for (const row of rows) {
      cells +=
        (row.ColData?.length ?? 0) +
        (row.Header?.ColData?.length ?? 0) +
        (row.Summary?.ColData?.length ?? 0);
      if (noticeIn(row.Header?.ColData) || noticeIn(row.Summary?.ColData)) truncated = true;

      if (row.Rows || row.Header || row.Summary || row.type === "Section") {
        const head = row.Header?.ColData?.[0];
        const label = head?.value?.trim() ?? "";
        const accountId = head?.id?.trim() || null;
        const inner = accountId ? section : (sectionOf(row.group, label) ?? section);
        const children = walk(row.Rows?.Row ?? [], inner);
        const summary = row.Summary?.ColData ? values(row.Summary.ColData) : null;
        const own = summary
          ? summary.map((v, i) => v - children[i])
          : accountId
            ? values(row.Header?.ColData)
            : zeros();
        if (own.some((v) => cents(v) !== 0)) {
          if (accountId) add(accountId, label, inner, own);
          else if (label) add(null, label, inner, own);
        }
        plus(summary ?? children.map((v, i) => v + own[i]));
        continue;
      }

      if (noticeIn(row.ColData)) {
        truncated = true;
        continue;
      }
      const first = row.ColData?.[0];
      const label = first?.value?.trim();
      if (!label) continue;
      const amounts = values(row.ColData);
      add(first?.id?.trim() || null, label, section, amounts);
      plus(amounts);
    }
    return total;
  };
  walk(report.Rows?.Row ?? [], null);

  const balances: ReportBalance[] = [];
  for (const [accountKey, a] of byAccount) {
    a.amounts.forEach((v, i) => {
      const amount = cents(v);
      if (amount === 0) return;
      balances.push({
        month: `${monthCols[i].month}-01`,
        accountKey,
        accountQbId: a.qbId,
        accountName: a.name,
        section: a.section,
        amount,
      });
    });
  }
  return { balances, truncated: truncated || cells >= REPORT_TRUNCATED_CELLS };
}
