import {
  capLaborMonths,
  type CapLaborBucket,
  type CapLaborWindow,
} from "@/lib/capitalizedLabor";

/* ---------------------------------------------------------------------------
   Capitalized Jobs. The direct cost posted to a job that isn't
   outside-customer work — labor, contract service, fuel & oil, material and
   freight — may belong in a capital account rather than job cost. The page
   (src/app/(app)/capitalized-jobs/), the CSV export
   (src/app/api/export/capitalized-jobs/) and the Excel export
   (src/app/api/export/capitalized-jobs-workbook/) all read through
   loadCapJobs (src/lib/capitalizedJobsServer.ts) and roll up with the helpers
   here, so screen and file always match.

   Which job-cost lines count, which Direct Cost column each lands in, and
   whether it is cost posted or already capitalized, is decided in SQL by the
   cap_job_lines view (migration 0044). Which jobs qualify is capLaborBucket,
   and the period is capLaborPeriod (both in src/lib/capitalizedLabor.ts).
--------------------------------------------------------------------------- */

/** The Direct Cost columns, in the order the page shows them
    (cap_job_lines.kind). */
export const CAP_JOB_KINDS = ["labor", "contract", "fuel", "materials", "freight"] as const;

export type CapJobKind = (typeof CAP_JOB_KINDS)[number];

/** Column headings. */
export const CAP_JOB_KIND_LABELS: Record<CapJobKind, string> = {
  labor: "Labor",
  contract: "Contract service",
  fuel: "Fuel & oil",
  materials: "Material",
  freight: "Freight",
};

/** The Direct Cost account behind each column. */
export const CAP_JOB_KIND_ACCOUNTS: Record<CapJobKind, string> = {
  labor: "710 Labor Cost",
  contract: "720 Contract Service",
  fuel: "839 Fuel & Oil",
  materials: "705 Material Cost",
  freight: "837 Freight",
};

/** A counted line's role (cap_job_lines.treatment). */
export type CapJobTreatment = "posted" | "capitalized";

export const CAP_JOB_TREATMENT_LABELS: Record<CapJobTreatment, string> = {
  posted: "Cost posted",
  capitalized: "Capitalized",
};

/** One counted line, as cap_job_lines returns it. */
export interface CapJobLine {
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
  /** Signed as job cost: refunds, credits and reversals are negative. */
  amount: number;
  kind: CapJobKind;
  treatment: CapJobTreatment;
}

/** The cap_job_lines columns every reader selects. */
export const CAP_JOB_LINE_COLUMNS =
  "id, job_id, qb_txn_type, qb_txn_id, qb_doc_number, txn_date, vendor_name, description, category, amount, kind, treatment";

const isKind = (v: unknown): v is CapJobKind =>
  (CAP_JOB_KINDS as readonly unknown[]).includes(v);

/** Rows as PostgREST returns them (numeric can arrive as a string). */
export function parseCapJobLines(rows: Record<string, unknown>[]): CapJobLine[] {
  return rows.flatMap((r) =>
    isKind(r.kind)
      ? [
          {
            id: r.id as string,
            job_id: r.job_id as string,
            qb_txn_type: r.qb_txn_type as string,
            qb_txn_id: r.qb_txn_id as string,
            qb_doc_number: (r.qb_doc_number as string | null) ?? null,
            txn_date: (r.txn_date as string | null) ?? null,
            vendor_name: (r.vendor_name as string | null) ?? null,
            description: (r.description as string | null) ?? null,
            category: (r.category as string | null) ?? null,
            amount: Number(r.amount ?? 0),
            kind: r.kind,
            treatment: r.treatment === "capitalized" ? "capitalized" : "posted",
          },
        ]
      : [],
  );
}

const SOURCE_LABELS: Record<string, string> = {
  Bill: "Bill",
  Purchase: "Purchase",
  VendorCredit: "Vendor credit",
  JournalEntry: "Journal entry",
};

/** "Bill", "Purchase", "Vendor credit", "Journal entry". */
export function capJobSourceLabel(qbTxnType: string): string {
  return SOURCE_LABELS[qbTxnType] ?? qbTxnType;
}

/** The QuickBooks reference a line traces to: its document number, or the
    transaction id when it has none. */
export function capJobDocRef(l: { qb_doc_number: string | null; qb_txn_id: string }): string {
  return l.qb_doc_number || `#${l.qb_txn_id}`;
}

/** A candidate job with its QuickBooks company, ready to display. */
export interface CapJob {
  id: string;
  name: string;
  realmId: string | null;
  companyName: string | null;
  customerName: string | null;
  bucket: CapLaborBucket;
}

/** One job-month of the benefit allocation cache. */
export interface CapJobBenefit {
  job_id: string;
  month: string;
  amount: number | string | null;
}

/**
 * The page's sums. Each Direct Cost column is cost posted, net of refunds,
 * vendor credits and reversals; they add up to `posted`.
 */
export interface CapJobSums extends Record<CapJobKind, number> {
  posted: number;
  /** Moved to a capital asset by journal entry (stored positive; the
      capitalizing credit is negative in job cost). */
  capitalized: number;
  /** Awaiting review: posted − capitalized. */
  net: number;
}

export const blankCapJobSums = (): CapJobSums => ({
  labor: 0,
  contract: 0,
  fuel: 0,
  materials: 0,
  freight: 0,
  posted: 0,
  capitalized: 0,
  net: 0,
});

/** Adds one line to the sums: a capitalized line is credited off whatever
    its account, every other line is cost posted in its own column. */
export function addCapJobLine(
  s: CapJobSums,
  l: Pick<CapJobLine, "kind" | "treatment" | "amount">,
): void {
  if (l.treatment === "capitalized") {
    s.capitalized -= l.amount;
  } else {
    s[l.kind] += l.amount;
    s.posted += l.amount;
  }
  s.net = s.posted - s.capitalized;
}

function addSums(into: CapJobSums, s: CapJobSums) {
  for (const k of CAP_JOB_KINDS) into[k] += s[k];
  into.posted += s.posted;
  into.capitalized += s.capitalized;
  into.net = into.posted - into.capitalized;
}

// A transaction is counted once per job it touches; its id is only unique
// within a QuickBooks company and its type, and a job lives in one company.
const txnKey = (l: CapJobLine) => `${l.job_id}:${l.qb_txn_type}:${l.qb_txn_id}`;

export interface CapJobRow extends CapJob, CapJobSums {
  /** Distinct QuickBooks transactions (bills, purchases, credits, entries). */
  txnCount: number;
  latestDate: string | null;
  /** Direct-labor share of Employee Benefits allocated to the job over the
      period's months; null when nothing was allocated. */
  benefitAllocation: number | null;
}

/**
 * One row per candidate job with counted lines in the period, biggest amount
 * awaiting review first. Jobs with nothing in the period aren't listed.
 */
export function capJobRows(
  jobs: Map<string, CapJob>,
  lines: CapJobLine[],
  benefits: CapJobBenefit[],
): CapJobRow[] {
  const benefitByJob = new Map<string, number>();
  for (const b of benefits) {
    benefitByJob.set(b.job_id, (benefitByJob.get(b.job_id) ?? 0) + Number(b.amount ?? 0));
  }
  const byJob = new Map<
    string,
    { sums: CapJobSums; txns: Set<string>; latestDate: string | null }
  >();
  for (const l of lines) {
    if (!jobs.has(l.job_id)) continue;
    let acc = byJob.get(l.job_id);
    if (!acc) {
      acc = { sums: blankCapJobSums(), txns: new Set(), latestDate: null };
      byJob.set(l.job_id, acc);
    }
    addCapJobLine(acc.sums, l);
    acc.txns.add(txnKey(l));
    if (l.txn_date && (!acc.latestDate || l.txn_date > acc.latestDate)) {
      acc.latestDate = l.txn_date;
    }
  }
  const rows: CapJobRow[] = [];
  for (const [jobId, acc] of byJob) {
    rows.push({
      ...jobs.get(jobId)!,
      ...acc.sums,
      txnCount: acc.txns.size,
      latestDate: acc.latestDate,
      benefitAllocation: benefitByJob.get(jobId) ?? null,
    });
  }
  return rows.sort((a, b) => b.net - a.net || a.name.localeCompare(b.name));
}

export interface CapJobRollup extends CapJobSums {
  /** Jobs with counted lines. */
  jobs: number;
  /** Transactions per job, summed — the Transactions column's definition. */
  txns: number;
  /** Benefit allocation booked to those jobs. */
  benefits: number;
}

/** The job rows' totals. */
export function capJobTotal(rows: CapJobRow[]): CapJobRollup {
  const total: CapJobRollup = { ...blankCapJobSums(), jobs: rows.length, txns: 0, benefits: 0 };
  for (const r of rows) {
    addSums(total, r);
    total.txns += r.txnCount;
    total.benefits += r.benefitAllocation ?? 0;
  }
  return total;
}

/**
 * The period's counted lines and benefit allocation rolled up by calendar
 * month, for the jobs `include` keeps (the page's tab). Every month of the
 * period gets a row, quiet months included.
 */
export function capJobsByMonth(
  w: Pick<CapLaborWindow, "fromMonth" | "toMonth">,
  lines: CapJobLine[],
  benefits: CapJobBenefit[],
  include: (jobId: string) => boolean,
): { rows: (CapJobRollup & { month: string })[]; total: CapJobRollup } {
  const blank = () => ({
    sums: blankCapJobSums(),
    jobs: new Set<string>(),
    txns: new Set<string>(),
    benefits: 0,
  });
  const byMonth = new Map(capLaborMonths(w).map((m) => [m, blank()]));
  const total = blank();
  for (const l of lines) {
    if (!include(l.job_id) || !l.txn_date) continue;
    const acc = byMonth.get(l.txn_date.slice(0, 7));
    if (!acc) continue;
    for (const a of [acc, total]) {
      addCapJobLine(a.sums, l);
      a.jobs.add(l.job_id);
      // A transaction has one date, so per-month counts sum to the period's.
      a.txns.add(txnKey(l));
    }
  }
  for (const b of benefits) {
    if (!include(b.job_id)) continue;
    const acc = byMonth.get(b.month.slice(0, 7));
    if (!acc) continue;
    const amount = Number(b.amount ?? 0);
    acc.benefits += amount;
    total.benefits += amount;
  }
  const finish = (a: ReturnType<typeof blank>): CapJobRollup => ({
    ...a.sums,
    jobs: a.jobs.size,
    txns: a.txns.size,
    benefits: a.benefits,
  });
  return {
    rows: [...byMonth].map(([month, a]) => ({ month, ...finish(a) })),
    total: finish(total),
  };
}

/** A failed load as a banner message: a missing migration says which one. */
export function capJobsErrorMessage(message: string): string {
  if (/cap_job_|schema cache|does not exist/i.test(message))
    return "Capitalized Jobs needs its database update: run supabase/migrations/0044_capitalized_jobs.sql in the Supabase SQL editor, then reload this page.";
  return `Capitalized jobs couldn't be loaded: ${message}`;
}
