"use server";

import ExcelJS from "exceljs";
import { requireUser } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchAllRows } from "@/lib/supabase/fetchAll";
import type { PivotCell } from "@/lib/financials";
import {
  PlParseError,
  buildReconciliation,
  parsePlWorkbook,
  type GridValue,
  type ReconciliationResult,
} from "@/lib/reconciliation";

export type ReconcileActionResult =
  | { ok: true; result: ReconciliationResult }
  | { ok: false; error: string };

// QuickBooks P&L exports are tens of KB; anything near the server-action
// body limit isn't one.
const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** Flatten one ExcelJS cell to the plain value the parser works on. */
function cellValue(value: ExcelJS.CellValue): GridValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "string") return value;
  if (value instanceof Date) return value;
  if (typeof value === "object") {
    if ("result" in value) return cellValue(value.result as ExcelJS.CellValue);
    if ("richText" in value) {
      return value.richText.map((r) => r.text).join("");
    }
    if ("text" in value && typeof value.text === "string") return value.text;
    if ("error" in value) return null;
  }
  return null;
}

/**
 * Parse an uploaded QuickBooks Profit and Loss export and reconcile it
 * against the imported general ledger for the same period. GL data is
 * admin-only and read through the service-role client after the role check,
 * same as every other Financials read (see CLAUDE.md).
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
  if (file.size > MAX_FILE_BYTES) {
    return { ok: false, error: "File is too large to be a QuickBooks export" };
  }

  let grid: GridValue[][];
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await file.arrayBuffer());
    const sheet = workbook.worksheets[0];
    if (!sheet) return { ok: false, error: "The workbook has no sheets" };
    grid = [];
    sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const values: GridValue[] = [];
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        values[colNumber - 1] = cellValue(cell.value);
      });
      grid[rowNumber - 1] = values;
    });
  } catch {
    return {
      ok: false,
      error:
        "Couldn't read the file — upload the .xlsx exported from QuickBooks.",
    };
  }

  try {
    const parsed = parsePlWorkbook(grid);

    const supabase = createServiceClient();
    const glCells = (await fetchAllRows((fromRow, toRow) =>
      supabase
        .rpc("gl_pivot", {
          p_start: parsed.start,
          p_end: parsed.end,
          p_row_dim: "account",
          p_col_dim: "month",
          p_realm_id: null,
          p_classifications: ["Revenue", "Expense"],
        })
        .order("row_key")
        .order("col_key")
        .order("classification")
        .order("account_type")
        .range(fromRow, toRow),
    )) as PivotCell[];

    return { ok: true, result: buildReconciliation(parsed, glCells) };
  } catch (e) {
    if (e instanceof PlParseError) return { ok: false, error: e.message };
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Reconciliation failed",
    };
  }
}
