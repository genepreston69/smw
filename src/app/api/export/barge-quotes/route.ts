import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  loadBargeQuoteExports,
  sheetNamer,
  writeQuoteSheet,
  writeQuotesSummarySheet,
  xlsxResponse,
} from "@/lib/bargeWorkbook";

// Excel workbook of every barge quote (the Barge Program page's Export all
// quotes): an All Quotes summary, newest first, linking to one sheet per
// quote — the same sheet /api/export/barge-quote writes for a single quote.
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const quotes = await loadBargeQuoteExports(supabase, null);

  const workbook = new ExcelJS.Workbook();
  const sheetName = sheetNamer();
  const summary = workbook.addWorksheet(sheetName("All Quotes"));
  const sheets = quotes.map((x) => ({ x, sheetName: sheetName(x.quote.name) }));
  writeQuotesSummarySheet(summary, sheets);
  for (const { x, sheetName: name } of sheets) writeQuoteSheet(workbook.addWorksheet(name), x);

  return xlsxResponse(workbook, "barge-quotes.xlsx");
}
