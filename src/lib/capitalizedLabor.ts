import { isEnterpriseName } from "@/lib/enterprise";
import { isNonBillableJobName, isTransportationJobName } from "@/lib/jobViews";

/* ---------------------------------------------------------------------------
   Capitalized-labor candidates. Labor posted by journal entry (payroll
   allocations against labor/payroll/wages accounts) to a job that isn't
   outside-customer work may belong in a capital account rather than job
   cost. The dashboard (src/app/(app)/capitalized-labor/), the CSV export
   (src/app/api/export/capitalized-labor/), and the Excel export
   (src/app/api/export/capitalized-labor-workbook/) must bucket identically,
   so the rule lives here.
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
   Year breakdown. The dashboard, the CSV export, and the Excel workbook all
   split the same history into calendar years, so the range lives here too.
--------------------------------------------------------------------------- */

// Imported transaction history starts here: syncs refresh only rows dated on
// or after JOB_COSTS_START_DATE (src/lib/quickbooks.ts), and everything back
// to Jan 1 2023 persists in job_costs as frozen pre-audit history.
export const CAP_LABOR_FIRST_YEAR = 2023;

/**
 * Calendar years the dashboard breaks out — 2023 through the current year,
 * extended backwards if any imported line predates 2023.
 * `earliestDate` is a YYYY-MM-DD string (the oldest line seen), if known.
 */
export function capLaborYears(
  earliestDate?: string | null,
  now: Date = new Date(),
): number[] {
  const dataFirst = earliestDate ? Number(earliestDate.slice(0, 4)) : NaN;
  const first = Number.isFinite(dataFirst)
    ? Math.min(CAP_LABOR_FIRST_YEAR, dataFirst)
    : CAP_LABOR_FIRST_YEAR;
  const last = Math.max(now.getUTCFullYear(), first);
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

/** Calendar year of a YYYY-MM-DD (or YYYY-MM) string; null when undated. */
export function yearOf(date: string | null | undefined): number | null {
  if (!date) return null;
  const y = Number(date.slice(0, 4));
  return Number.isFinite(y) ? y : null;
}
