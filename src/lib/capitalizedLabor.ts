import { isEnterpriseName } from "@/lib/enterprise";
import { isNonBillableJobName, isTransportationJobName } from "@/lib/jobViews";

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
   Time window. Capitalized labor is calculated for the calendar year to date
   only — Jan 1 of the current year through today — on the dashboard, its
   line drill-down, and both exports, so the window lives here. Dates are
   UTC, matching the database (current_date is UTC on Supabase), and
   YYYY-MM-DD strings compare as dates.
--------------------------------------------------------------------------- */

export interface CapLaborWindow {
  year: number;
  /** First day counted (Jan 1), YYYY-MM-DD. */
  from: string;
  /** Last day counted (today), YYYY-MM-DD. */
  to: string;
  /** First of the current month: the upper bound for month-grain reads
      (the benefit allocation). */
  toMonth: string;
  /** "2026 year to date" — for labels and file names. */
  label: string;
}

export function capLaborWindow(now: Date = new Date()): CapLaborWindow {
  const year = now.getUTCFullYear();
  const to = now.toISOString().slice(0, 10);
  return {
    year,
    from: `${year}-01-01`,
    to,
    toMonth: `${to.slice(0, 7)}-01`,
    label: `${year} year to date`,
  };
}

/** Calendar year of a YYYY-MM-DD (or YYYY-MM) string; null when undated. */
export function yearOf(date: string | null | undefined): number | null {
  if (!date) return null;
  const y = Number(date.slice(0, 4));
  return Number.isFinite(y) ? y : null;
}
