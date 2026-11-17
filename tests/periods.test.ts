import { describe, expect, it } from "vitest";
import { capLaborPeriod } from "@/lib/capitalizedLabor";
import { localClock } from "@/lib/qbSyncSchedule";

const now = new Date("2026-11-17T15:00:00Z");

describe("Capitalized Labor period (capLaborPeriod)", () => {
  it("defaults to the current year to date", () => {
    const w = capLaborPeriod({}, now);
    expect([w.from, w.to]).toEqual(["2026-01-01", "2026-11-17"]);
    expect(w.params).toEqual({});
  });

  it("a range beats a month beats a year", () => {
    const w = capLaborPeriod({ year: "2024", month: "2025-03", from: "2025-07", to: "2026-06" }, now);
    expect([w.from, w.to]).toEqual(["2025-07-01", "2026-06-30"]);
    const m = capLaborPeriod({ year: "2024", month: "2025-03" }, now);
    expect([m.from, m.to]).toEqual(["2025-03-01", "2025-03-31"]);
    const y = capLaborPeriod({ year: "2024" }, now);
    expect([y.from, y.to]).toEqual(["2024-01-01", "2024-12-31"]);
  });

  it("never runs past today, and puts a backwards range in order", () => {
    expect(capLaborPeriod({ month: "2026-11" }, now).to).toBe("2026-11-17");
    const w = capLaborPeriod({ from: "2026-06", to: "2025-07" }, now);
    expect([w.fromMonth, w.toMonth]).toEqual(["2025-07", "2026-06"]);
  });

  it("falls back to the default on anything malformed", () => {
    for (const bad of [{ year: "20x6" }, { month: "2026-13" }, { year: "1999" }, { month: ["2026-01", "2026-02"] }]) {
      const w = capLaborPeriod(bad as never, now);
      expect([w.from, w.to]).toEqual(["2026-01-01", "2026-11-17"]);
    }
  });
});

describe("nightly sync clock (localClock)", () => {
  it("reads the wall clock in the sync timezone on both sides of a DST change", () => {
    // 08:30 UTC is 4:30 AM in New York under daylight time, 3:30 AM under standard.
    expect(localClock(new Date("2026-07-01T08:30:00Z"), "America/New_York")).toEqual({
      date: "2026-07-01",
      hour: 4,
    });
    expect(localClock(new Date("2026-12-01T08:30:00Z"), "America/New_York")).toEqual({
      date: "2026-12-01",
      hour: 3,
    });
  });

  it("uses the local date, not the UTC one", () => {
    expect(localClock(new Date("2026-07-02T02:00:00Z"), "America/New_York").date).toBe("2026-07-01");
  });

  it("rejects a timezone that doesn't exist", () => {
    expect(() => localClock(now, "Mars/Olympus")).toThrow(/QB_SYNC_TIMEZONE/);
  });
});
