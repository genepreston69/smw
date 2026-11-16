// Cost of Benefits (/financials/benefits): what employee benefits cost per
// dollar of labor.
//
//   Benefit rate = Employee Benefits ÷ (710 Labor Cost + 935 Salaries & Wages
//                                        + 934 Labor Maint)
//
// The numerator is every expense account whose Chart of Accounts Category is
// "Employee Benefits"; the denominator is the three labor accounts, found by
// account number. Everything is the ledger as booked — nothing is allocated
// or reclassified — so each line ties to the Income Statement. Pure and
// client-safe; the server loader is benefitCostServer.ts.

export const BENEFITS_CATEGORY = "Employee Benefits";

/** The labor accounts that make up the denominator, in display order. */
export const LABOR_BASE_ACCOUNTS = [
  { number: "710", label: "710 Labor Cost" },
  { number: "935", label: "935 Salaries & Wages" },
  { number: "934", label: "934 Labor Maint" },
] as const;

export type BenefitLineKey = "benefits" | (typeof LABOR_BASE_ACCOUNTS)[number]["number"];

/** Same folding as financials.ts / gl_normalize_label: lowercase, "&" → "and",
    collapsed whitespace. */
const normalizeLabel = (label: string): string =>
  label.toLowerCase().replace(/&/g, " and ").replace(/\s+/g, " ").trim();

export function isBenefitsCategory(category: string | null | undefined): boolean {
  return !!category && normalizeLabel(category) === normalizeLabel(BENEFITS_CATEGORY);
}

/** Which labor account a ledger account belongs to, by account number: the
    account itself or any parent in its "Parent:Sub" path must start with the
    number, so sub-accounts of 710 / 935 / 934 count with their parent. */
export function laborBaseNumber(accountFullName: string): BenefitLineKey | null {
  for (const segment of accountFullName.split(":")) {
    const m = /^\s*(\d+)(?!\d)/.exec(segment);
    if (!m) continue;
    const hit = LABOR_BASE_ACCOUNTS.find((a) => a.number === m[1]);
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
): BenefitLineKey | null {
  if (isBenefitsCategory(category)) return "benefits";
  return laborBaseNumber(accountFullName);
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
  /** One line per LABOR_BASE_ACCOUNTS entry, in that order. */
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
}

const cents = (n: number) => Math.round(n * 100) / 100;

export function buildBenefitCost(cells: BenefitCell[]): BenefitCost {
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
  const labor = LABOR_BASE_ACCOUNTS.map((a) => line(a.number, a.label));

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
