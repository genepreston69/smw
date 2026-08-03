import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/fetchAll";
import {
  ROW_DIMS,
  SCOPES,
  SCOPE_CLASSIFICATIONS,
  buildPivot,
  lastDayOfMonth,
  monthLabel,
  pivotColLabel,
  resolveFinancialsState,
  type PivotCell,
  type PivotTotals,
} from "@/lib/financials";

// Excel export of the Financials pivot: same query params as /financials,
// same gl_pivot query, same buildPivot assembly — the file always matches
// the slice on screen.
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: connRows } = await supabase
    .from("qb_connection_status")
    .select("realm_id, company_name")
    .order("created_at");
  const companyByRealm = new Map(
    (connRows ?? []).map((c) => [
      c.realm_id as string,
      (c.company_name as string | null) ?? `Company ${c.realm_id}`,
    ]),
  );

  const url = new URL(request.url);
  const state = resolveFinancialsState(
    Object.fromEntries(url.searchParams),
    new Set(companyByRealm.keys()),
  );
  const { company, from, to, rows: rowDim, cols: colDim, scope } = state;

  const cells = (await fetchAllRows((fromRow, toRow) =>
    supabase
      .rpc("gl_pivot", {
        p_start: `${from}-01`,
        p_end: lastDayOfMonth(to),
        p_row_dim: rowDim,
        p_col_dim: colDim,
        p_realm_id: company === "all" ? null : company,
        p_classifications: SCOPE_CLASSIFICATIONS[scope],
      })
      .order("row_key")
      .order("col_key")
      .order("classification")
      .order("account_type")
      .range(fromRow, toRow),
  )) as PivotCell[];
  const pivot = buildPivot(cells, rowDim, scope);
  const showRowTotal = colDim !== "total";

  const rowLabel = ROW_DIMS.find((d) => d.key === rowDim)!.label;
  const scopeLabel = SCOPES.find((s) => s.key === scope)!.label;
  const colLabels = pivot.colKeys.map((k) =>
    pivotColLabel(colDim, k, companyByRealm),
  );

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Financials");

  sheet.addRow([`Financials — ${scopeLabel} by ${rowLabel}`]).font = {
    bold: true,
    size: 13,
  };
  sheet.addRow([
    [
      company === "all" ? "All companies" : companyByRealm.get(company),
      `${monthLabel(from)} – ${monthLabel(to)}`,
      "Amounts are natural signed ledger activity",
    ]
      .filter(Boolean)
      .join(" · "),
  ]);
  sheet.addRow([]);
  const header = sheet.addRow([
    rowLabel,
    ...colLabels,
    ...(showRowTotal ? ["Total"] : []),
  ]);
  header.font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 4 }];

  sheet.getColumn(1).width = 42;
  const moneyFmt = "#,##0.00";
  for (let i = 0; i < colLabels.length + (showRowTotal ? 1 : 0); i++) {
    const col = sheet.getColumn(i + 2);
    col.width = 15;
    col.numFmt = moneyFmt;
  }

  const totalsCells = (t: PivotTotals) => [
    ...pivot.colKeys.map((k) => t.bycol.get(k) ?? null),
    ...(showRowTotal ? [t.total] : []),
  ];

  for (const section of pivot.sections) {
    if (pivot.sectioned && pivot.sections.length > 1) {
      sheet.addRow([section.label]).font = { bold: true };
    }
    for (const r of section.rows) {
      sheet.addRow([
        r.key,
        ...pivot.colKeys.map((k) => r.cells.get(k) ?? null),
        ...(showRowTotal ? [r.total] : []),
      ]);
    }
    if (pivot.sectioned && pivot.sections.length > 1 && section.subtotal) {
      const row = sheet.addRow([
        `Total ${section.label}`,
        ...totalsCells(section.subtotal),
      ]);
      row.font = { bold: true };
    }
  }

  const summary = sheet.addRow(
    pivot.netIncome
      ? ["Net income", ...totalsCells(pivot.netIncome)]
      : [pivot.totalLabel, ...totalsCells(pivot.grand)],
  );
  summary.font = { bold: true };

  const buffer = await workbook.xlsx.writeBuffer();
  return new Response(Buffer.from(buffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="financials-${scope}-${rowDim}-by-${colDim}-${from}-to-${to}.xlsx"`,
    },
  });
}
