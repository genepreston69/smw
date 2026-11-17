import { describe, expect, it } from "vitest";
import { decemberFromNovember, respreadTotal, spreadInitiativeLine, type BudgetCell } from "@/lib/budget";
import { buildCategoryStatement, type PivotCell } from "@/lib/financials";

const sum = (v: number[]) => Math.round(v.reduce((s, x) => s + x, 0) * 100) / 100;

describe("budget spreads (budget.ts)", () => {
  it("an initiative line is spread evenly over its months and sums to its amount", () => {
    const months = spreadInitiativeLine({ start_month: 7, end_month: 12 }, 60000);
    expect(months.slice(0, 6)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(months.slice(6)).toEqual([10000, 10000, 10000, 10000, 10000, 10000]);
    expect(sum(spreadInitiativeLine({ start_month: 3, end_month: 9 }, 10000))).toBe(10000);
  });

  it("re-spreading an annual total keeps the months' shape and hits the total to the cent", () => {
    const shape = [100, 200, 300, 0, 0, 0, 0, 0, 0, 0, 0, 400];
    const spread = respreadTotal(shape, 1234.56);
    expect(sum(spread)).toBe(1234.56);
    expect(spread[3]).toBe(0);
    expect(spread[11]).toBeGreaterThan(spread[2]);
    // No shape to follow: spread evenly, still exact.
    expect(sum(respreadTotal(Array(12).fill(0), 1000))).toBe(1000);
  });

  it("December's baseline is November's", () => {
    const cell = (col_key: string, amount: number): BudgetCell => ({
      classification: "Expense",
      account_type: "Expense",
      row_key: "800 Rent",
      col_key,
      amount,
      line_count: 1,
      class_name: "Shop",
    });
    const out = decemberFromNovember([cell("2025-10", 1), cell("2025-11", 2), cell("2025-12", 99)]);
    expect(out.map((c) => [c.col_key, c.amount])).toEqual([
      ["2025-10", 1],
      ["2025-11", 2],
      ["2025-12", 2],
    ]);
  });
});

describe("income statement assembly (buildCategoryStatement)", () => {
  const cell = (classification: string, row_key: string, col_key: string, amount: number): PivotCell => ({
    classification,
    account_type: classification === "Revenue" ? "Income" : "Expense",
    row_key,
    col_key,
    amount,
    line_count: 1,
  });
  const cells = [
    cell("Revenue", "400 Fabrication", "2026-01", 1000),
    cell("Revenue", "410 Repair", "2026-02", 500),
    cell("Expense", "710 Labor Cost", "2026-01", 300),
    cell("Expense", "800 Rent", "2026-01", 100),
    cell("Expense", "800 Rent", "2026-02", 100),
    cell("Expense", "999 Unfiled", "2026-02", 40),
  ];

  it("net income is revenue minus expense however accounts are categorized", () => {
    const expected = { "2026-01": 600, "2026-02": 360 };
    for (const categories of [
      new Map<string, string>(),
      new Map([["710 Labor Cost", "Direct Costs"], ["800 Rent", "Facilities"], ["400 Fabrication", "Sales"]]),
    ]) {
      const s = buildCategoryStatement(cells, categories);
      expect(s.netIncome.cells).toEqual(expected);
      expect(s.netIncome.total).toBe(960);
    }
  });

  it("gross profit appears only when a direct-cost category is assigned", () => {
    expect(buildCategoryStatement(cells, new Map()).grossProfit).toBeNull();
    const s = buildCategoryStatement(cells, new Map([["710 Labor Cost", "Direct Costs"]]));
    expect(s.grossProfit?.total).toBe(1200);
  });
});
