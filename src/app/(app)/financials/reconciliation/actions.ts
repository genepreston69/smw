"use server";

import { requireUser } from "@/lib/auth";
import {
  MAX_RECONCILE_FILE_BYTES,
  reconcileQbWorkbook,
} from "@/lib/reconcileServer";
import {
  PlParseError,
  type ReconciliationResult,
} from "@/lib/reconciliation";

export type ReconcileActionResult =
  | { ok: true; result: ReconciliationResult }
  | { ok: false; error: string };

/**
 * Parse an uploaded QuickBooks Profit and Loss export and reconcile it
 * against the imported general ledger through the last complete month.
 * The pipeline itself is shared with the Excel export route
 * (src/lib/reconcileServer.ts). GL data is admin-only and read through the
 * service-role client after the role check, same as every other Financials
 * read (see CLAUDE.md).
 */
export async function reconcileQbExport(
  formData: FormData,
): Promise<ReconcileActionResult> {
  const { profile } = await requireUser();
  if (profile.role !== "admin") {
    return { ok: false, error: "Only admins can run a reconciliation" };
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "Choose a QuickBooks Excel export to upload" };
  }
  if (file.size > MAX_RECONCILE_FILE_BYTES) {
    return { ok: false, error: "File is too large to be a QuickBooks export" };
  }

  try {
    return { ok: true, result: await reconcileQbWorkbook(await file.arrayBuffer()) };
  } catch (e) {
    if (e instanceof PlParseError) return { ok: false, error: e.message };
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Reconciliation failed",
    };
  }
}
