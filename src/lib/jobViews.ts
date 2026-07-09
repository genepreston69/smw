import { isEnterpriseName } from "@/lib/enterprise";

/* ---------------------------------------------------------------------------
   The five Jobs dashboard views. The dashboard tabs and the workbook export
   must bucket jobs identically, so the classification lives here.
--------------------------------------------------------------------------- */

export type JobView =
  | "customer"
  | "transportation"
  | "intercompany"
  | "nonbillable"
  | "notransactions";

export const JOB_VIEWS: JobView[] = [
  "customer",
  "transportation",
  "intercompany",
  "nonbillable",
  "notransactions",
];

export const JOB_VIEW_LABELS: Record<JobView, string> = {
  customer: "Customer Jobs",
  transportation: "Transportation",
  intercompany: "Intercompany",
  nonbillable: "Non-Billable",
  notransactions: "No Transactions",
};

// Jobs with no cost or invoice activity on or after this date belong on the
// "No Transactions" tab (except US Army Corps of Engineers jobs).
export const NO_TXN_CUTOFF = "2025-01-01";

// US Army Corps of Engineers jobs stay under Customer Jobs even without
// recent transactions. QuickBooks names vary ("US Army Corps of Engineers",
// "U.S. Army Corps...", "USACE"), so match loosely like isEnterpriseName.
export function isArmyCorpsName(name: string | null | undefined): boolean {
  if (!name) return false;
  const n = name.toLowerCase();
  return n.includes("army corps") || n.split(/[^a-z0-9]+/).includes("usace");
}

// EQP-prefixed job numbers are internal equipment work — never billable.
export function isNonBillableJobName(name: string): boolean {
  return /^eqp/i.test(name.trim());
}

// Transportation work is identified by the job number suffix: LH, HS, or FL.
export function isTransportationJobName(name: string): boolean {
  return /(lh|hs|fl)$/i.test(name.trim());
}

export function classifyJobView(j: {
  name: string;
  customerDisplayName?: string | null;
  customerCompanyName?: string | null;
  // Latest cost or invoice date (YYYY-MM-DD), null when the job has neither.
  latestActivityDate: string | null;
}): JobView {
  // Transportation wins over everything: every LH/HS/FL job lives on the
  // Transportation tab and nowhere else.
  if (isTransportationJobName(j.name)) return "transportation";
  // YYYY-MM-DD strings, so string compare works.
  const hasRecentActivity =
    !!j.latestActivityDate && j.latestActivityDate >= NO_TXN_CUTOFF;
  if (
    !hasRecentActivity &&
    !isArmyCorpsName(j.customerDisplayName) &&
    !isArmyCorpsName(j.customerCompanyName)
  ) {
    return "notransactions";
  }
  if (isNonBillableJobName(j.name)) return "nonbillable";
  if (
    isEnterpriseName(j.customerDisplayName) ||
    isEnterpriseName(j.customerCompanyName)
  ) {
    return "intercompany";
  }
  return "customer";
}
