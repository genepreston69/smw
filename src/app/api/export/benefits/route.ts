import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { monthLabel } from "@/lib/financials";
import { NO_CLASS } from "@/lib/budget";
import {
  BENEFITS_CATEGORY,
  LABOR_BASE_ACCOUNTS,
  type BenefitCost,
  type BenefitLine,
  type BenefitTotals,
} from "@/lib/benefitCost";
import { benefitCostState, loadBenefitCost } from "@/lib/benefitCostServer";

// Excel export of Cost of Benefits: same query params as /financials/benefits
// and the same benefitCostState + loadBenefitCost read, so the file always
// matches the screen. Sheets: the view on screen (by month), By Class, and —
// on All classes — one by-month sheet per class.

const FORMULA = `${BENEFITS_CATEGORY} ÷ (${LABOR_BASE_ACCOUNTS.map((a) => a.label).join(" + ")})`;
const classLabel = (c: string) => (c === NO_CLASS ? "No class assigned" : c);

/** Excel sheet names: 31 chars, no \ / ? * [ ] :, unique per workbook. */
function sheetName(raw: string, used: Set<string>): string {
  const base = raw.replace(/[\\/?*[\]:]/g, " ").replace(/^'+|'+$/g, "").trim().slice(0, 31) || "Sheet";
  let name = base;
  for (let i = 2; used.has(name.toLowerCase()); i++) {
    const suffix = ` (${i})`;
    name = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(name.toLowerCase());
  return name;
}

function writeMonthSheet(
  sheet: ExcelJS.Worksheet,
  cost: BenefitCost,
  subtitle: string,
) {
  // Account rows sit under their line, so the outline buttons go above.
  sheet.properties.outlineProperties = { summaryBelow: false, summaryRight: false };
  sheet.addRow(["Cost of Benefits"]).font = { bold: true, size: 13 };
  sheet.addRow([subtitle]);
  sheet.addRow([`Benefit rate = ${FORMULA}. Amounts are the general ledger as booked.`]);
  sheet.addRow([]);
  sheet.addRow(["Line", ...cost.colKeys.map(monthLabel), "Total"]).font = { bold: true };
  sheet.views = [{ state: "frozen", xSplit: 1, ySplit: 5 }];
  sheet.getColumn(1).width = 44;
  for (let i = 0; i <= cost.colKeys.length; i++) {
    const col = sheet.getColumn(2 + i);
    col.width = 15;
    col.numFmt = "#,##0.00";
  }

  const values = (t: BenefitTotals) => [...cost.colKeys.map((k) => t.cells[k] ?? 0), t.total];
  const writeLine = (line: BenefitLine) => {
    sheet.addRow([line.label, ...values(line)]);
    const showAccounts =
      line.accounts.length > 1 ||
      (line.accounts.length === 1 && line.accounts[0].name !== line.label);
    if (!showAccounts) return;
    for (const a of line.accounts) {
      const row = sheet.addRow([a.name, ...values(a)]);
      row.outlineLevel = 1;
      row.getCell(1).alignment = { indent: 2 };
    }
  };
  writeLine(cost.benefits);
  cost.labor.forEach(writeLine);
  sheet.addRow(["Total labor", ...values(cost.laborTotal)]).font = { bold: true };
  const rateRow = sheet.addRow([
    "Benefit rate",
    ...cost.colKeys.map((k) => cost.rate.cells[k] ?? null),
    cost.rate.total,
  ]);
  rateRow.font = { bold: true };
  rateRow.eachCell((cell, col) => {
    if (col > 1) cell.numFmt = "0.0%";
  });
}

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

  // Admin verified; reads go through the service-role client like every
  // Financials read.
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
  const state = benefitCostState((k) => sp.get(k), new Set(companyByRealm.keys()));
  const { company, from, to, cls } = state;
  const realms = [...companyByRealm.keys()];

  let loaded;
  try {
    loaded = await loadBenefitCost(db, state, realms);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }

  const companyLabel = company === "all" ? "All companies" : companyByRealm.get(company);
  const period = `${monthLabel(from)} – ${monthLabel(to)}`;
  const subtitle = (c: string | null) =>
    [companyLabel, c === null ? "All classes" : `Class: ${classLabel(c)}`, period].join(" · ");

  const workbook = new ExcelJS.Workbook();
  const used = new Set<string>();
  writeMonthSheet(
    workbook.addWorksheet(sheetName("Cost of Benefits", used)),
    loaded.cost,
    subtitle(cls),
  );

  // By Class: every class's period totals, summing to All classes.
  const byClass = workbook.addWorksheet(sheetName("By Class", used));
  byClass.addRow(["Cost of Benefits by Class"]).font = { bold: true, size: 13 };
  byClass.addRow([[companyLabel, period].join(" · ")]);
  byClass.addRow([
    `Benefit rate = ${FORMULA}. Each class is its own benefits over its own labor, as booked.`,
  ]);
  byClass.addRow([]);
  byClass.addRow([
    "Class",
    BENEFITS_CATEGORY,
    ...LABOR_BASE_ACCOUNTS.map((a) => a.label),
    "Total labor",
    "Benefit rate",
  ]).font = { bold: true };
  byClass.views = [{ state: "frozen", ySplit: 5 }];
  byClass.getColumn(1).width = 36;
  const rateCol = 3 + LABOR_BASE_ACCOUNTS.length + 1;
  for (let c = 2; c < rateCol; c++) {
    byClass.getColumn(c).width = 20;
    byClass.getColumn(c).numFmt = "#,##0.00";
  }
  byClass.getColumn(rateCol).width = 14;
  byClass.getColumn(rateCol).numFmt = "0.0%";
  for (const r of loaded.byClass) {
    byClass.addRow([
      classLabel(r.cls),
      r.benefits,
      ...LABOR_BASE_ACCOUNTS.map((a) => r.labor[a.number] ?? 0),
      r.laborTotal,
      r.rate,
    ]);
  }
  const all = loaded.allClasses;
  byClass.addRow([
    "All classes",
    all.benefits.total,
    ...all.labor.map((l) => l.total),
    all.laborTotal.total,
    all.rate.total,
  ]).font = { bold: true };

  // On All classes, each class also gets its own by-month sheet — built from
  // the same ledger read, exactly as that class's own view builds it.
  if (cls === null) {
    for (const c of loaded.classes) {
      writeMonthSheet(
        workbook.addWorksheet(sheetName(classLabel(c), used)),
        loaded.costOf(c),
        subtitle(c),
      );
    }
  }

  const slug = (v: string) =>
    v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const parts = [
    "cost-of-benefits",
    company === "all" ? "" : slug(companyLabel ?? ""),
    cls === null ? "" : slug(cls === NO_CLASS ? "no-class" : cls) || "class",
    `${from}-to-${to}`,
  ].filter(Boolean);
  const buffer = await workbook.xlsx.writeBuffer();
  return new Response(Buffer.from(buffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${parts.join("-")}.xlsx"`,
    },
  });
}
