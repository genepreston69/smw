import { isEnterpriseName } from "@/lib/enterprise";
import { isNonBillableJobName, isTransportationJobName } from "@/lib/jobViews";
import { lastDayOfMonth, monthLabel } from "@/lib/financials";

/* ---------------------------------------------------------------------------
   Capitalized-labor candidates. Labor posted by journal entry (payroll
   allocations: wages plus the employer's share of payroll taxes) to a job
   that isn't outside-customer work may belong in a capital account rather
   than job cost. The dashboard (src/app/(app)/capitalized-labor/), the CSV
   export (src/app/api/export/capitalized-labor/), and the Excel export
   (src/app/api/export/capitalized-labor-workbook/) must bucket identically,
   so the job rule lives here.

   Which journal lines count, and whether each is labor posted or already
   capitalized, is decided in SQL by the cap_labor_lines view (migration
   0030): expense-side wage and employer-tax accounts only — withholdings and
   other payroll liabilities never count — and a line is capitalized only
   when its entry debits a capital asset. Every reader goes through it.
--------------------------------------------------------------------------- */

export type CapLaborBucket = "nonbillable" | "intercompany";

/** A counted journal line's role (cap_labor_lines.treatment). */
export type CapLaborTreatment = "posted" | "capitalized";

export const CAP_LABOR_TREATMENT_LABELS: Record<CapLaborTreatment, string> = {
  posted: "Labor posted",
  capitalized: "Capitalized",
};

/**
 * A line's contribution to the dashboard's two sums: labor posted (net — a
 * reversal nets against it) and already capitalized (stored positive; the
 * capitalizing credit is negative in the ledger).
 */
export function capLaborAmounts(
  treatment: string,
  amount: number,
): { posted: number; capitalized: number } {
  return treatment === "capitalized"
    ? { posted: 0, capitalized: -amount }
    : { posted: amount, capitalized: 0 };
}

export const CAP_LABOR_BUCKET_LABELS: Record<CapLaborBucket, string> = {
  nonbillable: "Non-Billable",
  intercompany: "Intercompany",
};

// Precision Paint's jobs for Superior Marine Ways are capitalized wages —
// already handled through the capitalization process, so they never need
// review here. Matching is fuzzy like isEnterpriseName: QuickBooks names
// vary ("Precision Paint Systems, LLC", "Superior Marine Ways, Inc.").
export function isPpsWorkForSuperiorMarine(
  qbCompanyName: string | null | undefined,
  customerName: string | null | undefined,
): boolean {
  if (!qbCompanyName || !customerName) return false;
  return (
    qbCompanyName.toLowerCase().includes("precision paint") &&
    customerName.toLowerCase().includes("superior marine")
  );
}

// A job qualifies when it's internal equipment work (EQP…) or work performed
// for a sister company. Transportation jobs are operating work and never
// qualify — same precedence as the Jobs dashboard. Unlike the Jobs tabs,
// recent activity doesn't matter here: old journal entries still need review.
export function capLaborBucket(j: {
  name: string;
  customerDisplayName?: string | null;
  customerCompanyName?: string | null;
  /** Name of the QuickBooks company (realm) the job was imported from. */
  qbCompanyName?: string | null;
}): CapLaborBucket | null {
  if (isTransportationJobName(j.name)) return null;
  if (
    isPpsWorkForSuperiorMarine(j.qbCompanyName, j.customerDisplayName) ||
    isPpsWorkForSuperiorMarine(j.qbCompanyName, j.customerCompanyName)
  ) {
    return null;
  }
  if (isNonBillableJobName(j.name)) return "nonbillable";
  if (
    isEnterpriseName(j.customerDisplayName) ||
    isEnterpriseName(j.customerCompanyName)
  ) {
    return "intercompany";
  }
  return null;
}

/* ---------------------------------------------------------------------------
   Period. Capitalized labor is viewed for one calendar year, one month, or a
   range of months — the current year to date unless the URL picks another —
   on both Capitalized Labor pages, the job drill-down, and every export, so
   the window lives here and each of them parses the same URL params with
   capLaborPeriod. Imported history starts Jan 2023 (frozen pre-audit job
   costs and ledger lines persist back to then); nothing runs past today.
   Dates are UTC, matching the database (current_date is UTC on Supabase),
   and YYYY-MM-DD strings compare as dates.
--------------------------------------------------------------------------- */

export const CAP_LABOR_FIRST_YEAR = 2023;
const FIRST_MONTH = `${CAP_LABOR_FIRST_YEAR}-01`;

export type CapLaborPeriodKind = "year" | "month" | "range";

/** URL params that pick a period: ?year=2025, ?month=2026-03, or
    ?from=2025-07&to=2026-06. None selects the current year to date. */
export interface CapLaborPeriodParams {
  year?: string;
  month?: string;
  from?: string;
  to?: string;
}

export interface CapLaborWindow {
  kind: CapLaborPeriodKind;
  /** First day counted, YYYY-MM-DD. */
  from: string;
  /** Last day counted (never past today), YYYY-MM-DD. */
  to: string;
  /** First and last months, YYYY-MM — the bounds for month-grain reads
      (the benefit allocation). */
  fromMonth: string;
  toMonth: string;
  /** "2026 year to date", "2025", "Mar 2026", "Jul 2025 – Jun 2026" — for
      labels. */
  label: string;
  /** "2026-ytd", "2025", "2026-03", "2025-07-to-2026-06" — for file names. */
  fileTag: string;
  /** The params that select this period; empty for the default. */
  params: CapLaborPeriodParams;
}

const MONTH_PARAM = /^\d{4}-(0[1-9]|1[0-2])$/;
const YEAR_PARAM = /^\d{4}$/;

/** The period a request asked for. A month range wins over a month, a month
    over a year; anything malformed or outside the history falls back to the
    current year to date. */
export function capLaborPeriod(
  p: CapLaborPeriodParams = {},
  now: Date = new Date(),
): CapLaborWindow {
  const today = now.toISOString().slice(0, 10);
  const nowMonth = today.slice(0, 7);
  const nowYear = now.getUTCFullYear();
  // Search params can arrive as arrays; only a single well-formed value counts.
  const month = (v: unknown) =>
    typeof v === "string" && MONTH_PARAM.test(v)
      ? v < FIRST_MONTH
        ? FIRST_MONTH
        : v > nowMonth
          ? nowMonth
          : v
      : null;
  const windowOf = (
    kind: CapLaborPeriodKind,
    fromMonth: string,
    toMonth: string,
    label: string,
    fileTag: string,
    params: CapLaborPeriodParams,
  ): CapLaborWindow => {
    const end = lastDayOfMonth(toMonth);
    return {
      kind,
      from: `${fromMonth}-01`,
      to: end > today ? today : end,
      fromMonth,
      toMonth,
      label,
      fileTag,
      params,
    };
  };

  // A lone range bound runs to the edge of the history; a one-month range
  // is that month.
  let from = month(p.from);
  let to = month(p.to);
  if (from || to) {
    from ??= FIRST_MONTH;
    to ??= nowMonth;
    if (from > to) [from, to] = [to, from];
    if (from !== to) {
      return windowOf(
        "range",
        from,
        to,
        `${monthLabel(from)} – ${monthLabel(to)}${to === nowMonth ? " (to date)" : ""}`,
        `${from}-to-${to}`,
        { from, to },
      );
    }
  }

  const m = from ?? month(p.month);
  if (m) {
    return windowOf(
      "month",
      m,
      m,
      m === nowMonth ? `${monthLabel(m)} month to date` : monthLabel(m),
      m,
      { month: m },
    );
  }

  const y =
    typeof p.year === "string" && YEAR_PARAM.test(p.year) ? Number(p.year) : nowYear;
  const year = y >= CAP_LABOR_FIRST_YEAR && y <= nowYear ? y : nowYear;
  const current = year === nowYear;
  return windowOf(
    "year",
    `${year}-01`,
    current ? nowMonth : `${year}-12`,
    current ? `${year} year to date` : String(year),
    current ? `${year}-ytd` : String(year),
    current ? {} : { year: String(year) },
  );
}

/** The period an export request's query string asks for — the same params
    the pages put in their download links. */
export function capLaborPeriodFromSearch(
  search: URLSearchParams,
  now: Date = new Date(),
): CapLaborWindow {
  const get = (k: keyof CapLaborPeriodParams) => search.get(k) ?? undefined;
  return capLaborPeriod(
    { year: get("year"), month: get("month"), from: get("from"), to: get("to") },
    now,
  );
}

/** Calendar years a period can pick, newest first: the current year back to
    the start of the imported history. */
export function capLaborYears(now: Date = new Date()): number[] {
  const last = now.getUTCFullYear();
  return Array.from(
    { length: last - CAP_LABOR_FIRST_YEAR + 1 },
    (_, i) => last - i,
  );
}

/** First and last months a period can pick, YYYY-MM. */
export function capLaborMonthBounds(now: Date = new Date()): {
  min: string;
  max: string;
} {
  return { min: FIRST_MONTH, max: now.toISOString().slice(0, 7) };
}

/** Every month of a period, oldest first, YYYY-MM. */
export function capLaborMonths(w: Pick<CapLaborWindow, "fromMonth" | "toMonth">): string[] {
  const months: string[] = [];
  for (let m = w.fromMonth; m <= w.toMonth; m = shiftMonth(m, 1)) months.push(m);
  return months;
}

/** The month `delta` months from a YYYY-MM month. */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

/** A link to `path` for a period, plus any other params to keep (e.g. the
    dashboard's tab). The default period adds nothing to the URL. */
export function capLaborHref(
  path: string,
  params: CapLaborPeriodParams,
  extra: Record<string, string | null | undefined> = {},
): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(extra)) if (v) q.set(k, v);
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

/* ---------------------------------------------------------------------------
   By month. The dashboard and its Excel workbook both break the period's
   candidate labor into calendar months, so the rollup lives here.
--------------------------------------------------------------------------- */

export interface CapLaborMonthRow {
  /** YYYY-MM, or "total" for the period's total row. */
  month: string;
  /** Jobs with counted labor that month (distinct across the period on the
      total row). */
  jobs: number;
  /** Journal entries per job, summed — the Entries column's definition. */
  entries: number;
  posted: number;
  /** Stored positive, like the dashboard. */
  capitalized: number;
  /** Awaiting review: posted − capitalized. */
  net: number;
  /** Benefit allocation booked to those jobs that month. */
  benefits: number;
}

/**
 * Rolls the period's counted lines and benefit allocation up by month, for
 * the jobs `include` keeps (candidates, filtered by the dashboard's tab).
 * Every month of the period gets a row, quiet months included.
 */
export function capLaborByMonth(
  w: Pick<CapLaborWindow, "fromMonth" | "toMonth">,
  lines: {
    job_id: string;
    qb_txn_id: string;
    txn_date: string | null;
    amount: number | string | null;
    treatment: string;
  }[],
  benefits: { job_id: string; month: string; amount: number | string | null }[],
  include: (jobId: string) => boolean,
): { rows: CapLaborMonthRow[]; total: CapLaborMonthRow } {
  const blank = (month: string) => ({
    row: { month, jobs: 0, entries: 0, posted: 0, capitalized: 0, net: 0, benefits: 0 },
    jobs: new Set<string>(),
    entries: new Set<string>(),
  });
  const byMonth = new Map(capLaborMonths(w).map((m) => [m, blank(m)]));
  const total = blank("total");
  for (const l of lines) {
    if (!include(l.job_id) || !l.txn_date) continue;
    const acc = byMonth.get(l.txn_date.slice(0, 7));
    if (!acc) continue;
    const split = capLaborAmounts(l.treatment, Number(l.amount ?? 0));
    // A journal entry is counted once per job it touches (qb_txn_id is only
    // unique within a QuickBooks company, and a job lives in one).
    const entry = `${l.job_id}:${l.qb_txn_id}`;
    for (const a of [acc, total]) {
      a.row.posted += split.posted;
      a.row.capitalized += split.capitalized;
      a.jobs.add(l.job_id);
      a.entries.add(entry);
    }
  }
  for (const b of benefits) {
    if (!include(b.job_id)) continue;
    const acc = byMonth.get(b.month.slice(0, 7));
    if (!acc) continue;
    const amount = Number(b.amount ?? 0);
    acc.row.benefits += amount;
    total.row.benefits += amount;
  }
  const finish = (a: ReturnType<typeof blank>) => ({
    ...a.row,
    jobs: a.jobs.size,
    // An entry has one date, so per-month counts sum to the period's.
    entries: a.entries.size,
    net: a.row.posted - a.row.capitalized,
  });
  return { rows: [...byMonth.values()].map(finish), total: finish(total) };
}

/** Calendar year of a YYYY-MM-DD (or YYYY-MM) string; null when undated. */
export function yearOf(date: string | null | undefined): number | null {
  if (!date) return null;
  const y = Number(date.slice(0, 4));
  return Number.isFinite(y) ? y : null;
}
