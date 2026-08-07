import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchAllRows } from "@/lib/supabase/fetchAll";
import {
  COL_DIMS,
  MONTH_PARAM,
  SCOPE_CLASSIFICATIONS,
  buildCategoryStatement,
  buildEliminations,
  currentMonth,
  defaultFrom,
  lastDayOfMonth,
  monthLabel,
  pivotColLabel,
  serializeEliminations,
  type ColDim,
  type PivotCell,
  type PivotTotals,
  type StatementSection,
  type StatementTotals,
} from "@/lib/financials";

// Excel export of the category income statement: same query params as
// /financials/statement, same gl_pivot slice and buildCategoryStatement
// assembly — the file always matches the statement on screen, with account
// rows indented and grouped under their category header and a
// "Total {Category}" subtotal line closing each group.
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // GL data is admin-only (RLS on the gl_* tables enforces this; the 403
  // gives direct callers a clear error instead of an empty workbook).
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

  const sp = new URL(request.url).searchParams;
  const company =
    sp.get("company") && companyByRealm.has(sp.get("company")!)
      ? sp.get("company")!
      : "all";
  const from = MONTH_PARAM.test(sp.get("from") ?? "")
    ? sp.get("from")!
    : defaultFrom();
  const to = MONTH_PARAM.test(sp.get("to") ?? "") ? sp.get("to")! : currentMonth();
  const colDim = COL_DIMS.some((d) => d.key === sp.get("cols"))
    ? (sp.get("cols") as ColDim)
    : "month";

  // Same slices as the statement page: the account pivot plus, on the All
  // companies view, one revenue-by-customer slice per company for the
  // Intercompany eliminations below the Net income line. Eliminations are a
  // consolidation adjustment, so single-company exports skip them entirely.
  const eliminationRealms =
    company === "all" ? [...companyByRealm.keys()] : [];
  const [cells, accountRows, eliminationSlices] = await Promise.all([
    fetchAllRows((fromRow, toRow) =>
      db
        .rpc("gl_pivot", {
          p_start: `${from}-01`,
          p_end: lastDayOfMonth(to),
          p_row_dim: "account",
          p_col_dim: colDim,
          p_realm_id: company === "all" ? null : company,
          p_classifications: SCOPE_CLASSIFICATIONS.pl,
        })
        .order("row_key")
        .order("col_key")
        .order("classification")
        .order("account_type")
        .range(fromRow, toRow),
    ) as Promise<PivotCell[]>,
    fetchAllRows((fromRow, toRow) =>
      db
        .from("gl_accounts")
        .select("realm_id, name, fully_qualified_name, category")
        .in("classification", ["Revenue", "Expense"])
        .order("id")
        .range(fromRow, toRow),
    ) as Promise<
      {
        realm_id: string;
        name: string;
        fully_qualified_name: string | null;
        category: string | null;
      }[]
    >,
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
  ]);

  // Same name → category mapping as the page: gl_pivot's account row key is
  // the account's full name, merged across companies under "All companies",
  // first assigned category winning if realms ever disagree.
  const categoryByAccount = new Map<string, string>();
  for (const a of accountRows) {
    if (!a.category) continue;
    if (company !== "all" && a.realm_id !== company) continue;
    const key = a.fully_qualified_name ?? a.name;
    if (!categoryByAccount.has(key)) categoryByAccount.set(key, a.category);
  }

  const statement = buildCategoryStatement(cells, categoryByAccount);

  const netIncomePivot: PivotTotals = {
    bycol: new Map(Object.entries(statement.netIncome.cells)),
    total: statement.netIncome.total,
  };
  const rawEliminations =
    company === "all"
      ? buildEliminations(eliminationSlices, netIncomePivot)
      : null;
  const eliminations = rawEliminations
    ? serializeEliminations(rawEliminations)
    : null;

  const showRowTotal = colDim !== "total";
  const colLabels = statement.colKeys.map((k) =>
    pivotColLabel(colDim, k, companyByRealm),
  );

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Income Statement");
  // Category rows sit above their member accounts, so Excel's outline
  // collapse buttons belong on the row above the group.
  sheet.properties.outlineProperties = { summaryBelow: false, summaryRight: false };

  sheet.addRow(["Income Statement"]).font = { bold: true, size: 13 };
  sheet.addRow([
    [
      company === "all" ? "All companies" : companyByRealm.get(company),
      `${monthLabel(from)} – ${monthLabel(to)}`,
      "Grouped by the Category assigned to each account on the Chart of Accounts page",
      "Amounts are natural signed ledger activity",
    ]
      .filter(Boolean)
      .join(" · "),
  ]);
  sheet.addRow([]);
  const header = sheet.addRow([
    "Category",
    ...colLabels,
    ...(showRowTotal ? ["Total"] : []),
  ]);
  header.font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 4 }];

  sheet.getColumn(1).width = 42;
  for (let i = 0; i < colLabels.length + (showRowTotal ? 1 : 0); i++) {
    const col = sheet.getColumn(i + 2);
    col.width = 15;
    col.numFmt = "#,##0.00";
  }

  const totalsCells = (t: StatementTotals) => [
    ...statement.colKeys.map((k) => t.cells[k] ?? null),
    ...(showRowTotal ? [t.total] : []),
  ];

  // Accounting-style rule above every total line's amounts. Set as a top
  // border on the total row itself (not a bottom border on the row above) so
  // it survives collapsing the category's account rows.
  const ruleAbove = (row: ExcelJS.Row) => {
    for (let i = 0; i < colLabels.length + (showRowTotal ? 1 : 0); i++) {
      row.getCell(i + 2).border = { top: { style: "thin" } };
    }
  };

  const writeSection = (section: StatementSection) => {
    sheet.addRow([section.label]).font = { bold: true };
    for (const group of section.groups) {
      // Category header carries no amounts; the subtotal line below the
      // member accounts does.
      sheet.addRow([group.label]).font = { bold: true };
      // Member accounts nest under the category as a collapsible Excel
      // group, mirroring the expandable rows on screen.
      for (const r of group.rows) {
        const row = sheet.addRow([r.key, ...totalsCells(r)]);
        row.outlineLevel = 1;
        row.getCell(1).alignment = { indent: 2 };
      }
      const subtotal = sheet.addRow([
        `Total ${group.label}`,
        ...totalsCells(group),
      ]);
      subtotal.font = { bold: true };
      subtotal.getCell(1).alignment = { indent: 1 };
      ruleAbove(subtotal);
    }
    const totalRow = sheet.addRow([
      `Total ${section.label.toLowerCase()}`,
      ...totalsCells(section),
    ]);
    totalRow.font = { bold: true };
    ruleAbove(totalRow);
  };

  writeSection(statement.income);
  if (statement.directCosts.groups.length > 0) writeSection(statement.directCosts);
  if (statement.grossProfit) {
    const grossProfitRow = sheet.addRow([
      "Gross profit",
      ...totalsCells(statement.grossProfit),
    ]);
    grossProfitRow.font = { bold: true };
    ruleAbove(grossProfitRow);
  }
  writeSection(statement.expenses);
  const netIncomeRow = sheet.addRow([
    eliminations ? "Net income before eliminations" : "Net income",
    ...totalsCells(statement.netIncome),
  ]);
  netIncomeRow.font = { bold: true };
  ruleAbove(netIncomeRow);

  if (eliminations) {
    sheet.addRow(["Intercompany eliminations"]).font = { bold: true };
    for (const line of eliminations.lines) {
      sheet.addRow([line.label, ...totalsCells(line)]);
    }
    const adjusted = sheet.addRow([
      "Net income after eliminations",
      ...totalsCells(eliminations.adjusted),
    ]);
    adjusted.font = { bold: true };
    ruleAbove(adjusted);
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return new Response(Buffer.from(buffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="income-statement-by-${colDim}-${from}-to-${to}.xlsx"`,
    },
  });
}
