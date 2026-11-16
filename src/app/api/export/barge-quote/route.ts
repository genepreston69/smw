import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  fileSlug,
  loadBargeQuoteExports,
  sheetNamer,
  writeQuoteSheet,
  xlsxResponse,
} from "@/lib/bargeWorkbook";

// Excel workbook for one saved barge quote (the workbench's Export Excel):
// header, pricing inputs, P&L in both cost views, steel takeoff, labor,
// sensitivity grids, and approval history, from the SQL cost views.
//
// ?id=<quote uuid>
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const id = new URL(request.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing id parameter" }, { status: 400 });
  }

  const [quote] = await loadBargeQuoteExports(supabase, id);
  if (!quote) {
    return NextResponse.json({ error: "Quote not found" }, { status: 404 });
  }

  const workbook = new ExcelJS.Workbook();
  writeQuoteSheet(workbook.addWorksheet(sheetNamer()(quote.quote.name)), quote);
  return xlsxResponse(workbook, `barge-quote-${fileSlug(quote.quote.name, "quote")}.xlsx`);
}
