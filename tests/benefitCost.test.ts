import { describe, expect, it } from "vitest";
import {
  benefitCostByClass,
  benefitFormula,
  benefitLineFor,
  buildBenefitCost,
  laborBaseNumber,
  type BenefitCell,
} from "@/lib/benefitCost";
import { DEFAULT_SETTINGS } from "@/lib/appSettings";

const bases = DEFAULT_SETTINGS.benefitBaseAccounts;
const cell = (line: string, month: string, amount: number, cls = "Shop"): BenefitCell => ({
  line,
  account: line,
  month,
  amount,
  cls,
});

describe("Cost of Benefits (benefitCost.ts)", () => {
  it("matches base accounts by leading account number, sub-accounts included", () => {
    expect(laborBaseNumber("710 Labor Cost", bases)).toBe("710");
    expect(laborBaseNumber("935 Salaries & Wages:Office", bases)).toBe("935");
    expect(laborBaseNumber("Payroll:934 Labor Maint", bases)).toBe("934");
    // A longer number that merely starts with the digits is a different account.
    expect(laborBaseNumber("7100 Other", bases)).toBeNull();
    expect(laborBaseNumber("9350 Other", bases)).toBeNull();
    expect(laborBaseNumber("840 Insurance", bases)).toBeNull();
  });

  it("an Employee Benefits account is never also in the base", () => {
    expect(benefitLineFor("935 Salaries & Wages:Health", "employee  benefits", bases)).toBe(
      "benefits",
    );
    expect(benefitLineFor("935 Salaries & Wages:Health", null, bases)).toBe("935");
    expect(benefitLineFor("400 Revenue", "Sales", bases)).toBeNull();
  });

  it("follows the base accounts it is given", () => {
    const custom = [...bases, { number: "840", label: "840 Insurance" }];
    expect(laborBaseNumber("840 Insurance:Liability", custom)).toBe("840");
    expect(benefitFormula(custom)).toContain("840 Insurance");
  });

  it("rate is period benefits ÷ period base, with a dash where there is no base", () => {
    const cost = buildBenefitCost(
      [
        cell("benefits", "2026-01", 300),
        cell("710", "2026-01", 600),
        cell("935", "2026-01", 300),
        cell("934", "2026-01", 100),
        cell("benefits", "2026-02", 50),
      ],
      bases,
    );
    expect(cost.colKeys).toEqual(["2026-01", "2026-02"]);
    expect(cost.rate.cells["2026-01"]).toBeCloseTo(0.3, 12);
    expect(cost.rate.cells["2026-02"]).toBeNull();
    expect(cost.laborTotal.total).toBe(1000);
    expect(cost.rate.total).toBeCloseTo(0.35, 12); // 350 ÷ 1000, not the mean of the months
  });

  it("classes add up to All classes exactly", () => {
    const cells = [
      cell("benefits", "2026-01", 300.1, "Shop"),
      cell("benefits", "2026-01", 100.2, "(no class)"),
      cell("710", "2026-01", 600.3, "Shop"),
      cell("935", "2026-02", 400.4, "Office"),
    ];
    const all = buildBenefitCost(cells, bases);
    const byClass = benefitCostByClass(cells, ["Office", "Shop", "(no class)"], bases);
    const sum = (f: (r: (typeof byClass)[number]) => number) =>
      Math.round(byClass.reduce((s, r) => s + f(r), 0) * 100) / 100;
    expect(sum((r) => r.benefits)).toBe(all.benefits.total);
    expect(sum((r) => r.laborTotal)).toBe(all.laborTotal.total);
  });
});
