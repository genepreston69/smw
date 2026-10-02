import type ExcelJS from "exceljs";
import {
  INITIATIVE_STATUS_LABEL,
  MONTH_NAMES,
  initiativeMonthCount,
  initiativePeriodLabel,
  spreadInitiativeLine,
  type BudgetInitiative,
  type InitiativeStatus,
} from "@/lib/budget";

// Initiatives by month, as an Excel sheet. Shared by the initiatives export
// (/api/export/budget-initiatives — one initiative or every initiative in
// view) and the budget workbook (/api/export/budget), so both spread exactly
// as the budget does (spreadInitiativeLine).

const MONEY = "#,##0.00";
const GREY = { argb: "FF6B7785" };
const STATUS_ORDER: InitiativeStatus[] = ["approved", "proposed", "rejected"];

/** Approved first, then proposed, then rejected; creation order within each. */
export const sortInitiativesForExport = (initiatives: readonly BudgetInitiative[]) =>
  [...initiatives].sort(
    (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status),
  );

/**
 * Writes initiatives onto `sheet` with one column per budget month (Jan–Dec)
 * plus Total. Each initiative is a block — its company, status, and run, then
 * its revenue and expense accounts (grouped outline rows), section totals,
 * and Net — with months outside its run left blank. With `summary`, an
 * "In budget" block first totals the approved initiatives by month: exactly
 * what the initiatives add to the budget statement.
 */
export function writeInitiativesByMonth(
  sheet: ExcelJS.Worksheet,
  initiatives: readonly BudgetInitiative[],
  opts: {
    year: number;
    title: string;
    companyName: (realmId: string) => string;
    summary: boolean;
  },
) {
  const { year } = opts;
  sheet.properties.outlineProperties = { summaryBelow: false, summaryRight: false };
  sheet.addRow([opts.title]).font = { bold: true, size: 13 };
  sheet.addRow([
    "Each account's amount is spread evenly over the initiative's months (start through end); months outside that run are blank. Only approved initiatives are included in the budget.",
  ]);
  sheet.addRow([]);
  sheet.addRow([
    "Initiative / account",
    ...MONTH_NAMES.map((m) => `${m} ${year}`),
    "Total",
  ]).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 4, xSplit: 1 }];
  sheet.getColumn(1).width = 46;
  for (let c = 2; c <= 14; c++) {
    sheet.getColumn(c).width = c === 14 ? 15 : 13;
    sheet.getColumn(c).numFmt = MONEY;
  }

  // One row: label, then twelve months (null = blank) and their total.
  const addAmounts = (
    label: string,
    months: (number | null)[],
    style: { bold?: boolean; indent?: number; outline?: boolean } = {},
  ) => {
    const total = months.reduce<number>((n, v) => n + (v ?? 0), 0);
    const row = sheet.addRow([label, ...months, total]);
    if (style.bold) row.font = { bold: true };
    if (style.indent) row.getCell(1).alignment = { indent: style.indent };
    if (style.outline) row.outlineLevel = 1;
    return row;
  };
  const sum = (rows: number[][]) =>
    Array.from({ length: 12 }, (_, m) => rows.reduce((n, r) => n + r[m], 0));
  const inRun = (i: BudgetInitiative, months: number[]) =>
    months.map((v, m) => (m + 1 >= i.start_month && m + 1 <= i.end_month ? v : null));

  if (opts.summary) {
    const approved = initiatives.filter((i) => i.status === "approved");
    const spread = (cls: "Revenue" | "Expense") =>
      sum(
        approved.flatMap((i) =>
          i.lines
            .filter((l) => l.classification === cls)
            .map((l) => spreadInitiativeLine(i, l.annual_amount)),
        ),
      );
    const revenue = spread("Revenue");
    const expense = spread("Expense");
    sheet.addRow([
      `In budget — ${approved.length} approved initiative${approved.length === 1 ? "" : "s"}`,
    ]).font = { bold: true, size: 12 };
    addAmounts("Revenue", revenue, { indent: 1 });
    addAmounts("Expense", expense, { indent: 1 });
    addAmounts(
      "Net",
      revenue.map((v, m) => v - expense[m]),
      { bold: true, indent: 1 },
    );
    sheet.addRow([]);
  }

  for (const i of sortInitiativesForExport(initiatives)) {
    sheet.addRow([i.name]).font = { bold: true, size: 12 };
    const months = initiativeMonthCount(i);
    const meta = [
      opts.companyName(i.realm_id),
      INITIATIVE_STATUS_LABEL[i.status],
      `${initiativePeriodLabel(i, year)} (${months} month${months === 1 ? "" : "s"})`,
      i.status === "approved" && i.approved_by_name ? `Approved by ${i.approved_by_name}` : "",
    ];
    sheet.addRow([meta.filter(Boolean).join(" · ")]).font = { italic: true, color: GREY };
    if (i.description) sheet.addRow([i.description]).font = { color: GREY };

    const section = (cls: "Revenue" | "Expense"): number[] => {
      const lines = i.lines.filter((l) => l.classification === cls);
      if (lines.length === 0) return Array(12).fill(0);
      sheet.addRow([cls]).font = { bold: true };
      const spreads = lines.map((l) => spreadInitiativeLine(i, l.annual_amount));
      lines.forEach((l, idx) =>
        addAmounts(l.account_name, inRun(i, spreads[idx]), { indent: 2, outline: true }),
      );
      const total = sum(spreads);
      addAmounts(`Total ${cls.toLowerCase()}`, inRun(i, total), { bold: true });
      return total;
    };
    const revenue = section("Revenue");
    const expense = section("Expense");
    addAmounts(
      "Net",
      inRun(i, revenue.map((v, m) => v - expense[m])),
      { bold: true },
    );
    sheet.addRow([]);
  }
  if (initiatives.length === 0) sheet.addRow(["No initiatives yet"]);
}
