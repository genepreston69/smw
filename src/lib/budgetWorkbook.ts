import "server-only";

import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import {
  monthLabel,
  type CategoryStatement,
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
  compareClasses,
  growthCategories,
  inBudgetClass,
  initiativePeriodLabel,
  initiativeTotals,
  sameAssumption,
  sortClasses,
  type BudgetAssumption,
  type BudgetClass,
  type BudgetColDim,
  type BudgetView,
} from "@/lib/budget";
import { loadBudget, type LoadedBudget } from "@/lib/budgetServer";
import {
  sortInitiativesForExport,
  writeInitiativesByMonth,
} from "@/lib/budgetInitiativeSheet";

// The budget workbook (/financials/budget's Excel exports). Shared by
// /api/export/budget — one workbook for the page's selection — and
// /api/export/budget-classes — a zip with one workbook per class, for handing
// each class its budget — so a class's workbook is the same file either way.
// Both read the page's query params plus the growth rates on screen, saved
// or not (budgetExportHref's `growth` and `cgrowth` params), the same inputs
// (loadBudget) and the same assembly (assembleBudget) — so the file always
// matches the screen. Rates in the URL only shape the file; nothing is saved.

/** Everything a budget workbook is built from, read once per request. */
export interface BudgetExportContext {
  year: number;
  colDim: BudgetColDim;
  view: BudgetView;
  /** Realm id or "all". */
  company: string;
  /** The class filter in the URL (null = All classes), if it names a class
      the selection budgets. */
  cls: BudgetClass;
  companyByRealm: Map<string, string>;
  companies: { realmId: string; name: string }[];
  /** Every class the selected companies budget, sorted (NO_CLASS last). */
  classes: string[];
  data: LoadedBudget;
  /** Rates the file uses (on-screen, else saved), by realm. */
  assumptions: Record<string, BudgetAssumption>;
  /** Companies whose rates in the file differ from their saved rates. */
  unsaved: { realmId: string; name: string }[];
}

/**
 * Verifies the caller is a signed-in admin (budget data is admin-only, like
 * the ledger it's built from) and reads the export's inputs from the
 * request. Returns an error response instead when the caller may not export.
 */
export async function budgetExportContext(
  request: Request,
): Promise<{ ctx: BudgetExportContext } | { error: NextResponse }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "admin") {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
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

  const data = await loadBudget(db, { year, company, realms, view });
  const classes = sortClasses(realms.flatMap((r) => data.classesByRealm[r] ?? []));
  const requested = sp.get("class");
  const cls: BudgetClass = requested !== null && classes.includes(requested) ? requested : null;

  // Growth rates from the screen; a company whose rates are missing or
  // malformed keeps its saved ones.
  const saved = new Map(data.assumptions.map((a) => [a.realm_id, a]));
  const assumptions = assumptionsFromParams(sp, data.assumptions);
  const companies = realms.map((r) => ({ realmId: r, name: companyByRealm.get(r) ?? r }));
  const unsaved = companies.filter((c) => {
    const s = saved.get(c.realmId);
    return !s || !sameAssumption(assumptions[c.realmId], s);
  });

  return {
    ctx: {
      year,
      colDim,
      view,
      company,
      cls,
      companyByRealm,
      companies,
      classes,
      data,
      assumptions,
      unsaved,
    },
  };
}

/** Lowercase-hyphenated file-name part ("" when nothing usable is left). */
const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

/**
 * Export file name (no extension): budget-<year>-<company>[-<class>]-<layout>,
 * named after the company and class so distributed workbooks are told apart
 * at a glance (the realm id is the fallback for a company name with no
 * letters/digits). `cls` "classes" names the per-class zip.
 */
export function budgetFileStem(
  ctx: BudgetExportContext,
  cls: BudgetClass | { classes: true },
): string {
  const { year, company, companyByRealm, colDim, view, data } = ctx;
  const layout = view === "variance" && data.closedThrough > 0 ? "vs-actual" : `by-${colDim}`;
  const companySlug =
    company === "all" ? "all-companies" : slug(companyByRealm.get(company) ?? "") || company;
  const classPart =
    cls === null ? "" : typeof cls === "string" ? `-${slug(cls) || "class"}` : "-classes";
  return `budget-${year}-${companySlug}${classPart}-${layout}`;
}

/**
 * The budget workbook for the context's companies and one class (null = All
 * classes, the roll-up). Sheets: the budget statement (or Budget vs Actual)
 * for the selection, then its breakdown — one tab per company on All
 * companies, or one tab per class for a single company on All classes —
 * then the growth assumptions used, the class's initiatives with their
 * account lines, those initiatives by month, and any typed figures.
 */
export function buildBudgetWorkbook(
  ctx: BudgetExportContext,
  cls: BudgetClass,
): { workbook: ExcelJS.Workbook; filename: string } {
  const { year, colDim, view, company, companyByRealm, companies, data, assumptions } = ctx;
  const baseline = baselineRange(year);
  const keep = inBudgetClass(cls);
  const initiatives = data.initiatives.filter(keep);
  const overrides = data.overrides.filter(keep);

  const companyLabel =
    company === "all" ? "All companies" : (companyByRealm.get(company) ?? company);
  const scopeLabel = cls === null ? companyLabel : `${companyLabel} — ${cls}`;
  const baselineLabel = `${monthLabel(baseline.from)} – ${monthLabel(baseline.to)}`;

  const workbook = new ExcelJS.Workbook();

  /* ---- Statement sheets --------------------------------------------- */

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
    sheet.addRow(["Net income", ...cols.cells(s.netIncome, false)]).font = { bold: true };
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

  // The budget for some companies in one class (or all), assembled exactly
  // like the page's view of that selection.
  const assemble = (
    scope: { realmId: string; name: string }[],
    scopeCls: BudgetClass,
  ) => {
    const idx = scope.map((c) => companies.indexOf(c));
    const scopeKeep = inBudgetClass(scopeCls);
    const single = company === "all" && scope.length === 1;
    return assembleBudget({
      year,
      colDim,
      view,
      cls: scopeCls,
      closedThrough: data.closedThrough,
      companies: scope,
      assumptions,
      baselineByRealm: idx.map((i) => data.baselineByRealm[i] ?? []),
      realmCategories: idx.map((i) => data.realmCategories[i] ?? new Map<string, string>()),
      actuals: data.actualsByRealm
        ? idx.flatMap((i) => data.actualsByRealm![i] ?? [])
        : null,
      approved: data.initiatives.filter(
        (i) =>
          i.status === "approved" && scope.some((c) => c.realmId === i.realm_id) && scopeKeep(i),
      ),
      overrides: data.overrides.filter((o) => scope.some((c) => c.realmId === o.realm_id)),
      // A company tab on All companies uses that company's own categories,
      // as its own view on the page does.
      categoryByAccount: single
        ? (data.realmCategories[idx[0]] ?? new Map<string, string>())
        : data.categoryByAccount,
    });
  };

  // One statement sheet for a scope (some companies, one class or all).
  const writeScope = (
    tab: string,
    label: string,
    scope: { realmId: string; name: string }[],
    scopeCls: BudgetClass,
  ) => {
    const built = assemble(scope, scopeCls);
    const scopeKeep = inBudgetClass(scopeCls);
    const inScope = (r: { realm_id: string }) => scope.some((c) => c.realmId === r.realm_id);
    const scopeUnsaved = ctx.unsaved.filter((c) => scope.includes(c));
    const growthNote = scopeUnsaved.length
      ? `Includes unsaved growth changes for ${scopeUnsaved.map((c) => c.name).join(", ")}`
      : "Saved growth assumptions";
    const classNote =
      scopeCls === null
        ? ctx.classes.length > 1
          ? "All classes"
          : ""
        : `Class ${scopeCls} only (growth rates are per company and apply to every class)`;
    const typedCount = data.overrides.filter((o) => inScope(o) && scopeKeep(o)).length;
    const typedNote = typedCount
      ? `Includes ${typedCount} typed account-month figure(s) in place of growth (see Typed figures)`
      : "";
    const approvedCount = data.initiatives.filter(
      (i) => i.status === "approved" && inScope(i) && scopeKeep(i),
    ).length;

    if (view === "variance" && built.variance) {
      const ytd = `YTD ${MONTH_NAMES[data.closedThrough - 1]} ${year}`;
      writeStatement(
        workbook.addWorksheet(sheetName(tab)),
        built.variance,
        `Budget vs Actual ${year} — ${label}`,
        [
          classNote,
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
      `Budget ${year} — ${label}`,
      [
        classNote,
        `Baseline ${baselineLabel} actuals mapped onto ${year}`,
        growthNote,
        typedNote,
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

  // First tab: the selection exactly as on screen (consolidated when All
  // companies is selected, the class roll-up on All classes).
  writeScope(
    cls === null ? companyLabel : company === "all" ? `${cls} — All companies` : cls,
    scopeLabel,
    companies,
    cls,
  );

  if (company === "all") {
    // On All companies, one tab per company after it — each built exactly
    // like that company's own view on the page: its categories, its approved
    // initiatives, and its growth rates. With a class selected, a company
    // that doesn't budget that class gets no tab.
    for (const c of companies) {
      if (cls !== null && !(data.classesByRealm[c.realmId] ?? []).includes(cls)) continue;
      writeScope(c.name, cls === null ? c.name : `${c.name} — ${cls}`, [c], cls);
    }
  } else if (cls === null && ctx.classes.length > 1) {
    // One company on All classes: one tab per class, the parts the company
    // tab rolls up.
    for (const k of ctx.classes) writeScope(k, `${companyLabel} — ${k}`, companies, k);
  }

  /* ---- Growth assumptions ------------------------------------------- */

  // Laid out like the on-screen grid: categories × companies. Every cell is
  // the rate actually applied; a category with no rate of its own shows its
  // company default in grey italics.
  const aSheet = workbook.addWorksheet(sheetName("Assumptions"));
  aSheet.addRow([`Growth assumptions — ${year} budget`]).font = { bold: true, size: 13 };
  aSheet.addRow([
    `Applied to ${baselineLabel} actuals: each account grows at its category's rate for its company, in every class. Grey italics = no rate of its own, so the company default applies (as it does to uncategorized accounts). — = the company has no accounts in that category.`,
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
  const rows = growthCategories(
    data.accountRows,
    companies.map((c) => c.realmId),
  );
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
    ...companies.map((c) => (ctx.unsaved.includes(c) ? "Unsaved (as shown on screen)" : "Saved")),
  ]).font = { bold: true };
  aSheet.getColumn(1).width = 42;
  companies.forEach((_, i) => {
    const col = aSheet.getColumn(2 + i);
    col.width = 26;
    col.numFmt = "0.0%";
  });

  /* ---- Initiatives -------------------------------------------------- */

  const iSheet = workbook.addWorksheet(sheetName("Initiatives"));
  iSheet.properties.outlineProperties = { summaryBelow: false, summaryRight: false };
  iSheet.addRow([`New initiatives — ${year} — ${scopeLabel}`]).font = { bold: true, size: 13 };
  iSheet.addRow([
    "Only approved initiatives are included in the budget; amounts spread evenly from the start month through the end month (see Initiatives by month)",
  ]);
  iSheet.addRow([]);
  iSheet.addRow([
    "Initiative / account",
    "Company",
    "Class",
    "Status",
    "Period",
    "Approved by",
    "Revenue",
    "Expense",
    "Net",
  ]).font = { bold: true };
  iSheet.views = [{ state: "frozen", ySplit: 4 }];
  for (const i of sortInitiativesForExport(initiatives)) {
    const t = initiativeTotals(i);
    iSheet.addRow([
      i.name,
      companyByRealm.get(i.realm_id) ?? i.realm_id,
      i.class_name,
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
        "",
        l.classification === "Revenue" ? l.annual_amount : null,
        l.classification === "Expense" ? l.annual_amount : null,
        null,
      ]);
      row.outlineLevel = 1;
      row.getCell(1).alignment = { indent: 2 };
    }
  }
  if (initiatives.length === 0) iSheet.addRow(["No initiatives yet"]);
  for (const [c, w] of [42, 24, 20, 24, 18, 20].entries()) iSheet.getColumn(c + 1).width = w;
  for (const c of [7, 8, 9]) {
    iSheet.getColumn(c).width = 15;
    iSheet.getColumn(c).numFmt = "#,##0.00";
  }

  /* ---- Initiatives by month ----------------------------------------- */

  writeInitiativesByMonth(workbook.addWorksheet(sheetName("Initiatives by month")), initiatives, {
    year,
    title: `New initiatives ${year} by month — ${scopeLabel}`,
    companyName: (r) => companyByRealm.get(r) ?? r,
    summary: true,
  });

  /* ---- Typed figures ------------------------------------------------ */

  // Account × class months typed over on the statement (migrations 0031,
  // 0034), so the file shows which figures replace the growth-based amount.
  if (overrides.length > 0) {
    const tSheet = workbook.addWorksheet(sheetName("Typed figures"));
    tSheet.addRow([`Typed budget figures — ${year} — ${scopeLabel}`]).font = {
      bold: true,
      size: 13,
    };
    tSheet.addRow([
      "Each figure replaces that account's growth-based amount in its class for the month; approved initiatives still add on top. Growth rates do not change them.",
    ]);
    tSheet.addRow([]);
    tSheet.addRow(["Company", "Class", "Account", "Type", "Month", "Amount"]).font = {
      bold: true,
    };
    tSheet.views = [{ state: "frozen", ySplit: 4 }];
    const sorted = [...overrides].sort(
      (a, b) =>
        (companyByRealm.get(a.realm_id) ?? a.realm_id).localeCompare(
          companyByRealm.get(b.realm_id) ?? b.realm_id,
        ) ||
        compareClasses(a.class_name, b.class_name) ||
        a.account.localeCompare(b.account) ||
        a.month - b.month,
    );
    for (const o of sorted)
      tSheet.addRow([
        companyByRealm.get(o.realm_id) ?? o.realm_id,
        o.class_name,
        o.account,
        o.classification,
        `${MONTH_NAMES[o.month - 1]} ${year}`,
        o.amount,
      ]);
    for (const [i, w] of [24, 20, 42, 10, 12, 15].entries()) tSheet.getColumn(i + 1).width = w;
    tSheet.getColumn(6).numFmt = "#,##0.00";
  }

  return { workbook, filename: `${budgetFileStem(ctx, cls)}.xlsx` };
}
