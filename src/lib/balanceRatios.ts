// Balance sheet ratios: the pure half. Reads the handful of figures the
// ratios need out of a merged balance sheet (src/lib/balanceSheet.ts) and
// turns them into liquidity, leverage and return ratios for the Financial
// Ratios page.
//
// Every figure is QuickBooks' own section total from the stored BalanceSheet
// report — nothing is re-summed from accounts or from the imported ledger —
// so each one can be found on the Balance Sheet page for the same month end.

import { findSection, lineAmounts, SECTIONS, type BsLine } from "@/lib/balanceSheet";

/** The balance sheet figures the ratios are built from, for one column. */
export interface BalanceFigures {
  /** QuickBooks' Bank Accounts section. */
  cash: number;
  /** QuickBooks' Accounts Receivable section. */
  receivables: number;
  currentAssets: number;
  totalAssets: number;
  currentLiabilities: number;
  totalLiabilities: number;
  equity: number;
}

// QuickBooks' names for the sections below the ones the Balance Sheet page
// already reads; the label is the fallback when a report carries no group.
const RATIO_SECTIONS = {
  currentAssets: { group: "CurrentAssets", label: /^(total )?current assets$/i },
  cash: { group: "BankAccounts", label: /^(total )?bank accounts$/i },
  receivables: { group: "AR", label: /^(total )?accounts receivable$/i },
  currentLiabilities: {
    group: "CurrentLiabilities",
    label: /^(total )?current liabilities$/i,
  },
} as const;

type SectionKey = { group: string; label: RegExp };

/**
 * One column's figures (a company's realm id, or COMBINED), or null when the
 * column has no balance sheet. A section QuickBooks left out — a company with
 * no receivables, say — counts as zero.
 */
export function balanceFigures(lines: BsLine[], col: string): BalanceFigures | null {
  const section = (within: BsLine[], s: SectionKey) =>
    findSection(within, s.group, s.label);
  const amount = (line: BsLine | null) => (line ? (lineAmounts(line)[col] ?? 0) : 0);

  const assets = section(lines, SECTIONS.assets);
  if (!assets || lineAmounts(assets)[col] === undefined) return null;

  // Cash and receivables are looked for inside Current Assets only, so a
  // long-term line that happens to share a name is never picked up.
  const currentAssets = section(assets.children, RATIO_SECTIONS.currentAssets);
  const within = currentAssets?.children ?? [];
  return {
    cash: amount(section(within, RATIO_SECTIONS.cash)),
    receivables: amount(section(within, RATIO_SECTIONS.receivables)),
    currentAssets: amount(currentAssets),
    totalAssets: amount(assets),
    currentLiabilities: amount(section(lines, RATIO_SECTIONS.currentLiabilities)),
    totalLiabilities: amount(section(lines, SECTIONS.liabilities)),
    equity: amount(section(lines, SECTIONS.equity)),
  };
}

/** A ratio is only stated over a positive base: nothing owed, or negative
    equity, has no meaningful multiple. */
const over = (n: number, base: number): number | null => (base > 0 ? n / base : null);

export interface BalanceRatios {
  /** Current assets less current liabilities, in dollars. */
  workingCapital: number;
  /** Current assets ÷ current liabilities. */
  currentRatio: number | null;
  /** (Cash + receivables) ÷ current liabilities. */
  quickRatio: number | null;
  /** Total liabilities ÷ total equity. */
  debtToEquity: number | null;
  /** Total liabilities ÷ total assets. */
  debtToAssets: number | null;
}

export function balanceRatios(f: BalanceFigures): BalanceRatios {
  return {
    workingCapital: Math.round((f.currentAssets - f.currentLiabilities) * 100) / 100,
    currentRatio: over(f.currentAssets, f.currentLiabilities),
    quickRatio: over(f.cash + f.receivables, f.currentLiabilities),
    debtToEquity: over(f.totalLiabilities, f.equity),
    debtToAssets: over(f.totalLiabilities, f.totalAssets),
  };
}

/** Income for a period, with the period's length. */
export interface PeriodIncome {
  /** Operating revenue (other income left out). */
  revenue: number;
  netIncome: number;
  /** First and last month of the period, `YYYY-MM`. */
  from: string;
  to: string;
}

/** Whole months from `from` through `to`, both `YYYY-MM`, inclusive. */
export function monthsInPeriod(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm) + 1;
}

/** Calendar days from the first of `from` through the last of `to`. */
export function daysInPeriod(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm, 1) - Date.UTC(fy, fm - 1, 1)) / 86_400_000);
}

export interface ReturnRatios {
  /** Net income at an annual rate ÷ total assets at the period end. */
  returnOnAssets: number | null;
  /** Net income at an annual rate ÷ total equity at the period end. */
  returnOnEquity: number | null;
  /** Receivables at the period end ÷ average revenue per day. */
  daysSalesOutstanding: number | null;
}

/**
 * Ratios that set a period's income against the balance sheet at its end.
 * Net income is restated to an annual rate (× 12 ÷ months) so a three-month
 * and a twelve-month period read on the same scale. Balances are the
 * period-end ones, not an average over the period.
 */
export function returnRatios(income: PeriodIncome, f: BalanceFigures): ReturnRatios {
  const months = monthsInPeriod(income.from, income.to);
  if (months <= 0) {
    return { returnOnAssets: null, returnOnEquity: null, daysSalesOutstanding: null };
  }
  const annualNetIncome = (income.netIncome * 12) / months;
  return {
    returnOnAssets: over(annualNetIncome, f.totalAssets),
    returnOnEquity: over(annualNetIncome, f.equity),
    daysSalesOutstanding: over(
      f.receivables * daysInPeriod(income.from, income.to),
      income.revenue,
    ),
  };
}

/** "1.85×" — a ratio stated as a multiple. */
export function multiple(n: number | null): string {
  return n === null ? "—" : `${n.toFixed(2)}×`;
}
