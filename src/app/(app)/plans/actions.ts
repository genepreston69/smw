"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

type ActionResult = { ok: true } | { ok: false; error: string };

function fail(error: unknown): ActionResult {
  const message =
    error instanceof Error ? error.message : "Something went wrong";
  // Supabase errors carry the raised exception text after the code prefix.
  return { ok: false, error: message.replace(/^.*?exception: /i, "") };
}

// ---------------------------------------------------------------------------
// Plan CRUD
// ---------------------------------------------------------------------------

export async function createPlan(formData: FormData) {
  const title = String(formData.get("title") ?? "").trim();
  const customerId = String(formData.get("customer_id") ?? "") || null;
  const jobId = String(formData.get("job_id") ?? "") || null;
  if (!title) throw new Error("Title is required");

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("project_plans")
    .insert({ title, customer_id: customerId, job_id: jobId })
    .select("id")
    .single();

  if (error) throw new Error(error.message);
  redirect(`/plans/${data.id}`);
}

const planFieldsSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  customer_id: z.string().uuid().nullable().optional(),
  job_id: z.string().uuid().nullable().optional(),
  department: z.string().nullable().optional(),
  project_manager: z.string().nullable().optional(),
  contact_name: z.string().nullable().optional(),
  contact_phone: z.string().nullable().optional(),
  contact_email: z.string().nullable().optional(),
  start_date: z.string().nullable().optional(),
  end_date: z.string().nullable().optional(),
  payment_terms_days: z.number().int().nullable().optional(),
  notes: z.string().nullable().optional(),
  labor_cost_rate: z.number().min(0).optional(),
  default_labor_bill_rate: z.number().min(0).optional(),
  consumables_pct: z.number().min(0).max(1).optional(),
  overhead_pool: z.number().min(0).nullable().optional(),
});

export async function updatePlanFields(
  planId: string,
  fields: z.infer<typeof planFieldsSchema>,
): Promise<ActionResult> {
  const parsed = planFieldsSchema.safeParse(fields);
  if (!parsed.success) return { ok: false, error: "Invalid plan fields" };

  const supabase = await createClient();
  const { error } = await supabase
    .from("project_plans")
    .update(parsed.data)
    .eq("id", planId);

  if (error) return fail(new Error(error.message));
  revalidatePath(`/plans/${planId}`);
  return { ok: true };
}

export async function deletePlan(planId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("project_plans")
    .delete()
    .eq("id", planId)
    .select("id");
  if (error) return fail(new Error(error.message));
  // RLS silently matches zero rows when the caller lacks delete rights.
  if (!data?.length)
    return {
      ok: false,
      error:
        "You don't have permission to delete this plan (admins can delete any plan; estimators only their own drafts)",
    };
  revalidatePath("/plans");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

export async function addPhase(
  planId: string,
  name: string,
): Promise<ActionResult> {
  if (!name.trim()) return { ok: false, error: "Phase name is required" };
  const supabase = await createClient();
  const { data: maxRow } = await supabase
    .from("plan_phases")
    .select("sort_order")
    .eq("plan_id", planId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { error } = await supabase.from("plan_phases").insert({
    plan_id: planId,
    name: name.trim(),
    sort_order: (maxRow?.sort_order ?? -1) + 1,
  });
  if (error) return fail(new Error(error.message));
  revalidatePath(`/plans/${planId}`);
  return { ok: true };
}

export async function renamePhase(
  planId: string,
  phaseId: string,
  name: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("plan_phases")
    .update({ name: name.trim() })
    .eq("id", phaseId);
  if (error) return fail(new Error(error.message));
  revalidatePath(`/plans/${planId}`);
  return { ok: true };
}

export async function deletePhase(
  planId: string,
  phaseId: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("plan_phases")
    .delete()
    .eq("id", phaseId);
  if (error) return fail(new Error(error.message));
  revalidatePath(`/plans/${planId}`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Line items
// ---------------------------------------------------------------------------

const lineItemSchema = z.object({
  phase_id: z.string().uuid().nullable(),
  description: z.string(),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  is_tbd: z.boolean(),
  events: z.number().min(0),
  hours_per_piece: z.number().min(0),
  quantity: z.number().min(0),
  labor_bill_rate: z.number().min(0).nullable(),
  material_basis: z.enum(["per_lb", "per_each", "per_sf", "lump_sum"]),
  length_per_piece: z.number().min(0),
  weight_per_lf: z.number().min(0),
  unit_cost: z.number().min(0),
  lump_sum_cost: z.number().min(0),
  material_markup_pct: z.number().min(0),
});

export type LineItemInput = z.infer<typeof lineItemSchema>;

export async function addLineItem(
  planId: string,
  item: LineItemInput,
): Promise<ActionResult> {
  const parsed = lineItemSchema.safeParse(item);
  if (!parsed.success) return { ok: false, error: "Invalid line item" };

  const supabase = await createClient();
  const { data: maxRow } = await supabase
    .from("plan_line_items")
    .select("sort_order")
    .eq("plan_id", planId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { error } = await supabase.from("plan_line_items").insert({
    ...parsed.data,
    plan_id: planId,
    sort_order: (maxRow?.sort_order ?? -1) + 1,
  });
  if (error) return fail(new Error(error.message));
  revalidatePath(`/plans/${planId}`);
  return { ok: true };
}

export async function updateLineItem(
  planId: string,
  itemId: string,
  item: LineItemInput,
): Promise<ActionResult> {
  const parsed = lineItemSchema.safeParse(item);
  if (!parsed.success) return { ok: false, error: "Invalid line item" };

  const supabase = await createClient();
  const { error } = await supabase
    .from("plan_line_items")
    .update(parsed.data)
    .eq("id", itemId);
  if (error) return fail(new Error(error.message));
  revalidatePath(`/plans/${planId}`);
  return { ok: true };
}

export async function deleteLineItem(
  planId: string,
  itemId: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("plan_line_items")
    .delete()
    .eq("id", itemId);
  if (error) return fail(new Error(error.message));
  revalidatePath(`/plans/${planId}`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Workflow (DB functions own the state machine, TBD gate, and thresholds)
// ---------------------------------------------------------------------------

export async function submitPlan(planId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("submit_plan", { p_plan_id: planId });
  if (error) return fail(new Error(error.message));
  revalidatePath(`/plans/${planId}`);
  return { ok: true };
}

export async function approvePlan(
  planId: string,
  comment: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("approve_plan", {
    p_plan_id: planId,
    p_comment: comment || null,
  });
  if (error) return fail(new Error(error.message));
  revalidatePath(`/plans/${planId}`);
  revalidatePath("/approvals");
  return { ok: true };
}

export async function rejectPlan(
  planId: string,
  comment: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("reject_plan", {
    p_plan_id: planId,
    p_comment: comment,
  });
  if (error) return fail(new Error(error.message));
  revalidatePath(`/plans/${planId}`);
  revalidatePath("/approvals");
  return { ok: true };
}

export async function requestChanges(
  planId: string,
  comment: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("request_changes", {
    p_plan_id: planId,
    p_comment: comment,
  });
  if (error) return fail(new Error(error.message));
  revalidatePath(`/plans/${planId}`);
  revalidatePath("/approvals");
  return { ok: true };
}
