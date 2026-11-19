import { describe, expect, it } from "vitest";
import {
  capJobRows,
  capJobTotal,
  capJobsByMonth,
  capJobsErrorMessage,
  parseCapJobLines,
  CAP_JOB_KINDS,
  type CapJob,
  type CapJobLine,
} from "@/lib/capitalizedJobs";

const job = (id: string, bucket: CapJob["bucket"] = "nonbillable"): CapJob => ({
  id,
  name: `EQP-${id}`,
  realmId: "r1",
  companyName: "Superior Marine Ways",
  customerName: null,
  bucket,
});

let n = 0;
const line = (over: Partial<CapJobLine>): CapJobLine => ({
  id: `l${++n}`,
  job_id: "a",
  qb_txn_type: "Bill",
  qb_txn_id: `t${n}`,
  qb_doc_number: null,
  txn_date: "2026-03-10",
  vendor_name: null,
  description: null,
  category: null,
  amount: 0,
  kind: "materials",
  treatment: "posted",
  ...over,
});

const jobs = new Map([["a", job("a")], ["b", job("b", "intercompany")]]);

const lines: CapJobLine[] = [
  line({ kind: "labor", qb_txn_type: "JournalEntry", qb_txn_id: "je1", amount: 1000 }),
  line({ kind: "labor", qb_txn_type: "JournalEntry", qb_txn_id: "je1", amount: 200 }),
  line({ kind: "materials", amount: 500 }),
  line({ kind: "materials", qb_txn_type: "VendorCredit", amount: -50 }),
  line({ kind: "contract", amount: 300, txn_date: "2026-04-02" }),
  line({ kind: "fuel", amount: 40, txn_date: "2026-04-02" }),
  line({ kind: "freight", amount: 60, txn_date: "2026-04-02" }),
  // The capitalizing entry credits labor and material off to an asset.
  line({ kind: "labor", qb_txn_type: "JournalEntry", qb_txn_id: "je2", amount: -900, treatment: "capitalized", txn_date: "2026-04-30" }),
  line({ kind: "materials", qb_txn_type: "JournalEntry", qb_txn_id: "je2", amount: -100, treatment: "capitalized", txn_date: "2026-04-30" }),
  line({ job_id: "b", kind: "labor", qb_txn_type: "JournalEntry", amount: 700 }),
  // A job that isn't a candidate is never listed.
  line({ job_id: "customer-work", kind: "materials", amount: 9999 }),
];
const benefits = [
  { job_id: "a", month: "2026-03-01", amount: "25.5" },
  { job_id: "a", month: "2026-04-01", amount: 10 },
];

describe("Capitalized Jobs rollups", () => {
  const rows = capJobRows(jobs, lines, benefits);

  it("puts each line in its Direct Cost column and nets credits", () => {
    const a = rows.find((r) => r.id === "a")!;
    expect(a).toMatchObject({
      labor: 1200,
      contract: 300,
      fuel: 40,
      materials: 450,
      freight: 60,
      posted: 2050,
      capitalized: 1000,
      net: 1050,
      benefitAllocation: 35.5,
      latestDate: "2026-04-30",
    });
    // je1 has two lines on the job but is one transaction.
    expect(a.txnCount).toBe(7);
  });

  it("lists only candidate jobs, biggest amount awaiting review first", () => {
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(rows[1].benefitAllocation).toBeNull();
  });

  it("the columns always add up to total cost", () => {
    for (const r of [...rows, capJobTotal(rows)]) {
      expect(CAP_JOB_KINDS.reduce((s, k) => s + r[k], 0)).toBeCloseTo(r.posted);
      expect(r.net).toBeCloseTo(r.posted - r.capitalized);
    }
  });

  it("the by-month breakdown ties to the job rows", () => {
    const total = capJobTotal(rows);
    const byMonth = capJobsByMonth(
      { fromMonth: "2026-01", toMonth: "2026-04" },
      lines,
      benefits,
      (id) => jobs.has(id),
    );
    expect(byMonth.rows.map((m) => m.month)).toEqual(["2026-01", "2026-02", "2026-03", "2026-04"]);
    expect(byMonth.rows[0]).toMatchObject({ jobs: 0, txns: 0, posted: 0 });
    expect(byMonth.rows[2]).toMatchObject({ labor: 1900, materials: 450, posted: 2350, capitalized: 0, benefits: 25.5 });
    expect(byMonth.rows[3]).toMatchObject({ contract: 300, fuel: 40, freight: 60, capitalized: 1000, net: -600 });
    for (const k of [...CAP_JOB_KINDS, "posted", "capitalized", "net", "txns", "benefits"] as const) {
      expect(byMonth.total[k]).toBeCloseTo(total[k]);
    }
    expect(byMonth.total.jobs).toBe(2);
  });

  it("parses API rows and drops a line with no Direct Cost column", () => {
    const parsed = parseCapJobLines([
      { id: "1", job_id: "a", qb_txn_type: "Bill", qb_txn_id: "9", amount: "12.50", kind: "freight", treatment: "posted" },
      { id: "2", job_id: "a", qb_txn_type: "Bill", qb_txn_id: "9", amount: "1", kind: "rent", treatment: "posted" },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ amount: 12.5, kind: "freight", treatment: "posted" });
  });

  it("a missing migration is named", () => {
    expect(capJobsErrorMessage('relation "public.cap_job_lines" does not exist')).toMatch(/0044_capitalized_jobs\.sql/);
    expect(capJobsErrorMessage("timeout")).toBe("Capitalized jobs couldn't be loaded: timeout");
  });
});
