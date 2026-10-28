import {
  isNonBillableJobName,
  isPpsInternalJob,
  isTransportationJobName,
} from "@/lib/jobViews";
import { capLaborMonths, type CapLaborWindow } from "@/lib/capitalizedLabor";

/* ---------------------------------------------------------------------------
   Capitalized-materials candidates. Everything expensed on a non-billable
   job — materials, parts, outside services, rentals, freight — in any
   QuickBooks company may belong in a capital account rather than job cost.
   The page (src/app/(app)/capitalized-materials/), the CSV export
   (src/app/api/export/capitalized-materials/), and the Excel export
   (src/app/api/export/capitalized-materials-workbook/) all read through
   loadCapMaterials (src/lib/capitalizedMaterialsServer.ts) and roll up with
   the helpers here, so the job rule and the math live in one place.

   Which job-cost lines count, and whether each is expensed or already
   capitalized, is decided in SQL by the cap_material_lines view (migration
   0036): bill, purchase and vendor-credit lines that reached an expense
   account, plus non-payroll journal lines on expense accounts. Payroll stays
   on Capitalized Labor, so the two pages never count the same dollar. The
   period is Capitalized Labor's (capLaborPeriod).
--------------------------------------------------------------------------- */

export type CapMaterialBucket = "equipment" | "internal";

export const CAP_MATERIAL_BUCKET_LABELS: Record<CapMaterialBucket, string> = {
  equipment: "Equipment (EQP)",
  internal: "PPS internal",
};

// Non-billable as the Jobs dashboard defines it: internal equipment work
// (EQP…) and Precision Paint's own self-work (its "PPS" customer).
// Transportation jobs are operating work and never qualify — same precedence
// as the Jobs dashboard. Unlike the Jobs tabs, recent activity doesn't
// matter: the period decides which expenses count.
export function capMaterialBucket(j: {
  name: string;
  customerDisplayName?: string | null;
  customerCompanyName?: string | null;
  /** Name of the QuickBooks company (realm) the job was imported from. */
  qbCompanyName?: string | null;
}): CapMaterialBucket | null {
  if (isTransportationJobName(j.name)) return null;
  if (isNonBillableJobName(j.name)) return "equipment";
  if (
    isPpsInternalJob(j.qbCompanyName, j.customerDisplayName) ||
    isPpsInternalJob(j.qbCompanyName, j.customerCompanyName)
  ) {
    return "internal";
  }
  return null;
}

/** A counted line's role (cap_material_lines.treatment). */
export type CapMaterialTreatment = "expensed" | "capitalized";

export const CAP_MATERIAL_TREATMENT_LABELS: Record<CapMaterialTreatment, string> = {
  expensed: "Expensed",
  capitalized: "Capitalized",
};

/** One counted line, as cap_material_lines returns it. */
export interface CapMaterialLine {
  id: string;
  job_id: string;
  /** Bill | Purchase | VendorCredit | JournalEntry */
  qb_txn_type: string;
  qb_txn_id: string;
  qb_doc_number: string | null;
  txn_date: string | null;
  vendor_name: string | null;
  description: string | null;
  /** The account the line posted to, or the item bought on an item line. */
  category: string | null;
  /** job_costs.cost_type: materials | labor | other */
  cost_type: string;
  /** Signed as job cost: refunds, credits and reversals are negative. */
  amount: number;
  treatment: CapMaterialTreatment;
}

/** The cap_material_lines columns every reader selects. */
export const CAP_MATERIAL_LINE_COLUMNS =
  "id, job_id, qb_txn_type, qb_txn_id, qb_doc_number, txn_date, vendor_name, description, category, cost_type, amount, treatment";

/** Rows as PostgREST returns them (numeric can arrive as a string). */
export function parseCapMaterialLines(rows: Record<string, unknown>[]): CapMaterialLine[] {
  return rows.map((r) => ({
    id: r.id as string,
    job_id: r.job_id as string,
    qb_txn_type: r.qb_txn_type as string,
    qb_txn_id: r.qb_txn_id as string,
    qb_doc_number: (r.qb_doc_number as string | null) ?? null,
    txn_date: (r.txn_date as string | null) ?? null,
    vendor_name: (r.vendor_name as string | null) ?? null,
    description: (r.description as string | null) ?? null,
    category: (r.category as string | null) ?? null,
    cost_type: (r.cost_type as string | null) ?? "other",
    amount: Number(r.amount ?? 0),
    treatment: r.treatment === "capitalized" ? "capitalized" : "expensed",
  }));
}

/**
 * A line's contribution to the page's two sums: expensed (net — a refund,
 * vendor credit or reversal nets against it) and already capitalized
 * (stored positive; the capitalizing credit is negative in job cost).
 */
export function capMaterialAmounts(
  treatment: string,
  amount: number,
): { expensed: number; capitalized: number } {
  return treatment === "capitalized"
    ? { expensed: 0, capitalized: -amount }
    : { expensed: amount, capitalized: 0 };
}

// What was expensed, by kind: item lines (the app's materials cost type),
// outside labor a vendor billed (a bill or purchase on a labor item or
// account — payroll itself is on Capitalized Labor), and everything else.
export type CapMaterialKind = "materials" | "outsideLabor" | "other";

export const CAP_MATERIAL_KIND_LABELS: Record<CapMaterialKind, string> = {
  materials: "Materials",
  outsideLabor: "Outside labor",
  other: "Other expenses",
};

export function capMaterialKind(l: {
  qb_txn_type: string;
  cost_type: string;
}): CapMaterialKind {
  if (l.cost_type === "materials") return "materials";
  if (l.cost_type === "labor" && l.qb_txn_type !== "JournalEntry") {
    return "outsideLabor";
  }
  return "other";
}

const SOURCE_LABELS: Record<string, string> = {
  Bill: "Bill",
  Purchase: "Purchase",
  VendorCredit: "Vendor credit",
  JournalEntry: "Journal entry",
};

/** "Bill", "Purchase", "Vendor credit", "Journal entry". */
export function capMaterialSourceLabel(qbTxnType: string): string {
  return SOURCE_LABELS[qbTxnType] ?? qbTxnType;
}

/** The QuickBooks reference a line traces to: its document number, or the
    transaction id when it has none. */
export function capMaterialDocRef(l: {
  qb_doc_number: string | null;
  qb_txn_id: string;
}): string {
  return l.qb_doc_number || `#${l.qb_txn_id}`;
}

/** A non-billable job with its QuickBooks company, ready to display. */
export interface CapMaterialJob {
  id: string;
  name: string;
  realmId: string | null;
  companyName: string | null;
  customerName: string | null;
  bucket: CapMaterialBucket;
}

export interface CapMaterialSums {
  /** Charged to expense, net of refunds, vendor credits and reversals. */
  expensed: number;
  /** Moved to a capital asset by journal entry (stored positive). */
  capitalized: number;
  /** Awaiting review: expensed − capitalized. */
  net: number;
  /** Expensed, by kind (they sum to expensed). */
  materials: number;
  outsideLabor: number;
  other: number;
}

const blankSums = (): CapMaterialSums => ({
  expensed: 0,
  capitalized: 0,
  net: 0,
  materials: 0,
  outsideLabor: 0,
  other: 0,
});

function addLine(s: CapMaterialSums, l: CapMaterialLine) {
  const split = capMaterialAmounts(l.treatment, l.amount);
  s.expensed += split.expensed;
  s.capitalized += split.capitalized;
  s.net = s.expensed - s.capitalized;
  if (split.expensed !== 0) s[capMaterialKind(l)] += split.expensed;
}

function addSums(into: CapMaterialSums, s: CapMaterialSums) {
  into.expensed += s.expensed;
  into.capitalized += s.capitalized;
  into.net = into.expensed - into.capitalized;
  into.materials += s.materials;
  into.outsideLabor += s.outsideLabor;
  into.other += s.other;
}

// A transaction is counted once per job it touches; its id is only unique
// within a QuickBooks company and its type, and a job lives in one company.
const txnKey = (l: CapMaterialLine) => `${l.job_id}:${l.qb_txn_type}:${l.qb_txn_id}`;

export interface CapMaterialJobRow extends CapMaterialJob, CapMaterialSums {
  /** Distinct QuickBooks transactions (bills, purchases, credits, entries). */
  txnCount: number;
  latestDate: string | null;
}

/**
 * One row per job with counted lines in the period, biggest amount awaiting
 * review first. Jobs with nothing in the period aren't listed.
 */
export function capMaterialJobRows(
  jobs: Map<string, CapMaterialJob>,
  lines: CapMaterialLine[],
): CapMaterialJobRow[] {
  const byJob = new Map<
    string,
    { sums: CapMaterialSums; txns: Set<string>; latestDate: string | null }
  >();
  for (const l of lines) {
    if (!jobs.has(l.job_id)) continue;
    let acc = byJob.get(l.job_id);
    if (!acc) {
      acc = { sums: blankSums(), txns: new Set(), latestDate: null };
      byJob.set(l.job_id, acc);
    }
    addLine(acc.sums, l);
    acc.txns.add(txnKey(l));
    if (l.txn_date && (!acc.latestDate || l.txn_date > acc.latestDate)) {
      acc.latestDate = l.txn_date;
    }
  }
  const rows: CapMaterialJobRow[] = [];
  for (const [jobId, acc] of byJob) {
    rows.push({
      ...jobs.get(jobId)!,
      ...acc.sums,
      txnCount: acc.txns.size,
      latestDate: acc.latestDate,
    });
  }
  return rows.sort((a, b) => b.net - a.net || a.name.localeCompare(b.name));
}

export interface CapMaterialRollupRow extends CapMaterialSums {
  /** Jobs with counted lines. */
  jobs: number;
  /** Transactions per job, summed — the Transactions column's definition. */
  txns: number;
}

/** The job rows' totals. */
export function capMaterialTotal(rows: CapMaterialJobRow[]): CapMaterialRollupRow {
  const total = { ...blankSums(), jobs: rows.length, txns: 0 };
  for (const r of rows) {
    addSums(total, r);
    total.txns += r.txnCount;
  }
  return total;
}

/**
 * The job rows rolled up by QuickBooks company — the enterprise-wide view —
 * biggest amount awaiting review first.
 */
export function capMaterialByCompany(
  rows: CapMaterialJobRow[],
): (CapMaterialRollupRow & { realmId: string | null; company: string })[] {
  const byRealm = new Map<
    string,
    CapMaterialRollupRow & { realmId: string | null; company: string }
  >();
  for (const r of rows) {
    const key = r.realmId ?? "";
    let acc = byRealm.get(key);
    if (!acc) {
      acc = {
        ...blankSums(),
        jobs: 0,
        txns: 0,
        realmId: r.realmId,
        company: r.companyName ?? (r.realmId ? `Company ${r.realmId}` : "Unknown company"),
      };
      byRealm.set(key, acc);
    }
    addSums(acc, r);
    acc.jobs += 1;
    acc.txns += r.txnCount;
  }
  return [...byRealm.values()].sort(
    (a, b) => b.net - a.net || a.company.localeCompare(b.company),
  );
}

/**
 * The period's counted lines rolled up by calendar month, for the jobs
 * `include` keeps (the page's tab). Every month of the period gets a row,
 * quiet months included.
 */
export function capMaterialByMonth(
  w: Pick<CapLaborWindow, "fromMonth" | "toMonth">,
  lines: CapMaterialLine[],
  include: (jobId: string) => boolean,
): { rows: (CapMaterialRollupRow & { month: string })[]; total: CapMaterialRollupRow } {
  const blank = () => ({ sums: blankSums(), jobs: new Set<string>(), txns: new Set<string>() });
  const byMonth = new Map(capLaborMonths(w).map((m) => [m, blank()]));
  const total = blank();
  for (const l of lines) {
    if (!include(l.job_id) || !l.txn_date) continue;
    const acc = byMonth.get(l.txn_date.slice(0, 7));
    if (!acc) continue;
    for (const a of [acc, total]) {
      addLine(a.sums, l);
      a.jobs.add(l.job_id);
      // A transaction has one date, so per-month counts sum to the period's.
      a.txns.add(txnKey(l));
    }
  }
  const finish = (a: ReturnType<typeof blank>): CapMaterialRollupRow => ({
    ...a.sums,
    jobs: a.jobs.size,
    txns: a.txns.size,
  });
  return {
    rows: [...byMonth].map(([month, a]) => ({ month, ...finish(a) })),
    total: finish(total),
  };
}

/** A failed load as a banner message: a missing migration says which one. */
export function capMaterialsErrorMessage(message: string): string {
  if (/cap_material_lines|cap_material_account|schema cache|does not exist/i.test(message))
    return "Capitalized Materials needs its database update: run supabase/migrations/0036_capitalized_materials.sql in the Supabase SQL editor, then reload this page.";
  return `Capitalized materials couldn't be loaded: ${message}`;
}
