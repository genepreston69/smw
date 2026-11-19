import { describe, expect, it } from "vitest";
import { classifyJobView } from "@/lib/jobViews";
import { capLaborBucket } from "@/lib/capitalizedLabor";
import { isEnterpriseName } from "@/lib/enterprise";
import { DEFAULT_SETTINGS } from "@/lib/appSettings";
import { NO_TXN_CUTOFF } from "@/lib/businessRules";

const rules = DEFAULT_SETTINGS.intercompany;
const recent = NO_TXN_CUTOFF;
const job = (over: Partial<Parameters<typeof classifyJobView>[0]>) => ({
  name: "24-1001",
  customerDisplayName: "Acme Towing",
  customerCompanyName: null,
  qbCompanyName: "Superior Marine Ways",
  latestTxnDate: recent,
  ...over,
});

describe("sister-company matching (enterprise.ts)", () => {
  it("matches names as substrings and abbreviations as whole words", () => {
    expect(isEnterpriseName("Superior Marine Inc.", rules)).toBe(true);
    expect(isEnterpriseName("SMW LLC", rules)).toBe(true);
    expect(isEnterpriseName("Smwright Supply", rules)).toBe(false);
    expect(isEnterpriseName("Acme Towing", rules)).toBe(false);
    expect(isEnterpriseName(null, rules)).toBe(false);
  });

  it("follows the list it is given", () => {
    const custom = { phrases: ["river fleet"], acronyms: ["rfc"] };
    expect(isEnterpriseName("River Fleet Co", custom)).toBe(true);
    expect(isEnterpriseName("Superior Marine Inc.", custom)).toBe(false);
  });
});

describe("Jobs dashboard views (jobViews.ts)", () => {
  // Every job lands in exactly one view; these are the precedence rules.
  const cases: [string, Parameters<typeof job>[0], string][] = [
    ["an ordinary customer job", {}, "customer"],
    ["a transportation suffix", { name: "24-1001LH" }, "transportation"],
    ["transportation wins over a sister-company customer", { name: "24-1001BC", customerDisplayName: "SMW" }, "transportation"],
    ["transportation wins over no activity", { name: "24-1001FL", latestTxnDate: null }, "transportation"],
    ["no activity since the cutoff", { latestTxnDate: "2024-12-31" }, "notransactions"],
    ["never any activity", { latestTxnDate: null }, "notransactions"],
    ["no activity wins over EQP", { name: "EQP-12", latestTxnDate: null }, "notransactions"],
    ["Army Corps stays a customer job without activity", { customerDisplayName: "US Army Corps of Engineers", latestTxnDate: null }, "customer"],
    ["an EQP job", { name: "EQP-12" }, "nonbillable"],
    ["Precision Paint's own PPS work", { qbCompanyName: "Precision Paint Services", customerDisplayName: "PPS" }, "nonbillable"],
    ["PPS outside Precision Paint is a customer", { customerDisplayName: "PPS" }, "customer"],
    ["a sister-company customer", { customerDisplayName: "Inland River Dredging Co" }, "intercompany"],
    ["a sister company by company name", { customerCompanyName: "IRDC" }, "intercompany"],
    ["EQP wins over a sister-company customer", { name: "EQP-9", customerDisplayName: "SMW" }, "nonbillable"],
  ];
  it.each(cases)("%s", (_label, over, view) => {
    expect(classifyJobView(job(over), rules)).toBe(view);
  });
});

describe("Capitalized Jobs candidates (capLaborBucket)", () => {
  it("buckets like the Jobs dashboard, minus the recency test", () => {
    expect(capLaborBucket({ name: "EQP-12" }, rules)).toBe("nonbillable");
    expect(capLaborBucket({ name: "24-1", customerDisplayName: "SMW" }, rules)).toBe("intercompany");
    expect(capLaborBucket({ name: "24-1", customerDisplayName: "Acme" }, rules)).toBeNull();
    expect(capLaborBucket({ name: "EQP-12LH" }, rules)).toBeNull(); // transportation never qualifies
  });

  it("Precision Paint's work for Superior Marine is not a candidate", () => {
    expect(
      capLaborBucket(
        { name: "24-1", customerDisplayName: "Superior Marine", qbCompanyName: "Precision Paint" },
        rules,
      ),
    ).toBeNull();
  });
});
