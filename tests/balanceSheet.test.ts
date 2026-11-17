import { describe, expect, it } from "vitest";
import {
  COMBINED,
  balanceSheetAsOf,
  flattenBalanceSheet,
  isMonthEnd,
  isMonthRollover,
  mergeBalanceSheets,
  parseBalanceSheetReport,
  priorMonthEnd,
  type BsReport,
} from "@/lib/balanceSheet";
import { localClock } from "@/lib/qbSyncSchedule";

// The shape QuickBooks' BalanceSheet report comes back in, cut down.
const data = (name: string, amount: string, id = name) => ({
  type: "Data",
  ColData: [{ value: name, id }, { value: amount }],
});
const section = (
  label: string,
  total: string,
  rows: object[],
  group?: string,
  own = "",
) => ({
  type: "Section",
  group,
  Header: { ColData: [{ value: label }, { value: own }] },
  Rows: { Row: rows },
  Summary: { ColData: [{ value: `Total ${label}` }, { value: total }] },
});
const report = (cash: string, equity: string, extraAsset?: object): BsReport => ({
  Header: { EndPeriod: "2026-10-31" },
  Rows: {
    Row: [
      section(
        "ASSETS",
        cash,
        [
          section(
            "Current Assets",
            cash,
            [data("Checking", cash, "35"), ...(extraAsset ? [extraAsset] : [])],
            "CurrentAssets",
          ),
        ],
        "TotalAssets",
      ),
      section(
        "LIABILITIES AND EQUITY",
        cash,
        [
          section("Liabilities", "400.00", [data("Accounts Payable", "400.00")], "Liabilities"),
          section("Equity", equity, [{ ...data("Net Income", equity), group: "NetIncome" }], "Equity"),
        ],
        "TotalLiabilitiesAndEquity",
      ),
    ],
  },
});

describe("parseBalanceSheetReport", () => {
  it("reads sections, accounts and QuickBooks' own totals", () => {
    const parsed = parseBalanceSheetReport(report("1000.00", "600.00"), "2026-10-31");
    expect(parsed.totalAssets).toBe(1000);
    expect(parsed.totalLiabilitiesAndEquity).toBe(1000);
    expect(parsed.accounts).toBe(3);
    const current = parsed.nodes[0].children[0];
    expect(current).toMatchObject({ label: "Current Assets", total: 1000, own: null });
    expect(current.children[0]).toMatchObject({ label: "Checking", id: "35", own: 1000 });
  });

  it("refuses a report for another date, one that is out of balance, or an unknown layout", () => {
    expect(() => parseBalanceSheetReport(report("1000.00", "600.00"), "2026-09-30")).toThrow(
      /as of 2026-10-31/,
    );
    const lopsided = report("1000.00", "600.00");
    lopsided.Rows!.Row![1].Summary!.ColData![1].value = "990.00";
    expect(() => parseBalanceSheetReport(lopsided, "2026-10-31")).toThrow(/does not balance/);
    expect(() =>
      parseBalanceSheetReport({ Rows: { Row: [data("Something", "1.00")] } }, "2026-10-31"),
    ).toThrow(/expected layout/);
  });

  it("an empty report is a company with nothing posted", () => {
    expect(parseBalanceSheetReport({ Rows: {} }, "2026-10-31")).toMatchObject({
      nodes: [],
      totalAssets: 0,
    });
  });
});

describe("mergeBalanceSheets", () => {
  const a = parseBalanceSheetReport(report("1000.00", "600.00"), "2026-10-31").nodes;
  // The second company has an account the first lacks, and no Checking total change.
  const bReport = report("250.50", "-149.50", data("Savings", "0.00"));
  const b = parseBalanceSheetReport(bReport, "2026-10-31").nodes;

  it("one company has no Combined column", () => {
    const rows = flattenBalanceSheet(mergeBalanceSheets([{ key: "A", nodes: a }]));
    expect(rows.find((r) => r.label === "Checking")?.amounts).toEqual({ A: 1000 });
  });

  it("matches lines by name, keeps each company's order, and sums across", () => {
    const rows = flattenBalanceSheet(
      mergeBalanceSheets([
        { key: "A", nodes: a },
        { key: "B", nodes: b },
      ]),
    );
    expect(rows.map((r) => `${r.kind}:${r.label}`).slice(0, 5)).toEqual([
      "section:ASSETS",
      "section:Current Assets",
      "account:Checking",
      "account:Savings",
      "total:Total Current Assets",
    ]);
    expect(rows.find((r) => r.label === "Checking")?.amounts).toEqual({
      A: 1000,
      B: 250.5,
      [COMBINED]: 1250.5,
    });
    // Only B has Savings: A's cell stays blank, Combined is B's.
    expect(rows.find((r) => r.label === "Savings")?.amounts).toEqual({ B: 0, [COMBINED]: 0 });
    expect(rows.find((r) => r.label === "Total ASSETS")?.amounts[COMBINED]).toBe(1250.5);
    expect(rows.find((r) => r.label === "Total Equity")?.amounts[COMBINED]).toBe(450.5);
  });

  it("the combined halves still balance", () => {
    const rows = flattenBalanceSheet(
      mergeBalanceSheets([
        { key: "A", nodes: a },
        { key: "B", nodes: b },
      ]),
    );
    const total = (label: string) => rows.find((r) => r.label === label)!.amounts[COMBINED];
    expect(total("Total ASSETS")).toBe(total("Total LIABILITIES AND EQUITY"));
  });
});

describe("which month the Balance Sheet shows", () => {
  it("is the month before today's, including across a year end and a leap day", () => {
    expect(priorMonthEnd("2026-11-17")).toBe("2026-10-31");
    expect(priorMonthEnd("2026-11-01")).toBe("2026-10-31");
    expect(priorMonthEnd("2026-11-30")).toBe("2026-10-31");
    expect(priorMonthEnd("2027-01-01")).toBe("2026-12-31");
    expect(priorMonthEnd("2028-03-15")).toBe("2028-02-29");
  });

  it("moves on at midnight local time when the month ends", () => {
    // 11:59 PM on Nov 30 in New York (EST) still shows October…
    const before = localClock(new Date("2026-12-01T04:59:00Z"), "America/New_York");
    expect(priorMonthEnd(before.date)).toBe("2026-10-31");
    expect(isMonthRollover(before)).toBe(false);
    // …and midnight shows November, with the month-end pull due.
    const after = localClock(new Date("2026-12-01T05:00:00Z"), "America/New_York");
    expect(priorMonthEnd(after.date)).toBe("2026-11-30");
    expect(isMonthRollover(after)).toBe(true);
    // Under daylight time midnight is 04:00 UTC.
    expect(isMonthRollover(localClock(new Date("2026-07-01T04:00:00Z"), "America/New_York"))).toBe(true);
  });

  it("the pull starts only in the first hours of the 1st", () => {
    expect(isMonthRollover({ date: "2026-12-01", hour: 2 })).toBe(true);
    expect(isMonthRollover({ date: "2026-12-01", hour: 3 })).toBe(false);
    expect(isMonthRollover({ date: "2026-12-02", hour: 0 })).toBe(false);
  });

  it("?asOf= must be a real month end no later than the prior month", () => {
    const today = "2026-11-17";
    expect(balanceSheetAsOf(null, today)).toBe("2026-10-31");
    expect(balanceSheetAsOf("2026-06-30", today)).toBe("2026-06-30");
    for (const bad of ["2026-11-30", "2026-06-29", "2026-02-30", "june", ""]) {
      expect(balanceSheetAsOf(bad, today)).toBe("2026-10-31");
    }
    expect(isMonthEnd("2028-02-29")).toBe(true);
    expect(isMonthEnd("2027-02-29")).toBe(false);
  });
});
