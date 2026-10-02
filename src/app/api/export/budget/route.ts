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
  INITIATIVE_STATUS_LABEL,
  MONTH_NAMES,
  assembleBudget,
  assumptionsFromParams,
  baselineRange,
  budgetColLabel,
  growthCategories,
  initiativePeriodLabel,
  initiativeTotals,
  sameAssumption,
  type BudgetColDim,
  type BudgetView,
} from "@/lib/budget";
import { loadBudget } from "@/lib/budgetServer";
import {
  sortInitiativesForExport,
  writeInitiativesByMonth,
} from "@/lib/budgetInitiativeSheet";

// Excel export of /financials/budget: same query params as the page plus the
// growth rates on screen, saved or not (budgetExportHref's `growth` and
// `cgrowth` params), the same inputs (loadBudget) and the same assembly
// (assembleBudget) — so the file always matches the screen. Overrides only
// shape the file; nothing is saved. Sheets: the budget statement (or Budget
// vs Actual), the growth assumptions used, every initiative with its account
// lines, and the initiatives spread by month.
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

  // Growth rates from the screen; a company whose rates are missing or
  // malformed keeps its saved ones.
  const saved = new Map(data.assumptions.map((a) => [a.realm_id, a]));
  const assumptions = assumptionsFromParams(sp, data.assumptions);

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
    realmCategories: data.realmCategories,
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
    const s = saved.get(c.realmId);
    return !s || !sameAssumption(assumptions[c.realmId], s);
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

  const sheetNames = new Set<string>();
  // Excel sheet names: ≤ 31 chars, none of : \ / ? * [ ], unique per workbook.
  const sheetName = (raw: string): string => {
    const base = raw.replace(/[:\\/?*[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31).trim() || "Sheet";
    let name = base;
    for (let n = 2; sheetNames.has(name.toLowerCase()); n++) {
      const tag = ` (${n})`;
      name = base.slice(0, 31 - tag.length) + tag;
    }
    sheetNames.add(name.toLowerCase());
    return name;
  };

  // One statement sheet for a scope (all companies, or one company).
  const writeScope = (
    tab: string,
    label: string,
    scope: { realmId: string; name: string }[],
    built: ReturnType<typeof assembleBudget>,
    approvedCount: number,
  ) => {
    const scopeUnsaved = unsaved.filter((c) => scope.includes(c));
    const growthNote = scopeUnsaved.length
      ? `Includes unsaved growth changes for ${scopeUnsaved.map((c) => c.name).join(", ")}`
      : "Saved growth assumptions";

    if (view === "variance" && built.variance) {
      const ytd = `YTD ${MONTH_NAMES[data.closedThrough - 1]} ${year}`;
      writeStatement(
        workbook.addWorksheet(sheetName(tab)),
        built.variance.statement,
        built.variance.eliminations,
        `Budget vs Actual ${year} — ${label}`,
        [
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
      return;
    }

    // Budget view (also the fallback for Budget vs Actual before any month
    // of the budget year has closed).
    const s = built.statement;
    const showRowTotal = colDim !== "total";
    const keys = s.colKeys;
    const incomeFor = (k: string | null) =>
      k === null ? s.income.total : (s.income.cells[k] ?? 0);
    const pair = (v: number | null, k: string | null) => {
      const d = incomeFor(k);
      return [v, v !== null && d !== 0 ? v / d : null];
    };
    const n = keys.length + (showRowTotal ? 1 : 0);
    writeStatement(
      workbook.addWorksheet(sheetName(tab)),
      s,
      built.eliminations,
      `Budget ${year} — ${label}`,
      [
        `Baseline ${baselineLabel} actuals mapped onto ${year}`,
        growthNote,
        approvedCount ? `Includes ${approvedCount} approved initiative(s)` : "",
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
  };

  // First tab: the selection exactly as on screen (consolidated, with
  // eliminations, when All companies is selected).
  writeScope(companyLabel, companyLabel, companies, { statement, eliminations, variance }, approved.length);

  // On All companies, one tab per company after it — each built exactly like
  // that company's own view on the page: its categories, its approved
  // initiatives, its growth rates, and no intercompany eliminations (they are
  // a consolidation adjustment).
  if (company === "all") {
    companies.forEach((c, idx) => {
      const categories = data.realmCategories[idx] ?? new Map<string, string>();
      const companyApproved = approved.filter((i) => i.realm_id === c.realmId);
      writeScope(
        c.name,
        c.name,
        [c],
        assembleBudget({
          year,
          colDim,
          view,
          closedThrough: data.closedThrough,
          companies: [c],
          assumptions,
          baselineByRealm: [data.baselineByRealm[idx] ?? []],
          realmCategories: [categories],
          eliminationCellsByRealm: [],
          actuals: data.actualsByRealm ? (data.actualsByRealm[idx] ?? []) : null,
          actualEliminationSlices: [],
          approved: companyApproved,
          categoryByAccount: categories,
          wantEliminations: false,
        }),
        companyApproved.length,
      );
    });
  }

  /* ---- Sheet 2: growth assumptions -------------------------------- */

  // Laid out like the on-screen grid: categories × companies. Every cell is
  // the rate actually applied; a category with no rate of its own shows its
  // company default in grey italics.
  const aSheet = workbook.addWorksheet(sheetName("Assumptions"));
  aSheet.addRow([`Growth assumptions — ${year} budget`]).font = { bold: true, size: 13 };
  aSheet.addRow([
    `Applied to ${baselineLabel} actuals: each account grows at its category's rate for its company. Grey italics = no rate of its own, so the company default applies (as it does to uncategorized accounts). — = the company has no accounts in that category.`,
  ]);
  aSheet.addRow([]);
  aSheet.addRow(["Category", ...companies.map((c) => c.name)]).font = { bold: true };
  aSheet.views = [{ state: "frozen", ySplit: 4, xSplit: 1 }];
  const heading = (label: string) => {
    aSheet.addRow([label]).font = { bold: true, color: { argb: "FF6B7785" } };
  };
  heading("Company defaults");
  for (const [label, field] of [
    ["All revenue", "revenue_growth_pct"],
    ["All expenses", "expense_growth_pct"],
  ] as const)
    aSheet.addRow([label, ...companies.map((c) => assumptions[c.realmId][field] / 100)]);
  const rows = growthCategories(data.accountRows, realms);
  for (const [label, filter] of [
    ["Income categories", (r: (typeof rows)[number]) => r.classification === "Revenue"],
    ["Direct cost categories", (r: (typeof rows)[number]) => r.direct],
    [
      "Expense categories",
      (r: (typeof rows)[number]) => r.classification === "Expense" && !r.direct,
    ],
  ] as const) {
    const section = rows.filter(filter);
    if (section.length === 0) continue;
    heading(label);
    for (const r of section) {
      const row = aSheet.addRow([r.category]);
      row.getCell(1).alignment = { indent: 1 };
      companies.forEach((c, i) => {
        const cell = row.getCell(2 + i);
        if (!r.realms.includes(c.realmId)) {
          cell.value = "—";
          cell.alignment = { horizontal: "right" };
          return;
        }
        const a = assumptions[c.realmId];
        const rates = a.category_growth[r.classification];
        const own = Object.hasOwn(rates, r.category);
        const pct = own
          ? rates[r.category]
          : r.classification === "Revenue"
            ? a.revenue_growth_pct
            : a.expense_growth_pct;
        cell.value = pct / 100;
        if (!own) cell.font = { italic: true, color: { argb: "FF93A1AE" } };
      });
    }
  }
  aSheet.addRow([]);
  aSheet.addRow([
    "Status",
    ...companies.map((c) => (unsaved.includes(c) ? "Unsaved (as shown on screen)" : "Saved")),
  ]).font = { bold: true };
  aSheet.getColumn(1).width = 42;
  companies.forEach((_, i) => {
    const col = aSheet.getColumn(2 + i);
    col.width = 26;
    col.numFmt = "0.0%";
  });

  /* ---- Sheet 3: initiatives --------------------------------------- */

  const iSheet = workbook.addWorksheet(sheetName("Initiatives"));
  iSheet.properties.outlineProperties = { summaryBelow: false, summaryRight: false };
  iSheet.addRow([`New initiatives — ${year}`]).font = { bold: true, size: 13 };
  iSheet.addRow([
    "Only approved initiatives are included in the budget; amounts spread evenly from the start month through the end month (see Initiatives by month)",
  ]);
  iSheet.addRow([]);
  iSheet.addRow([
    "Initiative / account",
    "Company",
    "Status",
    "Period",
    "Approved by",
    "Revenue",
    "Expense",
    "Net",
  ]).font = { bold: true };
  iSheet.views = [{ state: "frozen", ySplit: 4 }];
  for (const i of sortInitiativesForExport(data.initiatives)) {
    const t = initiativeTotals(i);
    iSheet.addRow([
      i.name,
      companyByRealm.get(i.realm_id) ?? i.realm_id,
      INITIATIVE_STATUS_LABEL[i.status],
      initiativePeriodLabel(i, year),
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
  iSheet.getColumn(4).width = 18;
  iSheet.getColumn(5).width = 20;
  for (const c of [6, 7, 8]) {
    iSheet.getColumn(c).width = 15;
    iSheet.getColumn(c).numFmt = "#,##0.00";
  }

  /* ---- Sheet 4: initiatives by month ------------------------------ */

  writeInitiativesByMonth(
    workbook.addWorksheet(sheetName("Initiatives by month")),
    data.initiatives,
    {
      year,
      title: `New initiatives ${year} by month — ${companyLabel}`,
      companyName: (r) => companyByRealm.get(r) ?? r,
      summary: true,
    },
  );

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
