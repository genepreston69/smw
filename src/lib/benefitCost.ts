// Cost of Benefits (/financials/benefits): what employee benefits cost per
// dollar of labor.
//
//   Benefit rate = Employee Benefits ÷ (710 Labor Cost + 935 Salaries & Wages
//                                        + 934 Labor Maint)
//
// The numerator is every expense account whose Chart of Accounts Category is
// "Employee Benefits"; the denominator is the base accounts, found by account
// number. Which accounts those are is a setting (Settings → Business rules,
// benefitBaseAccounts in appSettings.ts; the three above are the default), so
// every function here takes the list. Everything is the ledger as booked — nothing is allocated
// or reclassified — so each line ties to the Income Statement. Pure and
// client-safe; the server loader is benefitCostServer.ts.

import type { BenefitBaseAccount } from "@/lib/appSettings";

export const BENEFITS_CATEGORY = "Employee Benefits";

/** "benefits", or the account number of one of the base accounts. */
export type BenefitLineKey = string;

/** The benefit-rate formula in words, for headers and footnotes. */
export const benefitFormula = (bases: BenefitBaseAccount[]): string =>
  `${BENEFITS_CATEGORY} ÷ (${bases.map((a) => a.label).join(" + ")})`;

/** Same folding as financials.ts / gl_normalize_label: lowercase, "&" → "and",
    collapsed whitespace. */
const normalizeLabel = (label: string): string =>
  label.toLowerCase().replace(/&/g, " and ").replace(/\s+/g, " ").trim();

export function isBenefitsCategory(category: string | null | undefined): boolean {
  return !!category && normalizeLabel(category) === normalizeLabel(BENEFITS_CATEGORY);
}

/** Which labor account a ledger account belongs to, by account number: the
    account itself or any parent in its "Parent:Sub" path must start with the
    number, so sub-accounts of a base account count with their parent. */
export function laborBaseNumber(
  accountFullName: string,
  bases: BenefitBaseAccount[],
): BenefitLineKey | null {
  for (const segment of accountFullName.split(":")) {
    const m = /^\s*(\d+)(?!\d)/.exec(segment);
    if (!m) continue;
    const hit = bases.find((a) => a.number === m[1]);
    if (hit) return hit.number;
  }
  return null;
}

/** Which line of the calculation an account feeds, if any. An account
    categorized Employee Benefits is always benefits — never also labor — so
    no dollar is on both sides of the ratio. */
export function benefitLineFor(
  accountFullName: string,
  category: string | null | undefined,
  bases: BenefitBaseAccount[],
): BenefitLineKey | null {
  if (isBenefitsCategory(category)) return "benefits";
  return laborBaseNumber(accountFullName, bases);
}

export interface BenefitTotals {
  /** Amount per column key (month). */
  cells: Record<string, number>;
  total: number;
}

export interface BenefitLine extends BenefitTotals {
  key: BenefitLineKey;
  label: string;
  /** Member accounts with activity, largest first. */
  accounts: (BenefitTotals & { name: string })[];
}

export interface BenefitCost {
  /** Month keys (YYYY-MM), ascending. */
  colKeys: string[];
  benefits: BenefitLine;
  /** One line per base account, in the settings' order. */
  labor: BenefitLine[];
  laborTotal: BenefitTotals;
  /** benefits ÷ laborTotal; null where there is no labor to divide by. */
  rate: { cells: Record<string, number | null>; total: number | null };
}

export interface BenefitCell {
  line: BenefitLineKey;
  account: string;
  month: string;
  amount: number;
  /** QuickBooks class as gl_pivot keys it ("(no class)" when none). */
  cls: string;
}

/** One class's period totals, for the By class table and sheet. */
export interface BenefitClassRow {
  cls: string;
  benefits: number;
  /** Period total per base account number. */
  labor: Record<string, number>;
  laborTotal: number;
  rate: number | null;
}

/** Period totals per class, in the order given. The classes add up to the
    All classes figures exactly: both come from the same cells. */
export function benefitCostByClass(
  cells: BenefitCell[],
  classes: string[],
  bases: BenefitBaseAccount[],
): BenefitClassRow[] {
  return classes.map((cls) => {
    const c = buildBenefitCost(cells.filter((x) => x.cls === cls), bases);
    return {
      cls,
      benefits: c.benefits.total,
      labor: Object.fromEntries(c.labor.map((l) => [l.key, l.total])),
      laborTotal: c.laborTotal.total,
      rate: c.rate.total,
    };
  });
}

export interface BenefitCostState {
  company: string; // realm id or "all"
  from: string; // YYYY-MM
  to: string; // YYYY-MM
  /** QuickBooks class, or null for All classes. */
  cls: string | null;
}

function stateParams(s: BenefitCostState): URLSearchParams {
  const params = new URLSearchParams({ company: s.company, from: s.from, to: s.to });
  if (s.cls !== null) params.set("class", s.cls);
  return params;
}

/** Page URL for a state; explicit params so links survive a month rollover. */
export const benefitCostHref = (s: BenefitCostState): string =>
  `/financials/benefits?${stateParams(s)}`;

/** Excel export of the page; carries the full state so the file matches the screen. */
export const benefitCostExportHref = (s: BenefitCostState): string =>
  `/api/export/benefits?${stateParams(s)}`;

const cents = (n: number) => Math.round(n * 100) / 100;

export function buildBenefitCost(
  cells: BenefitCell[],
  bases: BenefitBaseAccount[],
): BenefitCost {
  const colSet = new Set<string>();
  const byLine = new Map<BenefitLineKey, Map<string, Record<string, number>>>();
  for (const c of cells) {
    if (!c.amount) continue;
    colSet.add(c.month);
    let accounts = byLine.get(c.line);
    if (!accounts) byLine.set(c.line, (accounts = new Map()));
    let months = accounts.get(c.account);
    if (!months) accounts.set(c.account, (months = {}));
    months[c.month] = (months[c.month] ?? 0) + c.amount;
  }
  const colKeys = [...colSet].sort();

  const line = (key: BenefitLineKey, label: string): BenefitLine => {
    const totals: Record<string, number> = {};
    const accounts = [...(byLine.get(key) ?? new Map<string, Record<string, number>>())]
      .map(([name, months]) => {
        const out: Record<string, number> = {};
        let total = 0;
        for (const k of colKeys) {
          const v = cents(months[k] ?? 0);
          out[k] = v;
          total += v;
          totals[k] = (totals[k] ?? 0) + v;
        }
        return { name, cells: out, total: cents(total) };
      })
      .filter((a) => a.total !== 0 || colKeys.some((k) => a.cells[k] !== 0))
      .sort((a, b) => Math.abs(b.total) - Math.abs(a.total) || a.name.localeCompare(b.name));
    const lineCells: Record<string, number> = {};
    let total = 0;
    for (const k of colKeys) {
      lineCells[k] = cents(totals[k] ?? 0);
      total += lineCells[k];
    }
    return { key, label, accounts, cells: lineCells, total: cents(total) };
  };

  const benefits = line("benefits", BENEFITS_CATEGORY);
  const labor = bases.map((a) => line(a.number, a.label));

  const laborCells: Record<string, number> = {};
  for (const k of colKeys) {
    laborCells[k] = cents(labor.reduce((s, l) => s + l.cells[k], 0));
  }
  const laborTotal = {
    cells: laborCells,
    total: cents(labor.reduce((s, l) => s + l.total, 0)),
  };

  // A rate only means something against positive labor.
  const ratio = (b: number, l: number) => (l > 0 ? b / l : null);
  const rateCells: Record<string, number | null> = {};
  for (const k of colKeys) rateCells[k] = ratio(benefits.cells[k], laborCells[k]);

  return {
    colKeys,
    benefits,
    labor,
    laborTotal,
    rate: { cells: rateCells, total: ratio(benefits.total, laborTotal.total) },
  };
}
