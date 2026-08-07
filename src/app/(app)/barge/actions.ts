"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import {
  BARGE_TEMPLATES,
  computeRoughQuote,
  configToValues,
  roughQuoteToTakeoff,
  type BargeConfig,
  type BargeConfigValues,
} from "@/lib/barge";

type ActionResult = { ok: true } | { ok: false; error: string };

function fail(error: unknown): ActionResult {
  const message =
    error instanceof Error ? error.message : "Something went wrong";
  // Supabase errors carry the raised exception text after the code prefix.
  return { ok: false, error: message.replace(/^.*?exception: /i, "") };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const steelLineSchema = z.object({
  section: z.enum(["plating", "deck_framing", "bottom_side_framing", "trusses"]),
  item: z.string(),
  unit: z.enum(["ft", "plates", "lot", "each"]),
  qty: z.number().min(0),
  unit_lb: z.number().min(0),
  yield_pct: z.number().gt(0).max(100),
  price_per_lb: z.number().min(0),
});

const laborPhaseSchema = z.object({
  name: z.string(),
  hours: z.number().min(0),
});

const quotePayloadSchema = z.object({
  name: z.string().min(1),
  customer_id: z.string().uuid().nullable(),
  notes: z.string().nullable(),
  labor_rate: z.number().min(0),
  blast_cost: z.number().min(0),
  spuds_cost: z.number().min(0),
  hatches_cost: z.number().min(0),
  overhead_pct: z.number().min(0),
  contingency_pct: z.number().min(0),
  target_pct: z.number().min(0).lt(100),
  sales_price: z.number().min(0),
  lines: z.array(steelLineSchema),
  labor: z.array(laborPhaseSchema),
});

export type BargeQuotePayload = z.infer<typeof quotePayloadSchema>;

const configSchema = z.object({
  name: z.string().min(1),
  length_ft: z.number().gt(0),
  beam_ft: z.number().gt(0),
  depth_ft: z.number().gt(0),
  spud_wells: z.number().int().min(0),
  deck_plate_in: z.number().gt(0),
  side_plate_in: z.number().gt(0),
  bhd_plate_in: z.number().gt(0),
  long_bhd_spacing_ft: z.number().gt(0),
  wt_bhd_spacing_ft: z.number().gt(0),
  plate_allowance_pct: z.number().min(0),
  framing_pct: z.number().min(0),
  yield_pct: z.number().gt(0).max(100),
  steel_per_lb: z.number().min(0),
  hours_per_ton: z.number().min(0),
  labor_rate: z.number().min(0),
  blast_per_sqft: z.number().min(0),
  spud_well_cost: z.number().min(0),
  fittings_per_sqft: z.number().min(0),
  target_pct: z.number().min(0).lt(100),
});

// ---------------------------------------------------------------------------
// Quote creation
// ---------------------------------------------------------------------------

async function insertQuoteWithContent(quote: {
  name: string;
  config_id?: string | null;
  fields: Record<string, unknown>;
  lines: z.infer<typeof steelLineSchema>[];
  labor: z.infer<typeof laborPhaseSchema>[];
}): Promise<string> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("barge_quotes")
    .insert({
      name: quote.name,
      config_id: quote.config_id ?? null,
      ...quote.fields,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);

  if (quote.lines.length) {
    const { error: lineErr } = await supabase
      .from("barge_quote_steel_lines")
      .insert(quote.lines.map((l, i) => ({ ...l, quote_id: data.id, sort_order: i })));
    if (lineErr) throw new Error(lineErr.message);
  }
  if (quote.labor.length) {
    const { error: laborErr } = await supabase
      .from("barge_quote_labor_phases")
      .insert(quote.labor.map((p, i) => ({ ...p, quote_id: data.id, sort_order: i })));
    if (laborErr) throw new Error(laborErr.message);
  }
  return data.id as string;
}

export async function createBargeQuote(formData: FormData) {
  const key = String(formData.get("template") ?? "blank");
  const template =
    BARGE_TEMPLATES.find((t) => t.key === key) ??
    BARGE_TEMPLATES.find((t) => t.key === "blank")!;

  const id = await insertQuoteWithContent({
    name: template.key === "blank" ? "New barge quote" : template.name,
    fields: { ...template.quote },
    lines: template.lines,
    labor: template.labor,
  });
  redirect(`/barge/${id}`);
}

export async function createBargeQuoteFromConfig(
  values: BargeConfigValues,
  configId: string | null,
) {
  const parsed = configSchema.safeParse({ ...values, name: values.name || "Rough quote" });
  if (!parsed.success) throw new Error("Invalid rough-quote parameters");
  const c = parsed.data;

  const rough = computeRoughQuote(c);
  const takeoff = roughQuoteToTakeoff(c, rough);
  const id = await insertQuoteWithContent({
    name: `Rough quote — ${c.length_ft}×${c.beam_ft}×${c.depth_ft} crane-ready`,
    config_id: configId,
    fields: { ...takeoff.quote },
    lines: takeoff.lines,
    labor: takeoff.labor,
  });
  redirect(`/barge/${id}`);
}

// "New quote" menu path: build the takeoff from a saved configuration.
export async function createBargeQuoteFromSavedConfig(formData: FormData) {
  const configId = String(formData.get("config_id") ?? "");
  const supabase = await createClient();
  const { data: config, error } = await supabase
    .from("barge_configs")
    .select("*")
    .eq("id", configId)
    .single();
  if (error || !config) throw new Error("Configuration not found");

  const values = configToValues(config as BargeConfig);
  const rough = computeRoughQuote(values);
  const takeoff = roughQuoteToTakeoff(values, rough);
  const id = await insertQuoteWithContent({
    name: `${values.name} — ${values.length_ft}×${values.beam_ft}×${values.depth_ft}`,
    config_id: configId,
    fields: { ...takeoff.quote },
    lines: takeoff.lines,
    labor: takeoff.labor,
  });
  redirect(`/barge/${id}`);
}

export async function duplicateBargeQuote(quoteId: string) {
  const supabase = await createClient();
  const [{ data: quote, error }, { data: lines }, { data: labor }] =
    await Promise.all([
      supabase.from("barge_quotes").select("*").eq("id", quoteId).single(),
      supabase
        .from("barge_quote_steel_lines")
        .select("section, item, unit, qty, unit_lb, yield_pct, price_per_lb, sort_order")
        .eq("quote_id", quoteId)
        .order("sort_order"),
      supabase
        .from("barge_quote_labor_phases")
        .select("name, hours, sort_order")
        .eq("quote_id", quoteId)
        .order("sort_order"),
    ]);
  if (error || !quote) throw new Error(error?.message ?? "Quote not found");

  const id = await insertQuoteWithContent({
    name: `${quote.name.replace(/ \(copy.*\)$/, "")} (copy)`,
    config_id: quote.config_id,
    fields: {
      customer_id: quote.customer_id,
      notes: quote.notes,
      labor_rate: quote.labor_rate,
      blast_cost: quote.blast_cost,
      spuds_cost: quote.spuds_cost,
      hatches_cost: quote.hatches_cost,
      overhead_pct: quote.overhead_pct,
      contingency_pct: quote.contingency_pct,
      target_pct: quote.target_pct,
      sales_price: quote.sales_price,
    },
    lines: (lines ?? []).map((l) => ({
      section: l.section,
      item: l.item,
      unit: l.unit,
      qty: Number(l.qty),
      unit_lb: Number(l.unit_lb),
      yield_pct: Number(l.yield_pct),
      price_per_lb: Number(l.price_per_lb),
    })),
    labor: (labor ?? []).map((p) => ({ name: p.name, hours: Number(p.hours) })),
  });
  redirect(`/barge/${id}`);
}

// ---------------------------------------------------------------------------
// Quote editing (wholesale save: header update + content replace).
// The DB guard triggers enforce that content only changes in draft /
// changes_requested, and RLS enforces ownership.
// ---------------------------------------------------------------------------

export async function saveBargeQuote(
  quoteId: string,
  payload: BargeQuotePayload,
): Promise<ActionResult> {
  const parsed = quotePayloadSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, error: "Invalid quote data" };
  const p = parsed.data;

  const supabase = await createClient();
  const { data: updated, error } = await supabase
    .from("barge_quotes")
    .update({
      name: p.name,
      customer_id: p.customer_id,
      notes: p.notes,
      labor_rate: p.labor_rate,
      blast_cost: p.blast_cost,
      spuds_cost: p.spuds_cost,
      hatches_cost: p.hatches_cost,
      overhead_pct: p.overhead_pct,
      contingency_pct: p.contingency_pct,
      target_pct: p.target_pct,
      sales_price: p.sales_price,
    })
    .eq("id", quoteId)
    .select("id");
  if (error) return fail(new Error(error.message));
  // RLS silently matches zero rows when the caller lacks update rights.
  if (!updated?.length)
    return { ok: false, error: "You don't have permission to edit this quote" };

  const { error: delLines } = await supabase
    .from("barge_quote_steel_lines")
    .delete()
    .eq("quote_id", quoteId);
  if (delLines) return fail(new Error(delLines.message));
  const { error: delLabor } = await supabase
    .from("barge_quote_labor_phases")
    .delete()
    .eq("quote_id", quoteId);
  if (delLabor) return fail(new Error(delLabor.message));

  if (p.lines.length) {
    const { error: insLines } = await supabase
      .from("barge_quote_steel_lines")
      .insert(p.lines.map((l, i) => ({ ...l, quote_id: quoteId, sort_order: i })));
    if (insLines) return fail(new Error(insLines.message));
  }
  if (p.labor.length) {
    const { error: insLabor } = await supabase
      .from("barge_quote_labor_phases")
      .insert(p.labor.map((l, i) => ({ ...l, quote_id: quoteId, sort_order: i })));
    if (insLabor) return fail(new Error(insLabor.message));
  }

  revalidatePath(`/barge/${quoteId}`);
  revalidatePath("/barge");
  return { ok: true };
}

export async function deleteBargeQuote(quoteId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("barge_quotes")
    .delete()
    .eq("id", quoteId)
    .select("id");
  if (error) return fail(new Error(error.message));
  if (!data?.length)
    return {
      ok: false,
      error:
        "You don't have permission to delete this quote (admins can delete any quote; estimators only their own drafts)",
    };
  revalidatePath("/barge");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Workflow (DB functions own the state machine and thresholds)
// ---------------------------------------------------------------------------

export async function submitBargeQuote(quoteId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("submit_barge_quote", {
    p_quote_id: quoteId,
  });
  if (error) return fail(new Error(error.message));
  revalidatePath(`/barge/${quoteId}`);
  revalidatePath("/approvals");
  return { ok: true };
}

export async function approveBargeQuote(
  quoteId: string,
  comment: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("approve_barge_quote", {
    p_quote_id: quoteId,
    p_comment: comment || null,
  });
  if (error) return fail(new Error(error.message));
  revalidatePath(`/barge/${quoteId}`);
  revalidatePath("/approvals");
  return { ok: true };
}

export async function rejectBargeQuote(
  quoteId: string,
  comment: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("reject_barge_quote", {
    p_quote_id: quoteId,
    p_comment: comment,
  });
  if (error) return fail(new Error(error.message));
  revalidatePath(`/barge/${quoteId}`);
  revalidatePath("/approvals");
  return { ok: true };
}

export async function requestBargeQuoteChanges(
  quoteId: string,
  comment: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("request_barge_quote_changes", {
    p_quote_id: quoteId,
    p_comment: comment,
  });
  if (error) return fail(new Error(error.message));
  revalidatePath(`/barge/${quoteId}`);
  revalidatePath("/approvals");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Saved rough-quote configurations
// ---------------------------------------------------------------------------

export async function saveBargeConfig(
  configId: string | null,
  values: BargeConfigValues,
): Promise<ActionResult> {
  const parsed = configSchema.safeParse(values);
  if (!parsed.success) return { ok: false, error: "Invalid configuration" };

  const supabase = await createClient();
  const { error } = configId
    ? await supabase.from("barge_configs").update(parsed.data).eq("id", configId)
    : await supabase.from("barge_configs").insert(parsed.data);
  if (error) return fail(new Error(error.message));
  revalidatePath("/barge");
  revalidatePath("/barge/rough");
  return { ok: true };
}

export async function deleteBargeConfig(configId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("barge_configs")
    .delete()
    .eq("id", configId);
  if (error) return fail(new Error(error.message));
  revalidatePath("/barge");
  revalidatePath("/barge/rough");
  return { ok: true };
}
