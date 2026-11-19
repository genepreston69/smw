import { isEnterpriseName } from "@/lib/enterprise";
import type { IntercompanyRules } from "@/lib/appSettings";
import { isNonBillableJobName, isTransportationJobName } from "@/lib/jobViews";
import { lastDayOfMonth, monthLabel } from "@/lib/financials";

/* ---------------------------------------------------------------------------
   Capitalized Jobs: which jobs are candidates, and the period every
   Capitalized page shares. Cost posted to a job that isn't outside-customer
   work may belong in a capital account rather than job cost. The page
   (src/app/(app)/capitalized-jobs/) and both exports bucket jobs through
   loadCapJobs (src/lib/capitalizedJobsServer.ts), which uses the rule here.

   Which job-cost lines count, and how, is decided in SQL by the
   cap_job_lines view (migration 0044); the rollups are in
   src/lib/capitalizedJobs.ts.
--------------------------------------------------------------------------- */

export type CapLaborBucket = "nonbillable" | "intercompany";

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
// recent activity doesn't matter here: old transactions still need review.
export function capLaborBucket(
  j: {
    name: string;
    customerDisplayName?: string | null;
    customerCompanyName?: string | null;
    /** Name of the QuickBooks company (realm) the job was imported from. */
    qbCompanyName?: string | null;
  },
  /** The sister-company list (settings.intercompany from loadAppSettings). */
  intercompany: IntercompanyRules,
): CapLaborBucket | null {
  if (isTransportationJobName(j.name)) return null;
  if (
    isPpsWorkForSuperiorMarine(j.qbCompanyName, j.customerDisplayName) ||
    isPpsWorkForSuperiorMarine(j.qbCompanyName, j.customerCompanyName)
  ) {
    return null;
  }
  if (isNonBillableJobName(j.name)) return "nonbillable";
  if (
    isEnterpriseName(j.customerDisplayName, intercompany) ||
    isEnterpriseName(j.customerCompanyName, intercompany)
  ) {
    return "intercompany";
  }
  return null;
}

/* ---------------------------------------------------------------------------
   Period. Capitalized Jobs is viewed for one calendar year, one month, or a
   range of months — the current year to date unless the URL picks another —
   and so is Already Capitalized, the job drill-down, and every export, so the window lives here and each of them
   parses the same URL params with capLaborPeriod. Imported history starts
   Jan 2023 (frozen pre-audit job costs and ledger lines persist back to
   then); nothing runs past today.
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

/** Calendar year of a YYYY-MM-DD (or YYYY-MM) string; null when undated. */
export function yearOf(date: string | null | undefined): number | null {
  if (!date) return null;
  const y = Number(date.slice(0, 4));
  return Number.isFinite(y) ? y : null;
}
