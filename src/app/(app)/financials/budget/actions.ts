"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/service";

type ActionResult = { ok: true } | { ok: false; error: string };

// Budget data is admin-only, same as the ledger it's built from: verify the
// caller's role, then write through the service-role client (the pattern the
// Chart of Accounts action uses; see migrations 0014/0015/0026).
async function requireAdminAction() {
  const { profile } = await requireUser();
  if (profile.role !== "admin") return null;
  return profile;
}

const DENIED: ActionResult = { ok: false, error: "Only admins can edit the budget" };

function fail(error: { message: string }): ActionResult {
  // Strip Postgres prefixes so guard-trigger messages read cleanly.
  return { ok: false, error: error.message.replace(/^.*?ERROR:\s*/, "") };
}

const firstIssue = (e: z.ZodError) => e.issues[0]?.message ?? "Invalid input";

const pctField = z.coerce
  .number({ message: "Growth must be a number" })
  .min(-100, "Growth can't be below -100%")
  .max(1000, "Growth can't exceed 1000%");

const assumptionSchema = z.object({
  budgetYear: z.number().int(),
  realmId: z.string().min(1),
  revenueGrowthPct: pctField,
  expenseGrowthPct: pctField,
});

export async function saveAssumption(
  input: z.input<typeof assumptionSchema>,
): Promise<ActionResult> {
  const profile = await requireAdminAction();
  if (!profile) return DENIED;
  const parsed = assumptionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const d = parsed.data;

  const supabase = createServiceClient();
  const { error } = await supabase.from("budget_assumptions").upsert(
    {
      budget_year: d.budgetYear,
      realm_id: d.realmId,
      revenue_growth_pct: d.revenueGrowthPct,
      expense_growth_pct: d.expenseGrowthPct,
      updated_by: profile.id,
    },
    { onConflict: "org_id,budget_year,realm_id" },
  );
  if (error) return fail(error);

  // No revalidatePath: the page re-prices the budget client-side as the
  // assumption is typed, and re-rendering the server page (a full ledger
  // read) on every auto-save would be wasted work. The page is dynamic, so
  // the next load reads the saved value.
  return { ok: true };
}

const initiativeSchema = z.object({
  id: z.string().uuid().nullable(),
  budgetYear: z.number().int(),
  realmId: z.string().min(1, "Choose a company"),
  name: z.string().trim().min(1, "Name the initiative").max(120),
  description: z
    .string()
    .trim()
    .max(2000)
    .transform((v) => v || null),
  startMonth: z.number().int().min(1).max(12),
  lines: z
    .array(
      z.object({
        accountName: z.string().min(1),
        classification: z.enum(["Revenue", "Expense"]),
        annualAmount: z.number().finite(),
      }),
    )
    .transform((ls) => ls.filter((l) => l.annualAmount !== 0))
    .refine((ls) => ls.length > 0, "Enter an amount for at least one account")
    .refine(
      (ls) => new Set(ls.map((l) => l.accountName)).size === ls.length,
      "Each account can appear only once",
    ),
});

/** Create or update a proposed initiative and replace its account lines. */
export async function saveInitiative(
  input: z.input<typeof initiativeSchema>,
): Promise<ActionResult> {
  const profile = await requireAdminAction();
  if (!profile) return DENIED;
  const parsed = initiativeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const d = parsed.data;

  const supabase = createServiceClient();
  let id = d.id;
  const header = {
    budget_year: d.budgetYear,
    realm_id: d.realmId,
    name: d.name,
    description: d.description,
    start_month: d.startMonth,
  };

  if (id) {
    const { data: existing, error: readError } = await supabase
      .from("budget_initiatives")
      .select("status")
      .eq("id", id)
      .single();
    if (readError) return fail(readError);
    if (existing.status !== "proposed") {
      return {
        ok: false,
        error: "Only proposed initiatives can be edited; return it to proposed first",
      };
    }
    const { error } = await supabase
      .from("budget_initiatives")
      .update(header)
      .eq("id", id);
    if (error) return fail(error);
    const { error: delError } = await supabase
      .from("budget_initiative_lines")
      .delete()
      .eq("initiative_id", id);
    if (delError) return fail(delError);
  } else {
    const { data, error } = await supabase
      .from("budget_initiatives")
      .insert({ ...header, created_by: profile.id })
      .select("id")
      .single();
    if (error) return fail(error);
    id = data.id as string;
  }

  const { error: lineError } = await supabase.from("budget_initiative_lines").insert(
    d.lines.map((l) => ({
      initiative_id: id,
      account_name: l.accountName,
      classification: l.classification,
      annual_amount: l.annualAmount,
    })),
  );
  if (lineError) return fail(lineError);

  await supabase.from("audit_log").insert({
    entity_type: "budget_initiative",
    entity_id: id,
    action: d.id ? "updated" : "created",
    actor_id: profile.id,
    details: { name: d.name, realm_id: d.realmId, lines: d.lines.length },
  });

  revalidatePath("/financials/budget");
  return { ok: true };
}

const statusSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["proposed", "approved", "rejected"]),
});

/**
 * Move an initiative between proposed / approved / rejected. Only an
 * approved initiative is folded into the budget; approving stamps who and
 * when, and returning it to proposed (to edit it) clears that.
 */
export async function setInitiativeStatus(
  id: string,
  status: "proposed" | "approved" | "rejected",
): Promise<ActionResult> {
  const profile = await requireAdminAction();
  if (!profile) return DENIED;
  const parsed = statusSchema.safeParse({ id, status });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  const supabase = createServiceClient();
  const { data: existing, error: readError } = await supabase
    .from("budget_initiatives")
    .select("status, name")
    .eq("id", id)
    .single();
  if (readError) return fail(readError);
  if (existing.status === status) return { ok: true };

  const { error } = await supabase
    .from("budget_initiatives")
    .update({
      status,
      approved_by: status === "approved" ? profile.id : null,
      approved_at: status === "approved" ? new Date().toISOString() : null,
    })
    .eq("id", id);
  if (error) return fail(error);

  await supabase.from("audit_log").insert({
    entity_type: "budget_initiative",
    entity_id: id,
    action: status === "proposed" ? "returned_to_proposed" : status,
    actor_id: profile.id,
    details: { name: existing.name, from: existing.status, to: status },
  });

  revalidatePath("/financials/budget");
  return { ok: true };
}

/** Delete a proposed or rejected initiative (approved ones must be returned
    to proposed first, so an approved number never silently vanishes). */
export async function deleteInitiative(id: string): Promise<ActionResult> {
  const profile = await requireAdminAction();
  if (!profile) return DENIED;
  if (!z.string().uuid().safeParse(id).success) {
    return { ok: false, error: "Invalid initiative" };
  }

  const supabase = createServiceClient();
  const { data: existing, error: readError } = await supabase
    .from("budget_initiatives")
    .select("status, name")
    .eq("id", id)
    .single();
  if (readError) return fail(readError);
  if (existing.status === "approved") {
    return {
      ok: false,
      error: "Return an approved initiative to proposed before deleting it",
    };
  }

  const { error } = await supabase.from("budget_initiatives").delete().eq("id", id);
  if (error) return fail(error);

  await supabase.from("audit_log").insert({
    entity_type: "budget_initiative",
    entity_id: id,
    action: "deleted",
    actor_id: profile.id,
    details: { name: existing.name },
  });

  revalidatePath("/financials/budget");
  return { ok: true };
}
