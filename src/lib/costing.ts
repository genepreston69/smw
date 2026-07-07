// Client-side mirror of the SQL cost engine (supabase/migrations →
// plan_line_item_costs view) so the plan editor can show live totals while
// editing. The database view remains the source of truth for saved data.

import type { MaterialBasis } from "@/lib/types";

export interface CostInputs {
  events: number;
  hours_per_piece: number;
  quantity: number;
  labor_bill_rate: number | null;
  material_basis: MaterialBasis;
  length_per_piece: number;
  weight_per_lf: number;
  unit_cost: number;
  lump_sum_cost: number;
  material_markup_pct: number;
}

export interface PlanParams {
  labor_cost_rate: number;
  default_labor_bill_rate: number;
  consumables_pct: number;
  overhead_pool: number | null;
}

export interface LineCosts {
  totalLength: number;
  totalHours: number;
  weightEst: number;
  materialCost: number;
  materialPrice: number;
  laborCost: number;
  laborPrice: number;
  consumables: number;
  overheadAlloc: number;
  lineCost: number;
  linePrice: number;
  profit: number;
}

function materialCost(li: CostInputs, totalLength: number): number {
  switch (li.material_basis) {
    case "per_lb":
      return li.unit_cost * li.weight_per_lf * totalLength;
    case "per_each":
      return li.unit_cost * li.quantity;
    case "per_sf":
      return li.unit_cost * totalLength;
    case "lump_sum":
      return li.lump_sum_cost;
  }
}

export function computeLineCosts(
  items: CostInputs[],
  params: PlanParams,
): LineCosts[] {
  const overheadPool = params.overhead_pool ?? 0;

  const partial = items.map((li) => {
    const totalLength = li.length_per_piece * li.quantity;
    const totalHours = li.hours_per_piece * li.quantity * li.events;
    const weightEst = li.weight_per_lf * totalLength;
    const matCost = materialCost(li, totalLength);
    const laborCost = params.labor_cost_rate * totalHours;
    const laborPrice =
      (li.labor_bill_rate ?? params.default_labor_bill_rate) * totalHours;
    return { totalLength, totalHours, weightEst, matCost, laborCost, laborPrice, li };
  });

  const allocBase = partial.reduce((s, p) => s + p.laborCost + p.matCost, 0);

  return partial.map((p) => {
    const materialPrice = p.matCost * (1 + p.li.material_markup_pct);
    const consumables = params.consumables_pct * p.laborPrice;
    const overheadAlloc =
      allocBase > 0 ? ((p.laborCost + p.matCost) / allocBase) * overheadPool : 0;
    const lineCost = p.laborCost + p.matCost + consumables + overheadAlloc;
    const linePrice = p.laborPrice + materialPrice + consumables + overheadAlloc;
    return {
      totalLength: p.totalLength,
      totalHours: p.totalHours,
      weightEst: p.weightEst,
      materialCost: p.matCost,
      materialPrice,
      laborCost: p.laborCost,
      laborPrice: p.laborPrice,
      consumables,
      overheadAlloc,
      lineCost,
      linePrice,
      profit: linePrice - lineCost,
    };
  });
}

export function sumCosts(lines: LineCosts[]) {
  const totals = lines.reduce(
    (acc, l) => ({
      totalHours: acc.totalHours + l.totalHours,
      materialCost: acc.materialCost + l.materialCost,
      materialPrice: acc.materialPrice + l.materialPrice,
      laborCost: acc.laborCost + l.laborCost,
      laborPrice: acc.laborPrice + l.laborPrice,
      consumables: acc.consumables + l.consumables,
      overhead: acc.overhead + l.overheadAlloc,
      totalCost: acc.totalCost + l.lineCost,
      totalPrice: acc.totalPrice + l.linePrice,
    }),
    {
      totalHours: 0,
      materialCost: 0,
      materialPrice: 0,
      laborCost: 0,
      laborPrice: 0,
      consumables: 0,
      overhead: 0,
      totalCost: 0,
      totalPrice: 0,
    },
  );
  return {
    ...totals,
    profit: totals.totalPrice - totals.totalCost,
    profitPct: totals.totalPrice > 0 ? (totals.totalPrice - totals.totalCost) / totals.totalPrice : 0,
  };
}
