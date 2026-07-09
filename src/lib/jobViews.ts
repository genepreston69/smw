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

// EQP-prefixed job numbers are internal equipment work — never billable.
export function isNonBillableJobName(name: string): boolean {
  return /^eqp/i.test(name.trim());
}

export function classifyJobView(j: {
  name: string;
  customerDisplayName?: string | null;
  customerCompanyName?: string | null;
  hasTransactions: boolean;
}): JobView {
  if (!j.hasTransactions) return "notransactions";
  if (isNonBillableJobName(j.name)) return "nonbillable";
  if (
    isEnterpriseName(j.customerDisplayName) ||
    isEnterpriseName(j.customerCompanyName)
  ) {
    return "intercompany";
  }
  return "customer";
}
