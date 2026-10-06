"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { NO_CLASS } from "@/lib/budget";
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

// A QuickBooks class as the budget keys it (migration 0034); blank means no
// class.
const classField = z
  .string()
  .trim()
  .max(300, "Class name is too long")
  .transform((v) => v || NO_CLASS);

const pctField = z.coerce
  .number({ message: "Growth must be a number" })
  .min(-100, "Growth can't be below -100%")
  .max(1000, "Growth can't exceed 1000%");

const assumptionSchema = z
  .object({
    budgetYear: z.number().int(),
    realmId: z.string().min(1),
    revenueGrowthPct: pctField,
    expenseGrowthPct: pctField,
    // The company's complete set of category rates; a category left out
    // grows at the default (and loses any rate it had).
    categories: z.array(
      z.object({
        classification: z.enum(["Revenue", "Expense"]),
        category: z.string().min(1).max(80),
        growthPct: pctField,
      }),
    ),
  })
  .refine(
    (d) =>
      new Set(d.categories.map((c) => `${c.classification}:${c.category}`)).size ===
      d.categories.length,
    "A category can only have one growth rate",
  );

/** Saves one company's default revenue / expense growth and its category
    rates together (save_budget_assumptions, migration 0028). */
export async function saveAssumption(
  input: z.input<typeof assumptionSchema>,
): Promise<ActionResult> {
  const profile = await requireAdminAction();
  if (!profile) return DENIED;
  const parsed = assumptionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const d = parsed.data;

  const supabase = createServiceClient();
  const { error } = await supabase.rpc("save_budget_assumptions", {
    p_budget_year: d.budgetYear,
    p_realm_id: d.realmId,
    p_revenue_growth_pct: d.revenueGrowthPct,
    p_expense_growth_pct: d.expenseGrowthPct,
    p_categories: d.categories.map((c) => ({
      classification: c.classification,
      category: c.category,
      growth_pct: c.growthPct,
    })),
    p_updated_by: profile.id,
  });
  if (error) return fail(error);

  // No revalidatePath: the page already re-prices the budget client-side as
  // the assumption is typed, so re-rendering the server page (a full ledger
  // read) on save would be wasted work. The page is dynamic, so the next
  // load reads the saved value.
  return { ok: true };
}

const overridesSchema = z
  .object({
    budgetYear: z.number().int(),
    realmId: z.string().min(1),
    account: z.string().trim().min(1).max(300),
    className: classField,
    classification: z.enum(["Revenue", "Expense"]),
    // The account × class's complete set of typed months; a month left out
    // returns to its growth-based amount. Empty resets the account in that
    // class.
    months: z
      .array(
        z.object({
          month: z.number().int().min(1).max(12),
          amount: z.coerce
            .number({ message: "Budget amount must be a number" })
            .min(-1_000_000_000, "Budget amount is too large")
            .max(1_000_000_000, "Budget amount is too large"),
        }),
      )
      .max(12),
  })
  .refine(
    (d) => new Set(d.months.map((m) => m.month)).size === d.months.length,
    "A month can only have one amount",
  );

/** Replaces one account's typed budget months in one class
    (set_budget_account_overrides, migrations 0031 / 0034). Called as each
    cell is committed on the budget statement, so typed figures save as you
    go. */
export async function saveAccountOverrides(
  input: z.input<typeof overridesSchema>,
): Promise<ActionResult> {
  const profile = await requireAdminAction();
  if (!profile) return DENIED;
  const parsed = overridesSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const d = parsed.data;

  const supabase = createServiceClient();
  const { error } = await supabase.rpc("set_budget_account_overrides", {
    p_budget_year: d.budgetYear,
    p_realm_id: d.realmId,
    p_account: d.account,
    p_class_name: d.className,
    p_classification: d.classification,
    p_months: d.months,
    p_updated_by: profile.id,
  });
  if (error) return fail(error);
  // No revalidatePath, as with saveAssumption: the page already shows the
  // typed figure.
  return { ok: true };
}

const initiativeSchema = z
  .object({
    id: z.string().uuid().nullable(),
    budgetYear: z.number().int(),
    realmId: z.string().min(1, "Choose a company"),
    className: classField,
    name: z.string().trim().min(1, "Name the initiative").max(120),
    description: z
      .string()
      .trim()
      .max(2000)
      .transform((v) => v || null),
    startMonth: z.number().int().min(1).max(12),
    endMonth: z.number().int().min(1).max(12),
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
  })
  .refine(
    (d) => d.endMonth >= d.startMonth,
    "The end month can't be before the start month",
  );

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
    class_name: d.className,
    name: d.name,
    description: d.description,
    start_month: d.startMonth,
    end_month: d.endMonth,
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
    details: {
      name: d.name,
      realm_id: d.realmId,
      class_name: d.className,
      start_month: d.startMonth,
      end_month: d.endMonth,
      lines: d.lines.length,
    },
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
