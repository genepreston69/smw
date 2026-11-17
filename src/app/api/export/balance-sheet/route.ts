import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { asOfLabel } from "@/lib/balanceSheet";
import { balanceSheetState, loadBalanceSheet } from "@/lib/balanceSheetServer";
import { throwIfError } from "@/lib/supabase/throwIfError";

// Excel export of the Balance Sheet: same `?asOf=` param, same
// loadBalanceSheet read as /financials/balance-sheet, so the file always
// matches the screen. Lines nest under their section as Excel row groups.
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Admin-only, like the ledger; fails closed.
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = createServiceClient();
  const { data: connRows, error: connRowsError } = await db
    .from("qb_connection_status")
    .select("realm_id, company_name")
    .order("created_at");
  throwIfError("the connected QuickBooks companies", connRowsError);

  const sp = new URL(request.url).searchParams;
  const sheet = await loadBalanceSheet(
    db,
    balanceSheetState((k) => sp.get(k)),
    (connRows ?? []) as { realm_id: string; company_name: string | null }[],
  );
  if (sheet.migrationMissing) {
    return NextResponse.json(
      { error: "The Balance Sheet needs database migration 0043_balance_sheet.sql" },
      { status: 503 },
    );
  }

  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet("Balance Sheet");
  // Section headings sit above their lines.
  ws.properties.outlineProperties = { summaryBelow: false, summaryRight: false };

  ws.addRow(["Balance Sheet"]).font = { bold: true, size: 13 };
  ws.addRow([
    [
      `As of ${asOfLabel(sheet.asOf)}`,
      "From each company's QuickBooks balance sheet, accrual basis",
      sheet.columns.length > 1
        ? "Combined is the sum of the companies, with no intercompany eliminations"
        : null,
      sheet.missing.length > 0 ? `Not included: ${sheet.missing.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
  ]);
  ws.addRow([]);
  ws.addRow(["Account", ...sheet.columns.map((c) => c.label)]).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 4 }];

  ws.getColumn(1).width = 52;
  sheet.columns.forEach((_, i) => {
    const col = ws.getColumn(2 + i);
    col.width = 20;
    col.numFmt = "#,##0.00;[Red]-#,##0.00";
  });

  for (const r of sheet.rows) {
    const row = ws.addRow([
      r.label,
      ...sheet.columns.map((c) => r.amounts[c.key] ?? null),
    ]);
    row.getCell(1).alignment = { indent: r.depth * 2 };
    if (r.kind !== "account") row.font = { bold: true };
    // Excel allows seven outline levels.
    row.outlineLevel = Math.min(r.depth, 7);
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return new Response(Buffer.from(buffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="balance-sheet-${sheet.asOf}.xlsx"`,
    },
  });
}
