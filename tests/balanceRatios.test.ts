import { describe, expect, it } from "vitest";
import {
  COMBINED,
  mergeBalanceSheets,
  parseBalanceSheetReport,
  type BsReport,
} from "@/lib/balanceSheet";
import {
  balanceFigures,
  balanceRatios,
  daysInPeriod,
  monthsInPeriod,
  multiple,
  returnRatios,
} from "@/lib/balanceRatios";

// QuickBooks' BalanceSheet report, cut down to the sections the ratios read.
const data = (name: string, amount: number) => ({
  type: "Data",
  ColData: [{ value: name, id: name }, { value: amount.toFixed(2) }],
});
const section = (label: string, total: number, rows: object[], group?: string) => ({
  type: "Section",
  group,
  Header: { ColData: [{ value: label }, { value: "" }] },
  Rows: { Row: rows },
  Summary: { ColData: [{ value: `Total ${label}` }, { value: total.toFixed(2) }] },
});

interface Sheet {
  cash: number;
  ar: number;
  inventory: number;
  fixed: number;
  ap: number;
  longTerm: number;
}
function report(s: Sheet, opts: { groups?: boolean } = {}): BsReport {
  const g = (name: string) => (opts.groups === false ? undefined : name);
  const current = s.cash + s.ar + s.inventory;
  const assets = current + s.fixed;
  const liabilities = s.ap + s.longTerm;
  const equity = assets - liabilities;
  return {
    Header: { EndPeriod: "2026-10-31" },
    Rows: {
      Row: [
        section(
          "ASSETS",
          assets,
          [
            section(
              "Current Assets",
              current,
              [
                section("Bank Accounts", s.cash, [data("Checking", s.cash)], g("BankAccounts")),
                section("Accounts Receivable", s.ar, [data("Accounts Receivable", s.ar)], g("AR")),
                section(
                  "Other Current Assets",
                  s.inventory,
                  [data("Inventory", s.inventory)],
                  g("OtherCurrentAssets"),
                ),
              ],
              g("CurrentAssets"),
            ),
            section("Fixed Assets", s.fixed, [data("Equipment", s.fixed)], g("FixedAssets")),
          ],
          g("TotalAssets"),
        ),
        section(
          "LIABILITIES AND EQUITY",
          assets,
          [
            section(
              "Liabilities",
              liabilities,
              [
                section(
                  "Current Liabilities",
                  s.ap,
                  [section("Accounts Payable", s.ap, [data("Accounts Payable", s.ap)], g("AP"))],
                  g("CurrentLiabilities"),
                ),
                section(
                  "Long-Term Liabilities",
                  s.longTerm,
                  [data("Note Payable", s.longTerm)],
                  g("LongTermLiabilities"),
                ),
              ],
              g("Liabilities"),
            ),
            section("Equity", equity, [data("Retained Earnings", equity)], g("Equity")),
          ],
          g("TotalLiabilitiesAndEquity"),
        ),
      ],
    },
  };
}
const nodes = (s: Sheet, opts?: { groups?: boolean }) =>
  parseBalanceSheetReport(report(s, opts), "2026-10-31").nodes;

const A: Sheet = { cash: 300, ar: 500, inventory: 200, fixed: 1000, ap: 400, longTerm: 600 };

describe("balanceFigures", () => {
  it("reads QuickBooks' own section totals", () => {
    const lines = mergeBalanceSheets([{ key: "A", nodes: nodes(A) }]);
    expect(balanceFigures(lines, "A")).toEqual({
      cash: 300,
      receivables: 500,
      currentAssets: 1000,
      totalAssets: 2000,
      currentLiabilities: 400,
      totalLiabilities: 1000,
      equity: 1000,
    });
  });

  it("finds the sections by label when a report carries no group names", () => {
    const lines = mergeBalanceSheets([{ key: "A", nodes: nodes(A, { groups: false }) }]);
    expect(balanceFigures(lines, "A")).toMatchObject({
      cash: 300,
      receivables: 500,
      currentLiabilities: 400,
      equity: 1000,
    });
  });

  it("Combined is the plain sum of the companies", () => {
    const B: Sheet = { cash: 100, ar: 0, inventory: 0, fixed: 50, ap: 200, longTerm: 0 };
    const lines = mergeBalanceSheets([
      { key: "A", nodes: nodes(A) },
      { key: "B", nodes: nodes(B) },
    ]);
    expect(balanceFigures(lines, COMBINED)).toMatchObject({
      cash: 400,
      currentAssets: 1100,
      totalAssets: 2150,
      currentLiabilities: 600,
      equity: 950,
    });
    expect(balanceFigures(lines, "B")).toMatchObject({ cash: 100, equity: -50 });
  });

  it("a column with no balance sheet has no figures", () => {
    const lines = mergeBalanceSheets([{ key: "A", nodes: nodes(A) }]);
    expect(balanceFigures(lines, "B")).toBeNull();
    expect(balanceFigures([], "A")).toBeNull();
  });
});

describe("balanceRatios", () => {
  const f = balanceFigures(mergeBalanceSheets([{ key: "A", nodes: nodes(A) }]), "A")!;

  it("liquidity and leverage", () => {
    expect(balanceRatios(f)).toEqual({
      workingCapital: 600,
      currentRatio: 2.5,
      quickRatio: 2, // inventory is left out
      debtToEquity: 1,
      debtToAssets: 0.5,
    });
  });

  it("states no ratio over a zero or negative base", () => {
    const r = balanceRatios({ ...f, currentLiabilities: 0, equity: -250 });
    expect(r.currentRatio).toBeNull();
    expect(r.quickRatio).toBeNull();
    expect(r.debtToEquity).toBeNull();
    expect(r.workingCapital).toBe(1000);
    expect(multiple(r.currentRatio)).toBe("—");
    expect(multiple(2.5)).toBe("2.50×");
  });
});

describe("returnRatios", () => {
  const f = balanceFigures(mergeBalanceSheets([{ key: "A", nodes: nodes(A) }]), "A")!;

  it("counts the period's months and days", () => {
    expect(monthsInPeriod("2026-01", "2026-10")).toBe(10);
    expect(monthsInPeriod("2025-11", "2026-02")).toBe(4);
    expect(daysInPeriod("2026-01", "2026-01")).toBe(31);
    expect(daysInPeriod("2024-02", "2024-03")).toBe(60); // leap February
  });

  it("restates net income to an annual rate and uses period-end balances", () => {
    const r = returnRatios(
      { revenue: 3040, netIncome: 100, from: "2026-01", to: "2026-10" },
      f,
    );
    expect(r.returnOnAssets).toBeCloseTo(0.06); // 100 × 12/10 ÷ 2000
    expect(r.returnOnEquity).toBeCloseTo(0.12);
    expect(r.daysSalesOutstanding).toBeCloseTo(50); // 500 ÷ (3040 ÷ 304 days)
  });

  it("has no days sales outstanding without revenue, no return on negative equity", () => {
    const r = returnRatios(
      { revenue: 0, netIncome: 100, from: "2026-10", to: "2026-10" },
      { ...f, equity: -1 },
    );
    expect(r.daysSalesOutstanding).toBeNull();
    expect(r.returnOnEquity).toBeNull();
    expect(r.returnOnAssets).toBeCloseTo(0.6);
  });
});
