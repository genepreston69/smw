import { describe, expect, it } from "vitest";
import {
  buildCategoryStatement,
  ebitdaAddBackKind,
  type EbitdaKind,
  type PivotCell,
} from "@/lib/financials";

describe("EBITDA add-back accounts (ebitdaAddBackKind)", () => {
  it("reads the QuickBooks detail type first", () => {
    expect(ebitdaAddBackKind({ name: "960 Bank Loan", subType: "InterestPaid" })).toBe("interest");
    expect(ebitdaAddBackKind({ name: "990 Federal", subType: "IncomeTaxExpense" })).toBe("taxes");
    expect(ebitdaAddBackKind({ name: "980 Equipment", subType: "Depreciation" })).toBe("depreciation");
    expect(ebitdaAddBackKind({ name: "985 Goodwill", subType: "Amortization" })).toBe("amortization");
  });

  it("falls back to the account name when the detail type is generic", () => {
    const generic = "OtherMiscellaneousExpense";
    expect(ebitdaAddBackKind({ name: "Other Expense:Interest Expense", subType: generic })).toBe("interest");
    expect(ebitdaAddBackKind({ name: "State Income Taxes", subType: null })).toBe("taxes");
    expect(ebitdaAddBackKind({ name: "980 Depreciation Expense", subType: generic })).toBe("depreciation");
    expect(ebitdaAddBackKind({ name: "Amortisation", subType: null })).toBe("amortization");
    // Combined accounts count once, as the first kind named.
    expect(ebitdaAddBackKind({ name: "Depreciation & Amortization", subType: null })).toBe("depreciation");
  });

  it("does not add back operating taxes or ordinary expenses", () => {
    expect(ebitdaAddBackKind({ name: "Payroll Taxes", subType: "TaxesPaid" })).toBeNull();
    expect(ebitdaAddBackKind({ name: "Property Tax", subType: "TaxesPaid" })).toBeNull();
    expect(ebitdaAddBackKind({ name: "Taxes & Licenses", subType: "TaxesPaid" })).toBeNull();
    expect(ebitdaAddBackKind({ name: "800 Rent", subType: "RentOrLeaseOfBuildings" })).toBeNull();
    expect(ebitdaAddBackKind({ name: "Interesting Supplies", subType: null })).toBeNull();
    // A detail type that only looks like an object key is just unknown.
    expect(ebitdaAddBackKind({ name: "800 Rent", subType: "constructor" })).toBeNull();
  });
});

describe("EBITDA on the income statement (buildCategoryStatement)", () => {
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
    cell("Revenue", "450 Interest Income", "2026-02", 20),
    cell("Expense", "710 Labor Cost", "2026-01", 300),
    cell("Expense", "980 Depreciation", "2026-01", 50),
    cell("Expense", "980 Depreciation", "2026-02", 50),
    cell("Expense", "960 Interest Expense", "2026-02", 30),
    cell("Expense", "970 Payroll Taxes", "2026-01", 25),
  ];
  const addBacks = new Map<string, EbitdaKind>([
    ["980 Depreciation", "depreciation"],
    ["960 Interest Expense", "interest"],
    // Revenue accounts never add back, even if mapped.
    ["450 Interest Income", "interest"],
  ]);

  it("is net income plus interest, taxes, depreciation and amortization", () => {
    const s = buildCategoryStatement(cells, new Map(), addBacks);
    // Net income: 1520 − 455 = 1065; add backs: 100 depreciation + 30 interest.
    expect(s.netIncome.total).toBe(1065);
    expect(s.ebitda?.total.total).toBe(1195);
    expect(s.ebitda?.total.cells).toEqual({ "2026-01": 675, "2026-02": 520 });
  });

  it("lists all four add-backs in order, each with its own accounts", () => {
    const s = buildCategoryStatement(cells, new Map([["980 Depreciation", "Overhead"]]), addBacks);
    const groups = s.ebitda!.addBacks.groups;
    expect(groups.map((g) => g.label)).toEqual(["Interest", "Income taxes", "Depreciation", "Amortization"]);
    expect(groups.map((g) => g.rows.map((r) => r.key))).toEqual([
      ["960 Interest Expense"],
      [],
      ["980 Depreciation"],
      [],
    ]);
    expect(groups.map((g) => g.total)).toEqual([30, 0, 100, 0]);
    expect(s.ebitda!.addBacks.total).toBe(130);
  });

  it("is left off when no add-back accounts are passed (the Budget page)", () => {
    expect(buildCategoryStatement(cells, new Map()).ebitda).toBeNull();
    // Passed but empty: EBITDA shows, equal to net income.
    const s = buildCategoryStatement(cells, new Map(), new Map());
    expect(s.ebitda?.total).toEqual(s.netIncome);
  });
});
