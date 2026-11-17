"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import {
  SyncBusyError,
  planBalanceSheetSteps,
  runManualSync,
} from "@/lib/qbSyncSchedule";

type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Pull the prior month end's balance sheet from QuickBooks for every
 * connected company, now. Goes through the sync queue as a manual run, so it
 * can't overlap the nightly sync or the month-end pull (each rotates the
 * QuickBooks refresh token).
 */
export async function refreshBalanceSheet(): Promise<ActionResult> {
  const { profile } = await requireUser();
  if (profile.role !== "admin") {
    return { ok: false, error: "Only admins can refresh the balance sheet" };
  }

  try {
    const steps = await planBalanceSheetSteps();
    if (steps.length === 0) {
      return { ok: false, error: "QuickBooks is not connected" };
    }
    await runManualSync(steps);
    revalidatePath("/financials/balance-sheet");
    return { ok: true };
  } catch (e) {
    if (e instanceof SyncBusyError) return { ok: false, error: e.message };
    const message = e instanceof Error ? e.message : "Refresh failed";
    return {
      ok: false,
      error: /qb_sync_steps_kind_check/.test(message)
        ? "The balance sheet needs database migration 0043 (balance sheet) — apply it in Supabase, then try again."
        : message,
    };
  }
}
