import "server-only";

import ExcelJS from "exceljs";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchAllRows } from "@/lib/supabase/fetchAll";
import { latestMonth, type PivotCell } from "@/lib/financials";
import {
  PlParseError,
  buildReconciliation,
  omitMonthsAfter,
  parsePlWorkbook,
  type GridValue,
  type ReconciliationResult,
} from "@/lib/reconciliation";

// Shared pipeline for the Reconciliation page action and the Excel export
// route: both feed the same uploaded QuickBooks P&L workbook through the
// same parse → truncate → compare steps, so the export always matches the
// screen. Callers handle auth; everything here assumes an admin.

// QuickBooks P&L exports are tens of KB; anything near the server-action
// body limit isn't one.
export const MAX_RECONCILE_FILE_BYTES = 4 * 1024 * 1024;

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
 * against the imported general ledger. The export is truncated at the last
 * complete month first (omitMonthsAfter) — the in-progress month is omitted
 * app-wide and a partial month can never tie anyway. Throws PlParseError
 * with a user-facing message for anything wrong with the file.
 */
export async function reconcileQbWorkbook(
  buffer: ArrayBuffer,
): Promise<ReconciliationResult> {
  let grid: GridValue[][];
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new Error("no sheets");
    grid = [];
    sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const values: GridValue[] = [];
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        values[colNumber - 1] = cellValue(cell.value);
      });
      grid[rowNumber - 1] = values;
    });
  } catch {
    throw new PlParseError(
      "Couldn't read the file — upload the .xlsx exported from QuickBooks.",
    );
  }

  const parsed = omitMonthsAfter(parsePlWorkbook(grid), latestMonth());

  const supabase = createServiceClient();
  const glSlice = (rowDim: string, realmId: string | null, classifications: string[]) =>
    fetchAllRows((fromRow, toRow) =>
      supabase
        .rpc("gl_pivot", {
          p_start: parsed.start,
          p_end: parsed.end,
          p_row_dim: rowDim,
          p_col_dim: "month",
          p_realm_id: realmId,
          p_classifications: classifications,
        })
        .order("row_key")
        .order("col_key")
        .order("classification")
        .order("account_type")
        .range(fromRow, toRow),
    ) as Promise<PivotCell[]>;

  // The rec always compares the consolidated export against every company
  // combined, so the Intercompany eliminations always apply — one
  // revenue-by-customer slice per company, exactly as the Financials and
  // Income Statement pages fetch them on the All companies view.
  const { data: connRows } = await supabase
    .from("qb_connection_status")
    .select("realm_id, company_name");
  const [glCells, eliminationSlices] = await Promise.all([
    glSlice("account", null, ["Revenue", "Expense"]),
    Promise.all(
      ((connRows ?? []) as { realm_id: string; company_name: string | null }[]).map(
        async (c) => ({
          realmId: c.realm_id,
          companyName: c.company_name,
          cells: await glSlice("customer", c.realm_id, ["Revenue"]),
        }),
      ),
    ),
  ]);

  return buildReconciliation(parsed, glCells, eliminationSlices);
}
