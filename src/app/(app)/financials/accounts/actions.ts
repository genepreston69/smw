"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/service";
import { refreshBenefitAllocation } from "@/lib/benefitAllocation";

type ActionResult = { ok: true } | { ok: false; error: string };

const categorySchema = z.object({
  accountId: z.string().uuid(),
  // Empty string clears the category.
  category: z
    .string()
    .trim()
    .max(80, "Category must be 80 characters or fewer")
    .transform((v) => v || null),
});

/**
 * Assign (or clear) the income-statement Category on one GL account.
 * GL data is admin-only and its RLS qual is too slow for app reads
 * (migrations 0014/0015), so the write follows the same pattern as the
 * Financials reads: verify the caller's role, then use the service-role
 * client.
 */
export async function setAccountCategory(
  accountId: string,
  category: string,
): Promise<ActionResult> {
  const { profile } = await requireUser();
  if (profile.role !== "admin") {
    return { ok: false, error: "Only admins can edit account categories" };
  }

  const parsed = categorySchema.safeParse({ accountId, category });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid category",
    };
  }

  const supabase = createServiceClient();
  const { error } = await supabase
    .from("gl_accounts")
    .update({ category: parsed.data.category })
    .eq("id", parsed.data.accountId);
  if (error) return { ok: false, error: error.message };

  // Categories are how the allocation finds its Employee Benefits, Salaries
  // & Wages, and Direct Labor accounts, so recategorizing moves the cached
  // per-job numbers (migration 0025).
  await refreshBenefitAllocation();

  revalidatePath("/financials/accounts");
  revalidatePath("/financials/statement");
  return { ok: true };
}
