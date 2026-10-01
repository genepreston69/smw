import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import {
  monthLabel,
  type CategoryStatement,
  type StatementEliminations,
  type StatementSection,
  type StatementTotals,
} from "@/lib/financials";
import {
  BUDGET_COL_DIMS,
  BUDGET_VIEWS,
  BUDGET_YEAR,
  MONTH_NAMES,
  assembleBudget,
  baselineRange,
  budgetColLabel,
  initiativeTotals,
  type BudgetAssumption,
  type BudgetColDim,
  type BudgetView,
} from "@/lib/budget";
import { loadBudget } from "@/lib/budgetServer";

// Excel export of /financials/budget: same query params as the page plus the
// growth % on screen (`growth=<realm>:<revenue>:<expense>`, saved or not), the
// same inputs (loadBudget) and the same assembly (assembleBudget) — so the
// file always matches the screen. Overrides only shape the file; nothing is
// saved. Sheets: the budget statement (or Budget vs Actual), the growth
// assumptions used, and every initiative with its account lines.
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Budget data is admin-only, like the ledger it's built from.
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
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
  const colDim = BUDGET_COL_DIMS.some((d) => d.key === sp.get("cols"))
    ? (sp.get("cols") as BudgetColDim)
    : "month";
  const view = BUDGET_VIEWS.some((v) => v.key === sp.get("view"))
    ? (sp.get("view") as BudgetView)
    : "budget";
  const realms = company === "all" ? [...companyByRealm.keys()] : [company];
  const year = BUDGET_YEAR;
  const baseline = baselineRange(year);

  const data = await loadBudget(db, { year, company, realms, companyByRealm, view });

  // Growth overrides from the screen; anything malformed or out of range
  // falls back to the saved value.
  const saved = new Map(data.assumptions.map((a) => [a.realm_id, a]));
  const assumptions: Record<string, BudgetAssumption> = Object.fromEntries(
    data.assumptions.map((a) => [a.realm_id, a]),
  );
  for (const g of sp.getAll("growth")) {
    const [realm, rev, exp] = g.split(":");
    const r = Number(rev);
    const e = Number(exp);
    const ok = (n: number) => Number.isFinite(n) && n >= -100 && n <= 1000;
    if (!saved.has(realm) || !ok(r) || !ok(e)) continue;
    assumptions[realm] = { realm_id: realm, revenue_growth_pct: r, expense_growth_pct: e };
  }

  const companies = realms.map((r) => ({ realmId: r, name: companyByRealm.get(r) ?? r }));
  const approved = data.initiatives.filter((i) => i.status === "approved");
  const { statement, eliminations, variance } = assembleBudget({
    year,
    colDim,
    view,
    closedThrough: data.closedThrough,
    companies,
    assumptions,
    baselineByRealm: data.baselineByRealm,
    eliminationCellsByRealm: data.eliminationCellsByRealm,
    actuals: data.actuals,
    actualEliminationSlices: data.actualEliminationSlices,
    approved,
    categoryByAccount: data.categoryByAccount,
    wantEliminations: data.wantEliminations,
  });

  const companyLabel =
    company === "all" ? "All companies" : (companyByRealm.get(company) ?? company);
  const baselineLabel = `${monthLabel(baseline.from)} – ${monthLabel(baseline.to)}`;
  const unsaved = companies.filter((c) => {
    const a = assumptions[c.realmId];
    const s = saved.get(c.realmId);
    return (
      a.revenue_growth_pct !== s?.revenue_growth_pct ||
      a.expense_growth_pct !== s?.expense_growth_pct
    );
  });

  const workbook = new ExcelJS.Workbook();

  /* ---- Sheet 1: the statement -------------------------------------- */

  // A column spec turns one statement row into its cells, so the budget
  // (amount/% pairs) and variance (budget/actual/variance) layouts share the
  // section-writing code below.
  type Columns = {
    headers: string[];
    widths: number[];
    formats: string[];
    cells: (t: StatementTotals, cost: boolean) => (number | null)[];
  };

  const writeStatement = (
    sheet: ExcelJS.Worksheet,
    s: CategoryStatement,
    elim: StatementEliminations | null,
    title: string,
    notes: string[],
    cols: Columns,
  ) => {
    sheet.properties.outlineProperties = { summaryBelow: false, summaryRight: false };
    sheet.addRow([title]).font = { bold: true, size: 13 };
    sheet.addRow([notes.filter(Boolean).join(" · ")]);
    sheet.addRow([]);
    sheet.addRow(["Category", ...cols.headers]).font = { bold: true };
    sheet.views = [{ state: "frozen", ySplit: 4, xSplit: 1 }];
    sheet.getColumn(1).width = 42;
    cols.widths.forEach((w, i) => {
      const col = sheet.getColumn(2 + i);
      col.width = w;
      col.numFmt = cols.formats[i];
    });

    const section = (sec: StatementSection, cost: boolean) => {
      sheet.addRow([sec.label]).font = { bold: true };
      for (const group of sec.groups) {
        sheet.addRow([group.label, ...cols.cells(group, cost)]);
        for (const r of group.rows) {
          const row = sheet.addRow([r.key, ...cols.cells(r, cost)]);
          row.outlineLevel = 1;
          row.getCell(1).alignment = { indent: 2 };
        }
      }
      sheet.addRow([`Total ${sec.label.toLowerCase()}`, ...cols.cells(sec, cost)]).font = {
        bold: true,
      };
    };

    section(s.income, false);
    if (s.directCosts.groups.length > 0) section(s.directCosts, true);
    if (s.grossProfit)
      sheet.addRow(["Gross profit", ...cols.cells(s.grossProfit, false)]).font = { bold: true };
    section(s.expenses, true);
    sheet.addRow([
      elim ? "Net income before eliminations" : "Net income",
      ...cols.cells(s.netIncome, false),
    ]).font = { bold: true };
    if (elim) {
      sheet.addRow(["Intercompany eliminations"]).font = { bold: true };
      for (const line of elim.lines) sheet.addRow([line.label, ...cols.cells(line, false)]);
      sheet.addRow(["Net income after eliminations", ...cols.cells(elim.adjusted, false)]).font = {
        bold: true,
      };
    }
  };

  const growthNote = unsaved.length
    ? `Includes unsaved growth changes for ${unsaved.map((c) => c.name).join(", ")}`
    : "Saved growth assumptions";

  if (view === "variance" && variance) {
    const ytd = `YTD ${MONTH_NAMES[data.closedThrough - 1]} ${year}`;
    writeStatement(
      workbook.addWorksheet("Budget vs Actual"),
      variance.statement,
      variance.eliminations,
      `Budget vs Actual ${year}`,
      [
        companyLabel,
        `Actuals through ${MONTH_NAMES[data.closedThrough - 1]} ${year}`,
        growthNote,
        "Variance is favorable-positive: actual − budget for income and profit, budget − actual for costs",
      ],
      {
        headers: ["Full-year budget", `${ytd} budget`, `${ytd} actual`, "Variance", "Variance %"],
        widths: [16, 16, 16, 15, 11],
        formats: ["#,##0.00", "#,##0.00", "#,##0.00", "#,##0.00", "0.0%"],
        cells: (t, cost) => {
          const fy = t.cells.fy ?? 0;
          const b = t.cells.budget ?? 0;
          const a = t.cells.actual ?? 0;
          const v = cost ? b - a : a - b;
          return [fy, b, a, v, b !== 0 ? v / Math.abs(b) : null];
        },
      },
    );
  } else {
    // Budget view (also the fallback for Budget vs Actual before any month
    // of the budget year has closed).
    const showRowTotal = colDim !== "total";
    const keys = statement.colKeys;
    const incomeFor = (k: string | null) =>
      k === null ? statement.income.total : (statement.income.cells[k] ?? 0);
    const pair = (v: number | null, k: string | null) => {
      const d = incomeFor(k);
      return [v, v !== null && d !== 0 ? v / d : null];
    };
    const n = keys.length + (showRowTotal ? 1 : 0);
    writeStatement(
      workbook.addWorksheet("Budget"),
      statement,
      eliminations,
      `Budget ${year}`,
      [
        companyLabel,
        `Baseline ${baselineLabel} actuals mapped onto ${year}`,
        growthNote,
        approved.length ? `Includes ${approved.length} approved initiative(s)` : "",
        "% columns show each amount as a percent of the same column's total income",
      ],
      {
        headers: [
          ...keys.flatMap((k) => [budgetColLabel(colDim, k), "%"]),
          ...(showRowTotal ? ["Total", "%"] : []),
        ],
        widths: Array.from({ length: n }, () => [15, 9]).flat(),
        formats: Array.from({ length: n }, () => ["#,##0.00", "0.0%"]).flat(),
        cells: (t) => [
          ...keys.flatMap((k) => pair(t.cells[k] ?? null, k)),
          ...(showRowTotal ? pair(t.total, null) : []),
        ],
      },
    );
  }

  /* ---- Sheet 2: growth assumptions -------------------------------- */

  const aSheet = workbook.addWorksheet("Assumptions");
  aSheet.addRow([`Growth assumptions — ${year} budget`]).font = { bold: true, size: 13 };
  aSheet.addRow([
    `Applied to ${baselineLabel} actuals: revenue accounts by the revenue %, all expense accounts (direct costs included) by the expense %`,
  ]);
  aSheet.addRow([]);
  aSheet.addRow(["Company", "Revenue growth", "Expense growth", "Status"]).font = { bold: true };
  for (const c of companies) {
    const a = assumptions[c.realmId];
    aSheet.addRow([
      c.name,
      a.revenue_growth_pct / 100,
      a.expense_growth_pct / 100,
      unsaved.includes(c) ? "Unsaved (as shown on screen)" : "Saved",
    ]);
  }
  aSheet.getColumn(1).width = 36;
  aSheet.getColumn(2).width = 16;
  aSheet.getColumn(2).numFmt = "0.0%";
  aSheet.getColumn(3).width = 16;
  aSheet.getColumn(3).numFmt = "0.0%";
  aSheet.getColumn(4).width = 28;

  /* ---- Sheet 3: initiatives --------------------------------------- */

  const iSheet = workbook.addWorksheet("Initiatives");
  iSheet.properties.outlineProperties = { summaryBelow: false, summaryRight: false };
  iSheet.addRow([`New initiatives — ${year}`]).font = { bold: true, size: 13 };
  iSheet.addRow([
    "Only approved initiatives are included in the budget; amounts spread evenly from the start month through December",
  ]);
  iSheet.addRow([]);
  iSheet.addRow([
    "Initiative / account",
    "Company",
    "Status",
    "Starts",
    "Approved by",
    "Revenue",
    "Expense",
    "Net",
  ]).font = { bold: true };
  iSheet.views = [{ state: "frozen", ySplit: 4 }];
  const order = ["approved", "proposed", "rejected"];
  for (const i of [...data.initiatives].sort(
    (a, b) => order.indexOf(a.status) - order.indexOf(b.status),
  )) {
    const t = initiativeTotals(i);
    iSheet.addRow([
      i.name,
      companyByRealm.get(i.realm_id) ?? i.realm_id,
      i.status === "approved"
        ? "Approved — in budget"
        : i.status === "proposed"
          ? "Proposed — not in budget"
          : "Rejected",
      `${MONTH_NAMES[i.start_month - 1]} ${year}`,
      i.approved_by_name ?? "",
      t.revenue,
      t.expense,
      t.net,
    ]).font = { bold: true };
    for (const l of i.lines) {
      const row = iSheet.addRow([
        l.account_name,
        "",
        "",
        "",
        "",
        l.classification === "Revenue" ? l.annual_amount : null,
        l.classification === "Expense" ? l.annual_amount : null,
        null,
      ]);
      row.outlineLevel = 1;
      row.getCell(1).alignment = { indent: 2 };
    }
  }
  if (data.initiatives.length === 0) iSheet.addRow(["No initiatives yet"]);
  iSheet.getColumn(1).width = 42;
  iSheet.getColumn(2).width = 24;
  iSheet.getColumn(3).width = 24;
  iSheet.getColumn(4).width = 10;
  iSheet.getColumn(5).width = 20;
  for (const c of [6, 7, 8]) {
    iSheet.getColumn(c).width = 15;
    iSheet.getColumn(c).numFmt = "#,##0.00";
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const suffix = view === "variance" && variance ? "vs-actual" : `by-${colDim}`;
  const companySlug = company === "all" ? "all-companies" : company;
  return new Response(Buffer.from(buffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="budget-${year}-${companySlug}-${suffix}.xlsx"`,
    },
  });
}
