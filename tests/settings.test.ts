import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, SETTING_SCHEMAS, settingsFromRows } from "@/lib/appSettings";

describe("business rule settings (appSettings.ts)", () => {
  it("uses the defaults when nothing is stored", () => {
    expect(settingsFromRows([])).toEqual(DEFAULT_SETTINGS);
  });

  it("the defaults pass their own validation", () => {
    expect(SETTING_SCHEMAS.budget_year.safeParse(DEFAULT_SETTINGS.budgetYear).success).toBe(true);
    expect(SETTING_SCHEMAS.benefit_base_accounts.safeParse(DEFAULT_SETTINGS.benefitBaseAccounts).success).toBe(true);
    expect(SETTING_SCHEMAS.intercompany_names.safeParse(DEFAULT_SETTINGS.intercompany).success).toBe(true);
  });

  it("reads stored values and lower-cases the sister-company list", () => {
    const s = settingsFromRows([
      { key: "budget_year", value: 2028 },
      { key: "intercompany_names", value: { phrases: ["River Fleet"], acronyms: ["RFC"] } },
    ]);
    expect(s.budgetYear).toBe(2028);
    expect(s.intercompany).toEqual({ phrases: ["river fleet"], acronyms: ["rfc"] });
    expect(s.benefitBaseAccounts).toEqual(DEFAULT_SETTINGS.benefitBaseAccounts);
  });

  it("falls back to the default for a value that doesn't validate", () => {
    const s = settingsFromRows([
      { key: "budget_year", value: "next year" },
      { key: "benefit_base_accounts", value: [{ number: "710", label: "A" }, { number: "710", label: "B" }] },
      { key: "intercompany_names", value: { phrases: [], acronyms: ["s m w"] } },
    ]);
    expect(s).toEqual(DEFAULT_SETTINGS);
  });
});
