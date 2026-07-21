import { isEnterpriseName } from "@/lib/enterprise";
import { isNonBillableJobName, isTransportationJobName } from "@/lib/jobViews";

/* ---------------------------------------------------------------------------
   Capitalized-labor candidates. Labor posted by journal entry (payroll
   allocations against labor/payroll/wages accounts) to a job that isn't
   outside-customer work may belong in a capital account rather than job
   cost. The dashboard (src/app/(app)/capitalized-labor/) and the CSV export
   (src/app/api/export/capitalized-labor/) must bucket identically, so the
   rule lives here.
--------------------------------------------------------------------------- */

export type CapLaborBucket = "nonbillable" | "intercompany";

export const CAP_LABOR_BUCKET_LABELS: Record<CapLaborBucket, string> = {
  nonbillable: "Non-Billable",
  intercompany: "Intercompany",
};

// A job qualifies when it's internal equipment work (EQP…) or work performed
// for a sister company. Transportation jobs are operating work and never
// qualify — same precedence as the Jobs dashboard. Unlike the Jobs tabs,
// recent activity doesn't matter here: old journal entries still need review.
export function capLaborBucket(j: {
  name: string;
  customerDisplayName?: string | null;
  customerCompanyName?: string | null;
}): CapLaborBucket | null {
  if (isTransportationJobName(j.name)) return null;
  if (isNonBillableJobName(j.name)) return "nonbillable";
  if (
    isEnterpriseName(j.customerDisplayName) ||
    isEnterpriseName(j.customerCompanyName)
  ) {
    return "intercompany";
  }
  return null;
}
