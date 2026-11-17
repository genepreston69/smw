import { describe, expect, it } from "vitest";
import { computeLineCosts, sumCosts, type CostInputs, type PlanParams } from "@/lib/costing";

const params: PlanParams = {
  labor_cost_rate: 40,
  default_labor_bill_rate: 95,
  consumables_pct: 0.05,
  overhead_pool: 1000,
};
const line = (over: Partial<CostInputs>): CostInputs => ({
  events: 1,
  hours_per_piece: 0,
  quantity: 1,
  labor_bill_rate: null,
  material_basis: "lump_sum",
  length_per_piece: 0,
  weight_per_lf: 0,
  unit_cost: 0,
  lump_sum_cost: 0,
  material_markup_pct: 0,
  ...over,
});

describe("plan cost engine (costing.ts)", () => {
  it("prices a per-lb steel line by hand-checked arithmetic", () => {
    const [c] = computeLineCosts(
      [
        line({
          events: 2,
          hours_per_piece: 1.5,
          quantity: 4,
          material_basis: "per_lb",
          length_per_piece: 10,
          weight_per_lf: 12,
          unit_cost: 0.9,
          material_markup_pct: 0.2,
        }),
      ],
      params,
    );
    expect(c.totalLength).toBe(40);
    expect(c.totalHours).toBe(12);
    expect(c.weightEst).toBe(480);
    expect(c.materialCost).toBeCloseTo(432, 9); // 0.9 × 480 lb
    expect(c.materialPrice).toBeCloseTo(518.4, 9); // + 20% markup
    expect(c.laborCost).toBe(480); // 12 h × $40
    expect(c.laborPrice).toBe(1140); // 12 h × $95 default bill rate
    expect(c.consumables).toBeCloseTo(57, 9); // 5% of labor price
    expect(c.overheadAlloc).toBeCloseTo(1000, 9); // the only line takes the pool
    expect(c.lineCost).toBeCloseTo(480 + 432 + 57 + 1000, 9);
    expect(c.linePrice).toBeCloseTo(1140 + 518.4 + 57 + 1000, 9);
    expect(c.profit).toBeCloseTo(c.linePrice - c.lineCost, 9);
  });

  it("uses each material basis's own quantity", () => {
    const [each, sf, lump] = computeLineCosts(
      [
        line({ material_basis: "per_each", quantity: 7, unit_cost: 3 }),
        line({ material_basis: "per_sf", quantity: 2, length_per_piece: 50, unit_cost: 4 }),
        line({ material_basis: "lump_sum", quantity: 9, lump_sum_cost: 250 }),
      ],
      { ...params, overhead_pool: 0 },
    );
    expect(each.materialCost).toBe(21);
    expect(sf.materialCost).toBe(400);
    expect(lump.materialCost).toBe(250);
  });

  it("a line's own bill rate overrides the plan default", () => {
    const [c] = computeLineCosts([line({ hours_per_piece: 2, labor_bill_rate: 120 })], params);
    expect(c.laborPrice).toBe(240);
  });

  it("allocates the whole overhead pool across lines by labor + material cost", () => {
    const costs = computeLineCosts(
      [
        line({ hours_per_piece: 10 }), // $400 labor
        line({ lump_sum_cost: 1200 }), // $1,200 material
      ],
      params,
    );
    expect(costs[0].overheadAlloc).toBeCloseTo(250, 9);
    expect(costs[1].overheadAlloc).toBeCloseTo(750, 9);
    expect(sumCosts(costs).overhead).toBeCloseTo(1000, 9);
  });

  it("allocates no overhead when there is nothing to allocate against", () => {
    const [c] = computeLineCosts([line({})], params);
    expect(c.overheadAlloc).toBe(0);
  });
});
