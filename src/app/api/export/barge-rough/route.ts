import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { parseConfigValues } from "@/lib/barge";
import { fileSlug, writeRoughQuoteSheet, xlsxResponse } from "@/lib/bargeWorkbook";

// Excel workbook for the Rough Quote Builder. The builder is live and unsaved,
// so its inputs ride in the URL (roughExportHref) and are parsed and priced
// by the builder's own rules (parseConfigValues, computeRoughQuote) — the
// file matches the screen. Nothing is saved.
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = new URL(request.url).searchParams;
  const values = parseConfigValues((params.get("name") ?? "").slice(0, 120), (key) =>
    params.get(key),
  );

  const workbook = new ExcelJS.Workbook();
  writeRoughQuoteSheet(workbook.addWorksheet("Rough Quote"), values);
  const stem = fileSlug(
    values.name,
    `${values.length_ft}x${values.beam_ft}x${values.depth_ft}`.replace(/[^\w-]/g, "-"),
  );
  return xlsxResponse(workbook, `barge-rough-quote-${stem}.xlsx`);
}
