import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import {
  monthLabel,
  pivotColLabel,
  type StatementSection,
  type StatementTotals,
} from "@/lib/financials";
import { NO_CLASS } from "@/lib/budget";
import { loadStatement, statementState } from "@/lib/statementServer";

// Excel export of the category income statement: same query params as
// /financials/statement (including the Class dropdown), same loadStatement
// read and buildCategoryStatement assembly — the file always matches the statement on screen, with account
// rows nested under their category via Excel row grouping.
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
  const state = statementState((k) => sp.get(k), new Set(companyByRealm.keys()));
  const { company, from, to, cols: colDim, cls } = state;
  const { statement } = await loadStatement(db, state, [...companyByRealm.keys()]);
  const classLabel =
    cls === null ? "All classes" : cls === NO_CLASS ? "No class assigned" : `Class: ${cls}`;

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
      classLabel,
      `${monthLabel(from)} – ${monthLabel(to)}`,
      "Grouped by the Category assigned to each account on the Chart of Accounts page",
      "Amounts are natural signed ledger activity",
      "% columns show each amount as a percent of the same column's total income",
    ]
      .filter(Boolean)
      .join(" · "),
  ]);
  sheet.addRow([]);
  const header = sheet.addRow([
    "Category",
    ...colLabels.flatMap((label) => [label, "%"]),
    ...(showRowTotal ? ["Total", "%"] : []),
  ]);
  header.font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 4 }];

  sheet.getColumn(1).width = 42;
  // Each value column is an amount/percent pair: dollars, then that amount
  // as a share of the same column's total income (common size).
  for (let i = 0; i < colLabels.length + (showRowTotal ? 1 : 0); i++) {
    const amountCol = sheet.getColumn(2 + i * 2);
    amountCol.width = 15;
    amountCol.numFmt = "#,##0.00";
    const pctCol = sheet.getColumn(3 + i * 2);
    pctCol.width = 9;
    pctCol.numFmt = "0.0%";
  }

  const incomeFor = (colKey: string | null): number =>
    colKey === null
      ? statement.income.total
      : (statement.income.cells[colKey] ?? 0);
  const withPct = (v: number | null, colKey: string | null) => {
    const denom = incomeFor(colKey);
    return [v, v !== null && denom !== 0 ? v / denom : null];
  };

  const totalsCells = (t: StatementTotals) => [
    ...statement.colKeys.flatMap((k) => withPct(t.cells[k] ?? null, k)),
    ...(showRowTotal ? withPct(t.total, null) : []),
  ];

  const writeSection = (section: StatementSection) => {
    sheet.addRow([section.label]).font = { bold: true };
    for (const group of section.groups) {
      sheet.addRow([group.label, ...totalsCells(group)]);
      // Member accounts nest under the category as a collapsible Excel
      // group, mirroring the expandable rows on screen.
      for (const r of group.rows) {
        const row = sheet.addRow([r.key, ...totalsCells(r)]);
        row.outlineLevel = 1;
        row.getCell(1).alignment = { indent: 2 };
      }
    }
    const totalRow = sheet.addRow([
      `Total ${section.label.toLowerCase()}`,
      ...totalsCells(section),
    ]);
    totalRow.font = { bold: true };
  };

  writeSection(statement.income);
  if (statement.directCosts.groups.length > 0) writeSection(statement.directCosts);
  if (statement.grossProfit) {
    sheet.addRow(["Gross profit", ...totalsCells(statement.grossProfit)]).font = {
      bold: true,
    };
  }
  writeSection(statement.expenses);
  sheet.addRow(["Net income", ...totalsCells(statement.netIncome)]).font = {
    bold: true,
  };

  const buffer = await workbook.xlsx.writeBuffer();
  const classSlug =
    cls === null
      ? ""
      : `-${(cls === NO_CLASS ? "no-class" : cls).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "class"}`;
  return new Response(Buffer.from(buffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="income-statement${classSlug}-by-${colDim}-${from}-to-${to}.xlsx"`,
    },
  });
}
