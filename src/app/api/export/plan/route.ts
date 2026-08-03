import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/fetchAll";
import { csvResponse, toCsv } from "@/lib/csv";
import type { MaterialBasis, PlanTotals } from "@/lib/types";

// Line-level export of a single plan: one row per line item with the
// engine-computed costs from plan_line_item_costs (never recomputed here),
// plus a totals row from plan_totals so the CSV matches the editor exactly.
//
// ?id=<plan uuid>

const BASIS_LABELS: Record<MaterialBasis, string> = {
  per_lb: "$/lb",
  per_each: "$/ea",
  per_sf: "$/SF",
  lump_sum: "Lump",
};

interface CostLine {
  phase_id: string | null;
  sort_order: number;
  description: string;
  priority: 1 | 2 | 3;
  is_tbd: boolean;
  events: number;
  hours_per_piece: number;
  quantity: number;
  material_basis: MaterialBasis;
  length_per_piece: number;
  weight_per_lf: number;
  unit_cost: number;
  lump_sum_cost: number;
  material_markup_pct: number;
  effective_bill_rate: number;
  total_hours: number;
  weight_est: number | null;
  material_cost: number | null;
  material_price: number | null;
  labor_cost: number;
  labor_price: number;
  consumables: number;
  overhead_alloc: number;
  line_cost: number | null;
  line_price: number | null;
  profit: number | null;
}

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const id = new URL(request.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing id parameter" }, { status: 400 });
  }

  const { data: plan } = await supabase
    .from("project_plans")
    .select("id, title, status, version")
    .eq("id", id)
    .maybeSingle();
  if (!plan) {
    return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  }

  const [{ data: phases }, lines, { data: totals }] = await Promise.all([
    supabase.from("plan_phases").select("id, name").eq("plan_id", id),
    // Paged read so huge plans aren't truncated at Supabase's 1000-row cap.
    fetchAllRows((from, to) =>
      supabase
        .from("plan_line_item_costs")
        .select("*")
        .eq("plan_id", id)
        .order("sort_order")
        .order("id")
        .range(from, to),
    ),
    supabase.from("plan_totals").select("*").eq("plan_id", id).maybeSingle(),
  ]);

  const phaseName = new Map((phases ?? []).map((p) => [p.id, p.name]));
  const money = (n: number | null | undefined) => Number(n ?? 0).toFixed(2);

  const rows = (lines as unknown as CostLine[]).map((l) => [
    l.phase_id ? (phaseName.get(l.phase_id) ?? "") : "",
    l.priority,
    l.description,
    l.is_tbd ? "Yes" : "No",
    l.events,
    l.hours_per_piece,
    l.quantity,
    Number(l.total_hours ?? 0),
    BASIS_LABELS[l.material_basis],
    l.length_per_piece,
    l.weight_per_lf,
    Number(l.weight_est ?? 0),
    money(l.unit_cost),
    money(l.lump_sum_cost),
    (l.material_markup_pct * 100).toFixed(1),
    money(l.material_cost),
    money(l.material_price),
    money(l.effective_bill_rate),
    money(l.labor_cost),
    money(l.labor_price),
    money(l.consumables),
    money(l.overhead_alloc),
    money(l.line_cost),
    money(l.line_price),
    money(l.profit),
  ]);

  const t = totals as PlanTotals | null;
  if (t) {
    rows.push([
      "Total",
      "",
      `${t.line_count} lines${t.tbd_count > 0 ? ` (${t.tbd_count} TBD)` : ""}`,
      "",
      "",
      "",
      "",
      Number(t.total_hours ?? 0),
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      money(t.material_cost),
      money(t.material_price),
      "",
      money(t.labor_cost),
      money(t.labor_price),
      money(t.consumables),
      money(t.overhead),
      money(t.total_cost),
      money(t.total_price),
      money(t.profit),
    ]);
  }

  const csv = toCsv(
    [
      "Phase",
      "Priority",
      "Description",
      "TBD",
      "Events",
      "Hours/Piece",
      "Qty",
      "Total Hours",
      "Basis",
      "Length/Piece",
      "Weight/LF",
      "Weight (lbs)",
      "Unit Cost",
      "Lump Sum",
      "Markup %",
      "Material Cost",
      "Material Price",
      "Bill Rate",
      "Labor Cost",
      "Labor Price",
      "Consumables",
      "Overhead",
      "Line Cost",
      "Line Price",
      "Profit",
    ],
    rows,
  );

  const slug =
    plan.title
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .toLowerCase()
      .slice(0, 60) || "plan";
  return csvResponse(csv, `plan-${slug}.csv`);
}
