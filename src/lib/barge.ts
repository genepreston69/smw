/* ---------------------------------------------------------------------------
   Barge Program domain: types, the client-side cost mirror, the parametric
   rough-quote model, and the reference takeoff templates.

   computeSteelLine / computeQuote are a deliberate client-side mirror of the
   SQL views `barge_quote_steel_line_costs` and `barge_quote_totals`
   (supabase/migrations/0017_barge_program.sql) so the workbench can show live
   totals while typing. Any change to the SQL math must be mirrored here and
   vice versa.
--------------------------------------------------------------------------- */

export type BargeSection =
  | "plating"
  | "deck_framing"
  | "bottom_side_framing"
  | "trusses";

export const BARGE_SECTIONS: BargeSection[] = [
  "plating",
  "deck_framing",
  "bottom_side_framing",
  "trusses",
];

export const BARGE_SECTION_LABELS: Record<BargeSection, string> = {
  plating: "Plating",
  deck_framing: "Deck framing",
  bottom_side_framing: "Bottom & side framing",
  trusses: "Truss system",
};

export type BargeLineUnit = "ft" | "plates" | "lot" | "each";
export const BARGE_LINE_UNITS: BargeLineUnit[] = ["ft", "plates", "lot", "each"];

import type { PlanStatus } from "@/lib/types";

export interface BargeConfig {
  id: string;
  name: string;
  notes: string | null;
  length_ft: number;
  beam_ft: number;
  depth_ft: number;
  spud_wells: number;
  deck_plate_in: number;
  side_plate_in: number;
  bhd_plate_in: number;
  long_bhd_spacing_ft: number;
  wt_bhd_spacing_ft: number;
  plate_allowance_pct: number;
  framing_pct: number;
  yield_pct: number;
  steel_per_lb: number;
  hours_per_ton: number;
  labor_rate: number;
  blast_per_sqft: number;
  spud_well_cost: number;
  fittings_per_sqft: number;
  target_pct: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export type BargeConfigValues = Omit<
  BargeConfig,
  "id" | "created_by" | "created_at" | "updated_at" | "notes"
>;

/** Normalize a barge_configs row (numerics arrive as strings) to plain values. */
export function configToValues(c: BargeConfig): BargeConfigValues {
  return {
    name: c.name,
    length_ft: Number(c.length_ft),
    beam_ft: Number(c.beam_ft),
    depth_ft: Number(c.depth_ft),
    spud_wells: Number(c.spud_wells),
    deck_plate_in: Number(c.deck_plate_in),
    side_plate_in: Number(c.side_plate_in),
    bhd_plate_in: Number(c.bhd_plate_in),
    long_bhd_spacing_ft: Number(c.long_bhd_spacing_ft),
    wt_bhd_spacing_ft: Number(c.wt_bhd_spacing_ft),
    plate_allowance_pct: Number(c.plate_allowance_pct),
    framing_pct: Number(c.framing_pct),
    yield_pct: Number(c.yield_pct),
    steel_per_lb: Number(c.steel_per_lb),
    hours_per_ton: Number(c.hours_per_ton),
    labor_rate: Number(c.labor_rate),
    blast_per_sqft: Number(c.blast_per_sqft),
    spud_well_cost: Number(c.spud_well_cost),
    fittings_per_sqft: Number(c.fittings_per_sqft),
    target_pct: Number(c.target_pct),
  };
}

export interface BargeQuote {
  id: string;
  config_id: string | null;
  customer_id: string | null;
  name: string;
  notes: string | null;
  status: PlanStatus;
  version: number;
  labor_rate: number;
  blast_cost: number;
  spuds_cost: number;
  hatches_cost: number;
  overhead_pct: number;
  contingency_pct: number;
  target_pct: number;
  sales_price: number;
  created_by: string;
  submitted_at: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BargeSteelLine {
  id: string;
  quote_id: string;
  section: BargeSection;
  sort_order: number;
  item: string;
  unit: BargeLineUnit;
  qty: number;
  unit_lb: number;
  yield_pct: number;
  price_per_lb: number;
}

export interface BargeLaborPhase {
  id: string;
  quote_id: string;
  sort_order: number;
  name: string;
  hours: number;
}

export interface BargeQuoteTotals {
  quote_id: string;
  net_lbs: number;
  ordered_lbs: number;
  net_tons: number;
  steel_cost: number;
  total_hours: number;
  labor_cost: number;
  fitout_cost: number;
  overhead_cost: number;
  hours_per_ton: number;
  direct_cost: number;
  absorbed_cost: number;
  direct_margin: number;
  absorbed_margin: number;
  direct_margin_pct: number;
  price_at_target: number;
  sales_price: number;
}

export interface BargeApproval {
  id: string;
  quote_id: string;
  quote_version: number;
  approver_id: string;
  decision: "approved" | "rejected" | "changes_requested";
  comment: string | null;
  created_at: string;
}

/* ---------------------------------------------------------------------------
   Cost mirror (keep in lockstep with the SQL views)
--------------------------------------------------------------------------- */

export interface SteelLineInput {
  section: BargeSection;
  item: string;
  unit: BargeLineUnit;
  qty: number;
  unit_lb: number;
  yield_pct: number;
  price_per_lb: number;
}

export interface LaborPhaseInput {
  name: string;
  hours: number;
}

export interface QuoteInputs {
  labor_rate: number;
  blast_cost: number;
  spuds_cost: number;
  hatches_cost: number;
  overhead_pct: number;
  contingency_pct: number;
  target_pct: number;
  sales_price: number;
  lines: SteelLineInput[];
  labor: LaborPhaseInput[];
}

export function computeSteelLine(l: SteelLineInput) {
  const netLbs = l.qty * l.unit_lb;
  const orderedLbs = l.yield_pct > 0 ? netLbs / (l.yield_pct / 100) : netLbs;
  return { netLbs, orderedLbs, steelCost: orderedLbs * l.price_per_lb };
}

export interface QuoteComputed extends BargeQuoteTotals {
  bySection: Record<
    BargeSection,
    { netLbs: number; orderedLbs: number; steelCost: number }
  >;
  /** Fully-absorbed margin as a fraction of the price. */
  absorbed_margin_pct: number;
  /** The yard's own $1.50/lb-net heuristic, for the live crosscheck. */
  crosscheck: number;
}

export function computeQuote(q: QuoteInputs): QuoteComputed {
  const bySection = Object.fromEntries(
    BARGE_SECTIONS.map((s) => [s, { netLbs: 0, orderedLbs: 0, steelCost: 0 }]),
  ) as QuoteComputed["bySection"];

  let netLbs = 0;
  let orderedLbs = 0;
  let steelCost = 0;
  for (const l of q.lines) {
    const c = computeSteelLine(l);
    netLbs += c.netLbs;
    orderedLbs += c.orderedLbs;
    steelCost += c.steelCost;
    bySection[l.section].netLbs += c.netLbs;
    bySection[l.section].orderedLbs += c.orderedLbs;
    bySection[l.section].steelCost += c.steelCost;
  }

  const totalHours = q.labor.reduce((a, l) => a + l.hours, 0);
  const laborCost = totalHours * q.labor_rate;
  const fitoutCost = q.blast_cost + q.spuds_cost + q.hatches_cost;
  const overheadCost = laborCost * (q.overhead_pct / 100);
  const contMult = 1 + q.contingency_pct / 100;
  const directCost = (steelCost + laborCost + fitoutCost) * contMult;
  const absorbedCost =
    (steelCost + laborCost + fitoutCost + overheadCost) * contMult;
  const netTons = netLbs / 2000;

  return {
    quote_id: "",
    net_lbs: netLbs,
    ordered_lbs: orderedLbs,
    net_tons: netTons,
    steel_cost: steelCost,
    total_hours: totalHours,
    labor_cost: laborCost,
    fitout_cost: fitoutCost,
    overhead_cost: overheadCost,
    hours_per_ton: netTons > 0 ? totalHours / netTons : 0,
    direct_cost: directCost,
    absorbed_cost: absorbedCost,
    direct_margin: q.sales_price - directCost,
    absorbed_margin: q.sales_price - absorbedCost,
    direct_margin_pct:
      q.sales_price > 0 ? (q.sales_price - directCost) / q.sales_price : 0,
    absorbed_margin_pct:
      q.sales_price > 0 ? (q.sales_price - absorbedCost) / q.sales_price : 0,
    price_at_target: directCost / (1 - q.target_pct / 100),
    sales_price: q.sales_price,
    bySection,
    crosscheck: netLbs * 1.5,
  };
}

/* ---------------------------------------------------------------------------
   Rough-quote parametric model. Shell and bulkhead plate from geometry at the
   entered scantling thicknesses (steel = 40.8 lb/sqft per inch of thickness);
   the plate allowance (rakes, spud wells, laps, brackets) and the
   framing-and-trusses factor are calibrated to reproduce the naval
   architect's engineered 150' × 54' × 8' takeoff (≈807K lbs net) within 0.5%.
--------------------------------------------------------------------------- */

export const DEFAULT_CONFIG: BargeConfigValues = {
  name: "",
  length_ft: 120,
  beam_ft: 40,
  depth_ft: 8,
  spud_wells: 4,
  deck_plate_in: 0.5,
  side_plate_in: 0.375,
  bhd_plate_in: 0.3125,
  long_bhd_spacing_ft: 11,
  wt_bhd_spacing_ft: 30,
  plate_allowance_pct: 22,
  framing_pct: 39,
  yield_pct: 88,
  steel_per_lb: 0.55,
  hours_per_ton: 30,
  labor_rate: 45,
  blast_per_sqft: 4,
  spud_well_cost: 18000,
  fittings_per_sqft: 4.5,
  target_pct: 25,
};

export interface RoughQuote {
  deckArea: number;
  sideArea: number;
  endArea: number;
  extArea: number;
  longBhds: number;
  wtBhds: number;
  wDeck: number;
  wBottom: number;
  wSide: number;
  wEnds: number;
  wLongBhd: number;
  wWtBhd: number;
  wAllowance: number;
  wFraming: number;
  netLbs: number;
  netTons: number;
  orderedLbs: number;
  steelCost: number;
  hours: number;
  laborCost: number;
  blastCost: number;
  spudsCost: number;
  fittingsCost: number;
  directCost: number;
  suggestedPrice: number;
}

const LB_PER_SQFT_INCH = 40.8;

export function computeRoughQuote(c: BargeConfigValues): RoughQuote {
  const psf = (t: number) => LB_PER_SQFT_INCH * t;
  const deckArea = c.length_ft * c.beam_ft;
  const sideArea = 2 * c.length_ft * c.depth_ft;
  const endArea = 2 * c.beam_ft * c.depth_ft;
  const longBhds = Math.max(0, Math.round(c.beam_ft / c.long_bhd_spacing_ft) - 1);
  const wtBhds = Math.max(0, Math.round(c.length_ft / c.wt_bhd_spacing_ft));

  const wDeck = deckArea * psf(c.deck_plate_in);
  const wBottom = deckArea * psf(c.deck_plate_in);
  const wSide = sideArea * psf(c.side_plate_in);
  const wEnds = endArea * psf(c.deck_plate_in);
  const wLongBhd = longBhds * c.length_ft * c.depth_ft * psf(c.bhd_plate_in);
  const wWtBhd = wtBhds * c.beam_ft * c.depth_ft * psf(c.bhd_plate_in);
  const shell = wDeck + wBottom + wSide + wEnds + wLongBhd + wWtBhd;
  const wAllowance = (shell * c.plate_allowance_pct) / 100;
  const plate = shell + wAllowance;
  const wFraming = (plate * c.framing_pct) / 100;

  const netLbs = plate + wFraming;
  const netTons = netLbs / 2000;
  const orderedLbs = netLbs / (c.yield_pct / 100);
  const steelCost = orderedLbs * c.steel_per_lb;
  const hours = Math.round(netTons * c.hours_per_ton);
  const laborCost = hours * c.labor_rate;
  const extArea = deckArea * 2 + sideArea + endArea;
  const blastCost = extArea * c.blast_per_sqft;
  const spudsCost = c.spud_wells * c.spud_well_cost;
  const fittingsCost = deckArea * c.fittings_per_sqft;
  const directCost = steelCost + laborCost + blastCost + spudsCost + fittingsCost;
  const suggestedPrice = directCost / (1 - c.target_pct / 100);

  return {
    deckArea, sideArea, endArea, extArea, longBhds, wtBhds,
    wDeck, wBottom, wSide, wEnds, wLongBhd, wWtBhd, wAllowance, wFraming,
    netLbs, netTons, orderedLbs, steelCost, hours, laborCost,
    blastCost, spudsCost, fittingsCost, directCost, suggestedPrice,
  };
}

/** TSG phase allocation shares for splitting parametric hours into phases. */
const LABOR_SHARES = [0.257, 0.286, 0.114, 0.229, 0.071, 0.043];

export const DEFAULT_LABOR_PHASES: LaborPhaseInput[] = [
  { name: "Bottom & side shell assembly", hours: 900 },
  { name: "Internal frames & trusses", hours: 1000 },
  { name: "WT & longitudinal bulkheads", hours: 400 },
  { name: "Deck plating & framing", hours: 800 },
  { name: "Spud wells & headlog", hours: 250 },
  { name: "Fit-out, launch prep & QC", hours: 150 },
];

const roundTo = (n: number, step: number) => Math.round(n / step) * step;
const fmtLbs = (n: number) => Math.round(n).toLocaleString("en-US");

/** Turn a rough quote into a fully editable component takeoff. */
export function roughQuoteToTakeoff(c: BargeConfigValues, r: RoughQuote): {
  lines: SteelLineInput[];
  labor: LaborPhaseInput[];
  quote: Omit<QuoteInputs, "lines" | "labor">;
} {
  const mk = (
    section: BargeSection,
    item: string,
    lbs: number,
  ): SteelLineInput => ({
    section,
    item,
    unit: "lot",
    qty: 1,
    unit_lb: Math.round(lbs),
    yield_pct: c.yield_pct,
    price_per_lb: c.steel_per_lb,
  });

  const lines: SteelLineInput[] = [
    mk("plating", `Deck plate ${c.deck_plate_in}" (${fmtLbs(r.deckArea)} sqft)`, r.wDeck),
    mk("plating", `Bottom plate ${c.deck_plate_in}"`, r.wBottom),
    mk("plating", `Side shell ${c.side_plate_in}"`, r.wSide),
    mk("plating", "Ends & headlog", r.wEnds),
    mk("plating", `Long. BHDs ×${r.longBhds} + WT BHDs ×${r.wtBhds} (${c.bhd_plate_in}")`, r.wLongBhd + r.wWtBhd),
    mk("plating", `Plate allowance — rakes, spud wells, laps (${c.plate_allowance_pct}%)`, r.wAllowance),
    mk("deck_framing", "Deck framing share of allowance", r.wFraming * 0.38),
    mk("bottom_side_framing", "Bottom & side framing share", r.wFraming * 0.36),
    mk("trusses", "Truss system share", r.wFraming * 0.26),
  ];

  const labor = DEFAULT_LABOR_PHASES.map((p, i) => ({
    name: p.name,
    hours: roundTo(r.hours * LABOR_SHARES[i], 25),
  }));
  labor[0].hours += r.hours - labor.reduce((a, l) => a + l.hours, 0);

  return {
    lines,
    labor,
    quote: {
      labor_rate: c.labor_rate,
      blast_cost: roundTo(r.blastCost, 500),
      spuds_cost: Math.round(r.spudsCost),
      hatches_cost: roundTo(r.fittingsCost, 250),
      overhead_pct: 35,
      contingency_pct: 0,
      target_pct: c.target_pct,
      sales_price: roundTo(r.suggestedPrice, 5000),
    },
  };
}

/* ---------------------------------------------------------------------------
   Reference takeoff templates for the 150' × 54' × 8' TSG deck/crane barge.
   Engineer revision: line items and per-line yields from the naval
   architect's updated order list (TSG, Jul 2026). Original yard quote:
   original quantities at a uniform 88.9% yield (equivalent to its +12.5%
   adder); reproduces the $1,013,617 quote at $45/hr.
--------------------------------------------------------------------------- */

export interface BargeTemplate {
  key: "engineer" | "yard" | "blank";
  name: string;
  description: string;
  lines: SteelLineInput[];
  labor: LaborPhaseInput[];
  quote: Omit<QuoteInputs, "lines" | "labor">;
}

const COMMON_QUOTE: Omit<QuoteInputs, "lines" | "labor"> = {
  labor_rate: 45,
  blast_cost: 78000,
  spuds_cost: 72000,
  hatches_cost: 36250,
  overhead_pct: 35,
  contingency_pct: 0,
  target_pct: 25,
  sales_price: 0,
};

const line = (
  section: BargeSection,
  item: string,
  unit: BargeLineUnit,
  qty: number,
  unit_lb: number,
  yield_pct: number,
  price_per_lb: number,
): SteelLineInput => ({ section, item, unit, qty, unit_lb, yield_pct, price_per_lb });

export const BARGE_TEMPLATES: BargeTemplate[] = [
  {
    key: "engineer",
    name: "Engineer rev — 150×54×8 (TSG Jul 2026)",
    description:
      "The naval architect's updated order list with per-line purchase yields. ≈403.5 net tons, ≈907K lbs ordered.",
    lines: [
      line("plating", '½" plate 40×10 — deck & bottom shell', "plates", 55, 8168, 90, 0.75),
      line("plating", '5/16" plate — long. & WT bulkheads', "plates", 14, 5104, 90, 0.75),
      line("plating", '⅜" plate — side shell, transverses, brkts', "plates", 8, 6128, 80, 0.75),
      line("plating", '¾" plate 40×8 — headlog', "plates", 1, 9792, 100, 0.75),
      line("deck_framing", "L6x4x⅜ — deck longitudinals", "ft", 7000, 12.3, 90, 0.85),
      line("bottom_side_framing", "C12x25# — bottom & side transverses", "ft", 1400, 25, 80, 0.85),
      line("bottom_side_framing", "L4x3x⅜ — bottom & side longls, BHD stiff", "ft", 6500, 8.5, 90, 0.85),
      line("trusses", "L6x6x¾ — truss chords & diagonals", "ft", 960, 28.7, 90, 0.85),
      line("trusses", "L5x5x¾ — truss verticals", "ft", 1000, 23.6, 90, 0.85),
    ],
    labor: DEFAULT_LABOR_PHASES,
    quote: { ...COMMON_QUOTE, sales_price: 1400000 },
  },
  {
    key: "yard",
    name: "Original yard quote (takeoff v1)",
    description:
      "The yard's earlier budget preserved as a comparison baseline: original quantities at a uniform 88.9% yield. Reproduces $1,013,617 at $45/hr.",
    lines: [
      line("plating", '½" plate 40×10', "plates", 50, 8168, 88.8889, 0.75),
      line("plating", '5/16" plate', "plates", 14, 5104, 88.8889, 0.75),
      line("plating", '⅜" plate', "plates", 8, 6128, 88.8889, 0.75),
      line("deck_framing", "L6x4x⅜", "ft", 5000, 12.3, 88.8889, 0.85),
      line("bottom_side_framing", "C12x25#", "ft", 1400, 25, 88.8889, 0.85),
      line("bottom_side_framing", "L4x3x⅜", "ft", 5400, 8.5, 88.8889, 0.85),
      line("trusses", "L6x6x1", "ft", 640, 37.4, 88.8889, 0.85),
      line("trusses", "L4x4x1", "ft", 800, 25.6, 88.8889, 0.85),
      line("trusses", "L6x6x½", "ft", 2400, 19.6, 88.8889, 0.85),
    ],
    labor: DEFAULT_LABOR_PHASES,
    quote: { ...COMMON_QUOTE, sales_price: 1350000 },
  },
  {
    key: "blank",
    name: "Blank quote",
    description:
      "An empty takeoff with the standard build phases — start from scratch for a vessel the templates don't fit.",
    lines: [],
    labor: DEFAULT_LABOR_PHASES.map((p) => ({ ...p, hours: 0 })),
    quote: { ...COMMON_QUOTE },
  },
];

/** Annual labor-pool assumptions for the program planner. */
export const PRODUCTIVE_HOURS_PER_FTE = 1800;
export const DEFAULT_DIRECT_FTES = 46;
