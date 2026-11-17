import { expect, it } from "vitest";
import { computeLineCosts, sumCosts, type CostInputs, type PlanParams } from "@/lib/costing";
import { computeQuote, computeSteelLine, type QuoteInputs } from "@/lib/barge";
import { createUser, describeDb, num } from "./db";

// costing.ts and barge.ts are client-side mirrors of SQL views so editors can
// show live totals. "They produce identical numbers" is only true if something
// checks it: these feed the same inputs to both and compare every figure.

const params: PlanParams = {
  labor_cost_rate: 41.5,
  default_labor_bill_rate: 96,
  consumables_pct: 0.07,
  overhead_pool: 12345.67,
};
const lines: CostInputs[] = [
  { events: 2, hours_per_piece: 1.5, quantity: 4, labor_bill_rate: null, material_basis: "per_lb", length_per_piece: 10, weight_per_lf: 12.5, unit_cost: 0.93, lump_sum_cost: 0, material_markup_pct: 0.2 },
  { events: 1, hours_per_piece: 0.75, quantity: 13, labor_bill_rate: 110, material_basis: "per_each", length_per_piece: 0, weight_per_lf: 0, unit_cost: 18.4, lump_sum_cost: 0, material_markup_pct: 0.15 },
  { events: 3, hours_per_piece: 2, quantity: 2, labor_bill_rate: null, material_basis: "per_sf", length_per_piece: 48, weight_per_lf: 0, unit_cost: 3.1, lump_sum_cost: 0, material_markup_pct: 0 },
  { events: 1, hours_per_piece: 0, quantity: 1, labor_bill_rate: null, material_basis: "lump_sum", length_per_piece: 0, weight_per_lf: 0, unit_cost: 0, lump_sum_cost: 2750, material_markup_pct: 0.1 },
  // Nothing to price: must not disturb the overhead allocation.
  { events: 1, hours_per_piece: 0, quantity: 0, labor_bill_rate: null, material_basis: "per_each", length_per_piece: 0, weight_per_lf: 0, unit_cost: 5, lump_sum_cost: 0, material_markup_pct: 0 },
];

describeDb("SQL cost views match their TypeScript mirrors", (db) => {
  it("plan_line_item_costs and plan_totals match costing.ts", async () => {
    const userId = await createUser(db(), "estimator-plan@superiormarineinc.com");
    const plan = await db().query(
      `insert into project_plans (title, created_by, labor_cost_rate, default_labor_bill_rate, consumables_pct, overhead_pool)
       values ('Mirror test', $1, $2, $3, $4, $5) returning id`,
      [userId, params.labor_cost_rate, params.default_labor_bill_rate, params.consumables_pct, params.overhead_pool],
    );
    const planId = plan.rows[0].id;
    for (const [i, l] of lines.entries()) {
      await db().query(
        `insert into plan_line_items (plan_id, sort_order, description, events, hours_per_piece, quantity, labor_bill_rate,
           material_basis, length_per_piece, weight_per_lf, unit_cost, lump_sum_cost, material_markup_pct)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [planId, i, `line ${i}`, l.events, l.hours_per_piece, l.quantity, l.labor_bill_rate, l.material_basis,
          l.length_per_piece, l.weight_per_lf, l.unit_cost, l.lump_sum_cost, l.material_markup_pct],
      );
    }

    const expected = computeLineCosts(lines, params);
    const { rows } = await db().query(
      "select * from plan_line_item_costs where plan_id = $1 order by sort_order",
      [planId],
    );
    expect(rows).toHaveLength(lines.length);
    rows.forEach((r, i) => {
      const e = expected[i];
      const pairs: [string, number][] = [
        ["total_length", e.totalLength], ["total_hours", e.totalHours], ["weight_est", e.weightEst],
        ["material_cost", e.materialCost], ["material_price", e.materialPrice],
        ["labor_cost", e.laborCost], ["labor_price", e.laborPrice], ["consumables", e.consumables],
        ["overhead_alloc", e.overheadAlloc], ["line_cost", e.lineCost], ["line_price", e.linePrice],
        ["profit", e.profit],
      ];
      for (const [col, value] of pairs) {
        expect(num(r[col]), `line ${i} ${col}`).toBeCloseTo(value, 6);
      }
    });

    const totals = sumCosts(expected);
    const t = (await db().query("select * from plan_totals where plan_id = $1", [planId])).rows[0];
    expect(num(t.total_hours)).toBeCloseTo(totals.totalHours, 6);
    expect(num(t.material_cost)).toBeCloseTo(totals.materialCost, 6);
    expect(num(t.material_price)).toBeCloseTo(totals.materialPrice, 6);
    expect(num(t.labor_cost)).toBeCloseTo(totals.laborCost, 6);
    expect(num(t.labor_price)).toBeCloseTo(totals.laborPrice, 6);
    expect(num(t.consumables)).toBeCloseTo(totals.consumables, 6);
    expect(num(t.overhead)).toBeCloseTo(totals.overhead, 6);
    expect(num(t.total_cost)).toBeCloseTo(totals.totalCost, 6);
    expect(num(t.total_price)).toBeCloseTo(totals.totalPrice, 6);
    expect(num(t.profit)).toBeCloseTo(totals.profit, 6);
    // The whole pool is allocated.
    expect(num(t.overhead)).toBeCloseTo(params.overhead_pool!, 6);
  });

  it("barge_quote_steel_line_costs and barge_quote_totals match barge.ts", async () => {
    const quote: QuoteInputs = {
      labor_rate: 47.25,
      blast_cost: 18000,
      spuds_cost: 6500.5,
      hatches_cost: 2400,
      overhead_pct: 35,
      contingency_pct: 4,
      target_pct: 22,
      sales_price: 985000,
      lines: [
        { section: "plating", item: "Deck plate", unit: "plates", qty: 42, unit_lb: 4084, yield_pct: 92, price_per_lb: 0.61 },
        { section: "deck_framing", item: "Angles", unit: "ft", qty: 3120.5, unit_lb: 12.2, yield_pct: 90, price_per_lb: 0.58 },
        { section: "bottom_side_framing", item: "Channels", unit: "ft", qty: 1800, unit_lb: 20.7, yield_pct: 88.5, price_per_lb: 0.6 },
        { section: "trusses", item: "Truss kit", unit: "lot", qty: 1, unit_lb: 15400, yield_pct: 100, price_per_lb: 0.72 },
      ],
      labor: [
        { name: "Fit", hours: 5200 },
        { name: "Weld", hours: 7350.5 },
        { name: "Blast & paint", hours: 900 },
      ],
    };
    const userId = await createUser(db(), "estimator-barge@superiormarineinc.com");
    const q = await db().query(
      `insert into barge_quotes (name, created_by, labor_rate, blast_cost, spuds_cost, hatches_cost, overhead_pct, contingency_pct, target_pct, sales_price)
       values ('Mirror test', $1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [userId, quote.labor_rate, quote.blast_cost, quote.spuds_cost, quote.hatches_cost, quote.overhead_pct,
        quote.contingency_pct, quote.target_pct, quote.sales_price],
    );
    const quoteId = q.rows[0].id;
    // Through the app's own save path.
    await db().query("select public.replace_barge_quote_content($1, $2, $3)", [
      quoteId, JSON.stringify(quote.lines), JSON.stringify(quote.labor),
    ]);

    const { rows } = await db().query(
      "select * from barge_quote_steel_line_costs where quote_id = $1 order by sort_order",
      [quoteId],
    );
    expect(rows).toHaveLength(quote.lines.length);
    rows.forEach((r, i) => {
      const e = computeSteelLine(quote.lines[i]);
      expect(num(r.net_lbs), `line ${i} net_lbs`).toBeCloseTo(e.netLbs, 6);
      expect(num(r.ordered_lbs), `line ${i} ordered_lbs`).toBeCloseTo(e.orderedLbs, 6);
      expect(num(r.steel_cost), `line ${i} steel_cost`).toBeCloseTo(e.steelCost, 6);
    });

    const e = computeQuote(quote);
    const t = (await db().query("select * from barge_quote_totals where quote_id = $1", [quoteId])).rows[0];
    for (const col of [
      "net_lbs", "ordered_lbs", "net_tons", "steel_cost", "total_hours", "labor_cost", "fitout_cost",
      "overhead_cost", "hours_per_ton", "direct_cost", "absorbed_cost", "direct_margin", "absorbed_margin",
      "direct_margin_pct", "price_at_target",
    ] as const) {
      expect(num(t[col]), col).toBeCloseTo(e[col], 6);
    }
  });
});
