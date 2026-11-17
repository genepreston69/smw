"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { SETTING_SCHEMAS } from "@/lib/appSettings";

type ActionResult = { ok: true } | { ok: false; error: string };

const rulesSchema = z.object({
  budgetYear: SETTING_SCHEMAS.budget_year,
  benefitBaseAccounts: SETTING_SCHEMAS.benefit_base_accounts,
  intercompany: SETTING_SCHEMAS.intercompany_names,
});

/**
 * Save the admin-editable business rules (public.app_settings, migration
 * 0041). The role is checked here for a clear message; RLS on the table is
 * what actually stops a non-admin.
 */
export async function saveBusinessRules(
  input: z.input<typeof rulesSchema>,
): Promise<ActionResult> {
  const { supabase, profile } = await requireUser();
  if (profile.role !== "admin") {
    return { ok: false, error: "Only admins can change business rules" };
  }
  const parsed = rulesSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: issue ? `${issue.path.join(" › ") || "Input"}: ${issue.message}` : "Invalid input",
    };
  }
  const d = parsed.data;

  const { error } = await supabase.from("app_settings").upsert(
    [
      { key: "budget_year", value: d.budgetYear },
      { key: "benefit_base_accounts", value: d.benefitBaseAccounts },
      { key: "intercompany_names", value: d.intercompany },
    ].map((row) => ({
      ...row,
      updated_at: new Date().toISOString(),
      updated_by: profile.id,
    })),
    { onConflict: "org_id,key" },
  );
  if (error) {
    return {
      ok: false,
      error:
        error.code === "42P01" || error.code === "PGRST205"
          ? "Business rules need database migration 0041 (app settings) — apply it in Supabase, then try again."
          : error.message,
    };
  }

  // The rules reach nearly every page (job bucketing, budget, benefits).
  revalidatePath("/", "layout");
  return { ok: true };
}
