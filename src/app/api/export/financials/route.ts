import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchAllRows } from "@/lib/supabase/fetchAll";
import {
  ROW_DIMS,
  SCOPES,
  SCOPE_CLASSIFICATIONS,
  buildEliminations,
  buildPivot,
  lastDayOfMonth,
  monthLabel,
  pivotColLabel,
  resolveFinancialsState,
  revenueByCol,
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

  // Financials are admin-only (RLS on the gl_* tables enforces this; the
  // 403 gives direct callers a clear error instead of an empty workbook).
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Admin verified; the reads below go through the service-role client
  // because the admin RLS qual on the gl_* tables pushes gl_pivot past the
  // statement timeout. RLS still guards those tables against direct API
  // access.
  const db = createServiceClient();

  const { data: connRows } = await db
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
  const { company, from, to, rows: rowDim, cols: colDim, scope, display } = state;

  // Same slices as the Financials page: the pivot itself plus, under the Net
  // income scope on the All companies view, one revenue-by-customer slice per
  // company for the Intercompany eliminations section below the Net income
  // line (per company because the Marathon billing-agent rule depends on
  // which company booked the revenue). Eliminations are a consolidation
  // adjustment, so single-company exports skip them entirely.
  const eliminationRealms =
    scope === "pl" && company === "all" ? [...companyByRealm.keys()] : [];
  // Same as the page: the % of revenue display divides by each column's total
  // revenue, and only the expense-only scope lacks the Revenue cells to
  // derive that from the pivot itself.
  const needsRevenueSlice = display === "pct" && scope === "expense";
  const [cells, eliminationSlices, revenueCells] = await Promise.all([
    fetchAllRows((fromRow, toRow) =>
      db
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
    ) as Promise<PivotCell[]>,
    Promise.all(
      eliminationRealms.map(async (realmId) => ({
        realmId,
        companyName: companyByRealm.get(realmId) ?? null,
        cells: (await fetchAllRows((fromRow, toRow) =>
          db
            .rpc("gl_pivot", {
              p_start: `${from}-01`,
              p_end: lastDayOfMonth(to),
              p_row_dim: "customer",
              p_col_dim: colDim,
              p_realm_id: realmId,
              p_classifications: SCOPE_CLASSIFICATIONS.income,
            })
            .order("row_key")
            .order("col_key")
            .order("classification")
            .order("account_type")
            .range(fromRow, toRow),
        )) as PivotCell[],
      })),
    ),
    needsRevenueSlice
      ? (fetchAllRows((fromRow, toRow) =>
          db
            .rpc("gl_pivot", {
              p_start: `${from}-01`,
              p_end: lastDayOfMonth(to),
              p_row_dim: "account",
              p_col_dim: colDim,
              p_realm_id: company === "all" ? null : company,
              p_classifications: SCOPE_CLASSIFICATIONS.income,
            })
            .order("row_key")
            .order("col_key")
            .order("classification")
            .order("account_type")
            .range(fromRow, toRow),
        ) as Promise<PivotCell[]>)
      : Promise.resolve([] as PivotCell[]),
  ]);
  const pivot = buildPivot(cells, rowDim, scope);
  const revenueTotals =
    display === "pct"
      ? revenueByCol(needsRevenueSlice ? revenueCells : cells)
      : null;
  const eliminations =
    scope === "pl" && company === "all"
      ? buildEliminations(eliminationSlices, pivot.netIncome ?? pivot.grand)
      : null;
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
      ...(revenueTotals
        ? ["Common-size: cells are a percent of the column's total revenue"]
        : []),
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
  const cellFmt = revenueTotals ? "0.0%" : "#,##0.00";
  for (let i = 0; i < colLabels.length + (showRowTotal ? 1 : 0); i++) {
    const col = sheet.getColumn(i + 2);
    col.width = 15;
    col.numFmt = cellFmt;
  }

  // Under the % of revenue display, cells are written as fractions of the
  // column's total revenue (colKey null = row total ÷ total revenue) and the
  // percent number format above renders them.
  const outVal = (v: number | null | undefined, colKey: string | null) => {
    if (v == null) return null;
    if (!revenueTotals) return v;
    const denom =
      colKey === null
        ? revenueTotals.total
        : (revenueTotals.bycol.get(colKey) ?? 0);
    return denom !== 0 ? v / denom : null;
  };

  const totalsCells = (t: PivotTotals) => [
    ...pivot.colKeys.map((k) => outVal(t.bycol.get(k) ?? null, k)),
    ...(showRowTotal ? [outVal(t.total, null)] : []),
  ];

  for (const section of pivot.sections) {
    if (pivot.sectioned && pivot.sections.length > 1) {
      sheet.addRow([section.label]).font = { bold: true };
    }
    for (const r of section.rows) {
      sheet.addRow([
        r.key,
        ...pivot.colKeys.map((k) => outVal(r.cells.get(k) ?? null, k)),
        ...(showRowTotal ? [outVal(r.total, null)] : []),
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

  if (eliminations) {
    sheet.addRow(["Intercompany eliminations"]).font = { bold: true };
    for (const line of eliminations.lines) {
      sheet.addRow([line.label, ...totalsCells(line.totals)]);
    }
    const adjusted = sheet.addRow([
      "Net income after eliminations",
      ...totalsCells(eliminations.adjusted),
    ]);
    adjusted.font = { bold: true };
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return new Response(Buffer.from(buffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="financials-${scope}-${rowDim}-by-${colDim}${display === "pct" ? "-pct-of-revenue" : ""}-${from}-to-${to}.xlsx"`,
    },
  });
}
