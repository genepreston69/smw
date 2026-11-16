"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/service";
import { refreshBenefitAllocation } from "@/lib/benefitAllocation";
import { syncChartOfAccounts } from "@/lib/quickbooks";

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

/**
 * Refresh the chart of accounts from QuickBooks (accounts only — no ledger
 * import). Existing accounts keep their categories; the result reports how
 * many accounts are new so the page can point the admin at them.
 */
export async function refreshChartOfAccounts(): Promise<
  { ok: true; added: number; accounts: number } | { ok: false; error: string }
> {
  const { profile } = await requireUser();
  if (profile.role !== "admin") {
    return { ok: false, error: "Only admins can refresh the chart of accounts" };
  }

  try {
    const result = await syncChartOfAccounts();
    // The allocation matches accounts by name as well as category, so a
    // rename in QuickBooks can move the cached per-job numbers.
    await refreshBenefitAllocation();
    revalidatePath("/financials/accounts");
    revalidatePath("/financials/statement");
    return { ok: true, added: result.added, accounts: result.accounts };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Refresh failed",
    };
  }
}
