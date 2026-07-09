import { isEnterpriseName } from "@/lib/enterprise";

/* ---------------------------------------------------------------------------
   The four Jobs dashboard views. The dashboard tabs and the workbook export
   must bucket jobs identically, so the classification lives here.
--------------------------------------------------------------------------- */

export type JobView =
  | "customer"
  | "intercompany"
  | "nonbillable"
  | "notransactions";

export const JOB_VIEWS: JobView[] = [
  "customer",
  "intercompany",
  "nonbillable",
  "notransactions",
];

export const JOB_VIEW_LABELS: Record<JobView, string> = {
  customer: "Customer Jobs",
  intercompany: "Intercompany",
  nonbillable: "Non-Billable",
  notransactions: "No Transactions",
};

// Jobs with no cost or invoice activity on or after this date land in the
// No Transactions view (except US Army Corps of Engineers jobs). The sync
// import window (JOB_COSTS_START_DATE in src/lib/quickbooks.ts) must reach
// back at least this far.
export const NO_TXN_CUTOFF = "2025-01-01";

// EQP-prefixed job numbers are internal equipment work — never billable.
export function isNonBillableJobName(name: string): boolean {
  return /^eqp/i.test(name.trim());
}

// US Army Corps of Engineers jobs stay under Customer Jobs even without
// recent activity. QuickBooks names vary ("US Army Corps of Engineers",
// "U.S. Army Corps...", "USACE"), so match loosely like isEnterpriseName.
export function isArmyCorpsName(name: string | null | undefined): boolean {
  if (!name) return false;
  const n = name.toLowerCase();
  return n.includes("army corps") || n.split(/[^a-z0-9]+/).includes("usace");
}

export function classifyJobView(j: {
  name: string;
  customerDisplayName?: string | null;
  customerCompanyName?: string | null;
  /** Most recent cost line or invoice date (YYYY-MM-DD), if any. */
  latestTxnDate: string | null;
}): JobView {
  const armyCorps =
    isArmyCorpsName(j.customerDisplayName) ||
    isArmyCorpsName(j.customerCompanyName);
  // Dates are YYYY-MM-DD strings, so string compare works.
  const hasRecentActivity =
    !!j.latestTxnDate && j.latestTxnDate >= NO_TXN_CUTOFF;
  if (!hasRecentActivity && !armyCorps) return "notransactions";
  if (isNonBillableJobName(j.name)) return "nonbillable";
  if (
    isEnterpriseName(j.customerDisplayName) ||
    isEnterpriseName(j.customerCompanyName)
  ) {
    return "intercompany";
  }
  return "customer";
}
