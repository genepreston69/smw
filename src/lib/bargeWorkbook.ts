import "server-only";

import ExcelJS from "exceljs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/supabase/fetchAll";
import { STATUS_LABELS, moneyWhole, shortDate } from "@/lib/format";
import {
  BARGE_SECTIONS,
  BARGE_SECTION_LABELS,
  CONFIG_FIELD_GROUPS,
  SENSITIVITY_HOUR_MULTS,
  SENSITIVITY_STEEL_MULTS,
  computeRoughQuote,
  marginSensitivity,
  roughBuildUp,
  roundedSuggestedPrice,
  sensitivityColor,
  type BargeConfigValues,
  type BargeCostView,
  type BargeQuote,
  type BargeQuoteTotals,
  type BargeSection,
} from "@/lib/barge";

/* ---------------------------------------------------------------------------
   Barge Program Excel exports:
   - /api/export/barge-quote?id=  one quote, one sheet (writeQuoteSheet)
   - /api/export/barge-quotes     every quote: an All Quotes summary, then the
                                  same per-quote sheet for each
   - /api/export/barge-rough      the Rough Quote Builder's inputs on screen,
                                  saved or not (roughExportHref), re-priced by
                                  computeRoughQuote — the builder's own model

   Saved quotes are read from the SQL cost views (barge_quote_steel_line_costs,
   barge_quote_totals) and never re-priced here, so a file matches the
   workbench after Save. Only display splits the views don't carry are
   derived: per-section and per-phase subtotals, the fully-absorbed price at
   target, and the sensitivity grids (marginSensitivity, shared with the
   workbench).
--------------------------------------------------------------------------- */

/** A row of the barge_quote_steel_line_costs view. */
interface SteelLineCost {
  quote_id: string;
  section: BargeSection;
  sort_order: number;
  item: string;
  unit: string;
  qty: number;
  unit_lb: number;
  yield_pct: number;
  price_per_lb: number;
  net_lbs: number;
  ordered_lbs: number;
  steel_cost: number;
}

/** Everything one quote's sheet is written from. */
export interface BargeQuoteExport {
  quote: BargeQuote;
  customer: string | null;
  creator: string;
  lines: SteelLineCost[];
  labor: { name: string; hours: number }[];
  totals: BargeQuoteTotals;
  approvals: {
    version: number;
    approver: string;
    decision: string;
    comment: string | null;
    createdAt: string;
  }[];
}

const DECISION_LABELS: Record<string, string> = {
  approved: "Approved",
  rejected: "Rejected",
  changes_requested: "Changes requested",
};

const TOTAL_KEYS = [
  "net_lbs",
  "ordered_lbs",
  "net_tons",
  "steel_cost",
  "total_hours",
  "labor_cost",
  "fitout_cost",
  "overhead_cost",
  "hours_per_ton",
  "direct_cost",
  "absorbed_cost",
  "direct_margin",
  "absorbed_margin",
  "direct_margin_pct",
  "price_at_target",
  "sales_price",
] as const;

/** Numerics can arrive as strings; normalize a view row to numbers. */
function toTotals(quoteId: string, row: Record<string, unknown> | undefined): BargeQuoteTotals {
  const out = { quote_id: quoteId } as BargeQuoteTotals;
  for (const k of TOTAL_KEYS) out[k] = Number(row?.[k] ?? 0);
  return out;
}

/** Load one quote (`id`) or every quote, newest first, with its takeoff,
    labor, view totals, and approval history. RLS lets every signed-in user
    read barge quotes, so this runs on the caller's own client. */
export async function loadBargeQuoteExports(
  db: SupabaseClient,
  id: string | null,
): Promise<BargeQuoteExport[]> {
  // Paged reads so nothing is truncated at Supabase's 1000-row cap.
  const [quoteRows, lineRows, laborRows, totalRows, approvalRows, profiles] =
    await Promise.all([
      fetchAllRows((from, to) => {
        let q = db.from("barge_quotes").select("*, customer:customers(display_name)");
        if (id) q = q.eq("id", id);
        return q.order("updated_at", { ascending: false }).order("id").range(from, to);
      }),
      fetchAllRows((from, to) => {
        let q = db.from("barge_quote_steel_line_costs").select("*");
        if (id) q = q.eq("quote_id", id);
        return q.order("quote_id").order("sort_order").order("id").range(from, to);
      }),
      fetchAllRows((from, to) => {
        let q = db.from("barge_quote_labor_phases").select("quote_id, name, hours");
        if (id) q = q.eq("quote_id", id);
        return q.order("quote_id").order("sort_order").order("id").range(from, to);
      }),
      fetchAllRows((from, to) => {
        let q = db.from("barge_quote_totals").select("*");
        if (id) q = q.eq("quote_id", id);
        return q.order("quote_id").range(from, to);
      }),
      fetchAllRows((from, to) => {
        let q = db
          .from("barge_quote_approvals")
          .select("quote_id, quote_version, approver_id, decision, comment, created_at");
        if (id) q = q.eq("quote_id", id);
        return q.order("created_at", { ascending: false }).order("id").range(from, to);
      }),
      fetchAllRows((from, to) =>
        db.from("profiles").select("id, full_name, email").order("id").range(from, to),
      ),
    ]);

  const nameOf = new Map(
    (profiles as { id: string; full_name: string | null; email: string | null }[]).map(
      (p) => [p.id, p.full_name || p.email || "Unknown"],
    ),
  );
  const group = <T extends { quote_id: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) {
      const list = m.get(r.quote_id);
      if (list) list.push(r);
      else m.set(r.quote_id, [r]);
    }
    return m;
  };
  const lines = group(lineRows as SteelLineCost[]);
  const labor = group(laborRows as { quote_id: string; name: string; hours: number }[]);
  const approvals = group(
    approvalRows as {
      quote_id: string;
      quote_version: number;
      approver_id: string;
      decision: string;
      comment: string | null;
      created_at: string;
    }[],
  );
  const totals = new Map(
    (totalRows as Record<string, unknown>[]).map((t) => [t.quote_id as string, t]),
  );

  return (quoteRows as (BargeQuote & { customer: { display_name: string } | null })[]).map(
    (q) => ({
      quote: q,
      customer: q.customer?.display_name ?? null,
      creator: nameOf.get(q.created_by) ?? "Unknown",
      lines: (lines.get(q.id) ?? []).map((l) => ({
        ...l,
        qty: Number(l.qty),
        unit_lb: Number(l.unit_lb),
        yield_pct: Number(l.yield_pct),
        price_per_lb: Number(l.price_per_lb),
        net_lbs: Number(l.net_lbs),
        ordered_lbs: Number(l.ordered_lbs),
        steel_cost: Number(l.steel_cost),
      })),
      labor: (labor.get(q.id) ?? []).map((p) => ({ name: p.name, hours: Number(p.hours) })),
      totals: toTotals(q.id, totals.get(q.id)),
      approvals: (approvals.get(q.id) ?? []).map((a) => ({
        version: a.quote_version,
        approver: nameOf.get(a.approver_id) ?? "Unknown",
        decision: DECISION_LABELS[a.decision] ?? a.decision,
        comment: a.comment,
        createdAt: a.created_at,
      })),
    }),
  );
}

/* ---------------------------------------------------------------------------
   Sheet helpers
--------------------------------------------------------------------------- */

const MONEY = "$#,##0.00";
const RATE = "$#,##0.00";
const LBS = "#,##0";
const TONS = "#,##0.0";
const HOURS = "#,##0";
const PCT = "0.0%";

const HEADER_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFEEF2F7" },
};

type Value = string | number | null;

function add(
  sheet: ExcelJS.Worksheet,
  values: Value[],
  fmts: (string | undefined)[] = [],
  style: { bold?: boolean; total?: boolean; indent?: boolean } = {},
) {
  // Unbounded inputs (e.g. a 0% yield) can make Infinity/NaN; Excel can't
  // hold those, so they land as blank cells.
  const row = sheet.addRow(
    values.map((v) => (typeof v === "number" && !Number.isFinite(v) ? null : v)),
  );
  fmts.forEach((f, i) => {
    if (f) row.getCell(i + 1).numFmt = f;
  });
  if (style.bold) row.font = { bold: true };
  if (style.indent) row.getCell(1).alignment = { indent: 1 };
  if (style.total)
    for (let i = 1; i <= values.length; i++)
      row.getCell(i).border = { top: { style: "thin" } };
  return row;
}

function heading(sheet: ExcelJS.Worksheet, text: string, sub: string[]) {
  sheet.addRow([text]).font = { bold: true, size: 14 };
  for (const s of sub) sheet.addRow([s]).font = { color: { argb: "FF5B6573" } };
}

function section(sheet: ExcelJS.Worksheet, text: string) {
  sheet.addRow([]);
  const row = sheet.addRow([text]);
  row.font = { bold: true, size: 12, color: { argb: "FF1F3A5F" } };
  row.getCell(1).border = { bottom: { style: "medium", color: { argb: "FF1F3A5F" } } };
}

/** A filled header row; labels sit right over number columns and left over
    the text columns listed in `textCols` (0-based). */
function columnHeader(sheet: ExcelJS.Worksheet, labels: string[], textCols: number[] = [0]) {
  const row = sheet.addRow(labels);
  row.font = { bold: true };
  labels.forEach((_, i) => {
    const cell = row.getCell(i + 1);
    cell.fill = HEADER_FILL;
    if (!textCols.includes(i)) cell.alignment = { horizontal: "right" };
  });
}

function widths(sheet: ExcelJS.Worksheet, w: number[]) {
  w.forEach((width, i) => (sheet.getColumn(i + 1).width = width));
}

function printSetup(sheet: ExcelJS.Worksheet) {
  sheet.pageSetup = {
    orientation: "portrait",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
  };
}

/** Excel-safe, unique (case-insensitive) sheet names. */
export function sheetNamer() {
  const used = new Set<string>();
  return (raw: string): string => {
    const base =
      raw.replace(/[:\\/?*[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31).trim() ||
      "Quote";
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) {
      const suffix = ` (${n})`;
      name = `${base.slice(0, 31 - suffix.length).trim()}${suffix}`;
    }
    used.add(name.toLowerCase());
    return name;
  };
}

/** ASCII file-name stem for Content-Disposition. */
export function fileSlug(s: string, fallback: string): string {
  return (
    s
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .toLowerCase()
      .slice(0, 60) || fallback
  );
}

export async function xlsxResponse(workbook: ExcelJS.Workbook, filename: string) {
  const buffer = await workbook.xlsx.writeBuffer();
  return new Response(Buffer.from(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

const VIEW_LABELS: Record<BargeCostView, string> = {
  direct: "Direct contribution",
  full: "Fully absorbed",
};

/* ---------------------------------------------------------------------------
   One saved quote, stacked top to bottom on one sheet
--------------------------------------------------------------------------- */

export function writeQuoteSheet(sheet: ExcelJS.Worksheet, x: BargeQuoteExport) {
  const { quote: q, totals: t } = x;
  const laborRate = Number(q.labor_rate);
  const overheadPct = Number(q.overhead_pct);
  const contingencyPct = Number(q.contingency_pct);
  const targetPct = Number(q.target_pct);
  const salesPrice = t.sales_price;
  widths(sheet, [50, 18, 18, 12, 10, 10, 14, 14, 16]);
  printSetup(sheet);

  heading(sheet, q.name, [
    [
      x.customer ?? "No customer",
      STATUS_LABELS[q.status] ?? q.status,
      `v${q.version}`,
      `Updated ${shortDate(q.updated_at)}`,
    ].join(" · "),
    "Saved quote, priced by the database cost views — unsaved workbench edits are not included.",
  ]);

  /* ---- Quote --------------------------------------------------------- */
  section(sheet, "Quote");
  add(sheet, ["Customer", x.customer ?? "—"]);
  add(sheet, ["Status", STATUS_LABELS[q.status] ?? q.status]);
  add(sheet, ["Version", q.version]).getCell(2).alignment = { horizontal: "left" };
  add(sheet, ["Created by", x.creator]);
  add(sheet, ["Created", shortDate(q.created_at)]);
  add(sheet, ["Submitted", shortDate(q.submitted_at)]);
  add(sheet, ["Approved", shortDate(q.approved_at)]);
  if (q.notes?.trim()) {
    const row = add(sheet, ["Notes", q.notes.trim()]);
    sheet.mergeCells(row.number, 2, row.number, 9);
    row.getCell(1).alignment = { vertical: "top" };
    row.getCell(2).alignment = { wrapText: true, vertical: "top" };
    row.height = Math.min(180, 15 * Math.ceil(q.notes.trim().length / 110 + 1));
  }

  /* ---- Pricing inputs ------------------------------------------------ */
  section(sheet, "Pricing inputs");
  add(sheet, ["Labor rate ($/hr)", laborRate], ["", RATE]);
  add(sheet, ["Blast & paint ext.", Number(q.blast_cost)], ["", MONEY]);
  add(sheet, ["Spud wells & spuds", Number(q.spuds_cost)], ["", MONEY]);
  add(sheet, ["Hatches & deck fittings", Number(q.hatches_cost)], ["", MONEY]);
  add(sheet, ["Overhead on labor", overheadPct / 100], ["", PCT]);
  add(sheet, ["Contingency", contingencyPct / 100], ["", PCT]);
  add(sheet, ["Target contribution", targetPct / 100], ["", PCT]);
  add(sheet, ["Sales price", salesPrice], ["", MONEY], { bold: true });

  /* ---- Per-unit P&L, both cost views --------------------------------- */
  section(sheet, "Per-unit P&L");
  columnHeader(sheet, ["", VIEW_LABELS.direct, VIEW_LABELS.full]);
  const both = (label: string, direct: number | null, full: number | null, fmt = MONEY) =>
    add(sheet, [label, direct, full], ["", fmt, fmt]);

  const steelBySection = new Map<BargeSection, { net: number; ordered: number; cost: number }>();
  for (const l of x.lines) {
    const s = steelBySection.get(l.section) ?? { net: 0, ordered: 0, cost: 0 };
    s.net += l.net_lbs;
    s.ordered += l.ordered_lbs;
    s.cost += l.steel_cost;
    steelBySection.set(l.section, s);
  }
  for (const sec of BARGE_SECTIONS) {
    const cost = steelBySection.get(sec)?.cost ?? 0;
    if (cost > 0) both(`Steel — ${BARGE_SECTION_LABELS[sec]}`, cost, cost);
  }
  for (const p of x.labor)
    if (p.hours > 0) {
      const cost = p.hours * laborRate;
      both(`Labor — ${p.name} (${p.hours.toLocaleString("en-US")} hrs)`, cost, cost);
    }
  both("Blast & paint ext.", Number(q.blast_cost), Number(q.blast_cost));
  both("Spud wells & spuds", Number(q.spuds_cost), Number(q.spuds_cost));
  both("Hatches & deck fittings", Number(q.hatches_cost), Number(q.hatches_cost));
  both(`Overhead on labor (${overheadPct}%)`, null, t.overhead_cost);
  if (contingencyPct > 0) {
    const share = (cost: number) => cost - cost / (1 + contingencyPct / 100);
    both(`Contingency (${contingencyPct}%)`, share(t.direct_cost), share(t.absorbed_cost));
  }
  add(sheet, ["Cost to build", t.direct_cost, t.absorbed_cost], ["", MONEY, MONEY], {
    bold: true,
    total: true,
  });
  both("Sales price", salesPrice, salesPrice);
  add(sheet, ["Margin", t.direct_margin, t.absorbed_margin], ["", MONEY, MONEY], { bold: true });
  both(
    "Margin %",
    salesPrice > 0 ? t.direct_margin / salesPrice : 0,
    salesPrice > 0 ? t.absorbed_margin / salesPrice : 0,
    PCT,
  );
  both(
    "Margin / labor hr",
    t.total_hours > 0 ? t.direct_margin / t.total_hours : null,
    t.total_hours > 0 ? t.absorbed_margin / t.total_hours : null,
  );
  both(
    `Price @ ${targetPct}% target`,
    t.price_at_target,
    t.absorbed_cost / (1 - targetPct / 100),
  );

  /* ---- Key figures --------------------------------------------------- */
  section(sheet, "Key figures");
  add(sheet, ["Net steel (lbs)", t.net_lbs], ["", LBS]);
  add(sheet, ["Ordered steel (lbs)", t.ordered_lbs], ["", LBS]);
  add(sheet, ["Net tons", t.net_tons], ["", TONS]);
  add(sheet, ["Labor hours", t.total_hours], ["", HOURS]);
  add(sheet, ["Hours per net ton", t.hours_per_ton], ["", "#,##0.0"]);
  add(
    sheet,
    ["Blended steel price ($/lb ordered)", t.ordered_lbs > 0 ? t.steel_cost / t.ordered_lbs : 0],
    ["", "$0.000"],
  );
  add(sheet, ["Crosscheck — yard heuristic, net lbs × $1.50", t.net_lbs * 1.5], ["", MONEY]);

  /* ---- Steel takeoff ------------------------------------------------- */
  section(sheet, "Steel takeoff by component");
  columnHeader(sheet, [
    "Item",
    "Qty",
    "Unit",
    "Lb/unit",
    "Yield %",
    "$/lb",
    "Net lbs",
    "Ordered lbs",
    "Cost",
  ], [0, 2]);
  const lineFmts = ["", "", "", "", PCT, RATE, LBS, LBS, MONEY];
  // "#,##0.##" would show whole numbers with a trailing dot in Excel ("55.").
  const qtyFmt = (n: number) => (Number.isInteger(n) ? "#,##0" : "#,##0.###");
  for (const sec of BARGE_SECTIONS) {
    const secLines = x.lines.filter((l) => l.section === sec);
    if (secLines.length === 0) continue;
    add(sheet, [BARGE_SECTION_LABELS[sec]], [], { bold: true });
    for (const l of secLines)
      add(
        sheet,
        [
          l.item,
          l.qty,
          l.unit,
          l.unit_lb,
          l.yield_pct / 100,
          l.price_per_lb,
          l.net_lbs,
          l.ordered_lbs,
          l.steel_cost,
        ],
        ["", qtyFmt(l.qty), "", qtyFmt(l.unit_lb), ...lineFmts.slice(4)],
        { indent: true },
      );
    const s = steelBySection.get(sec)!;
    add(
      sheet,
      [`Subtotal — ${BARGE_SECTION_LABELS[sec]}`, null, null, null, null, null, s.net, s.ordered, s.cost],
      lineFmts,
      { bold: true },
    );
  }
  add(
    sheet,
    ["Total steel", null, null, null, null, null, t.net_lbs, t.ordered_lbs, t.steel_cost],
    lineFmts,
    { bold: true, total: true },
  );

  /* ---- Labor --------------------------------------------------------- */
  section(sheet, "Labor by build phase");
  columnHeader(sheet, ["Phase", "Hours", `Cost @ $${laborRate.toFixed(2)}/hr`]);
  for (const p of x.labor) add(sheet, [p.name, p.hours, p.hours * laborRate], ["", HOURS, MONEY]);
  add(sheet, ["Total labor", t.total_hours, t.labor_cost], ["", HOURS, MONEY], {
    bold: true,
    total: true,
  });

  /* ---- Sensitivity grids --------------------------------------------- */
  const blendedRate = t.ordered_lbs > 0 ? t.steel_cost / t.ordered_lbs : 0;
  for (const view of ["direct", "full"] as const) {
    section(sheet, `Margin sensitivity — ${VIEW_LABELS[view]}`);
    sheet.addRow([
      "Margin at the sales price as total labor hours (rows) and the blended steel $/lb (columns) flex. The boxed cell is the current estimate.",
    ]).font = { italic: true, color: { argb: "FF5B6573" } };
    columnHeader(sheet, ["Hours \\ $/lb", ...SENSITIVITY_STEEL_MULTS.map(() => "")]);
    const hdr = sheet.lastRow!;
    SENSITIVITY_STEEL_MULTS.forEach((sm, j) => {
      const cell = hdr.getCell(j + 2);
      cell.value = blendedRate * sm;
      cell.numFmt = "$0.00";
    });
    const grid = marginSensitivity(t, { contingency_pct: contingencyPct, sales_price: salesPrice }, view);
    SENSITIVITY_HOUR_MULTS.forEach((hm, i) => {
      const row = add(
        sheet,
        [Math.round(t.total_hours * hm), ...grid[i]],
        [HOURS, ...grid[i].map(() => "0%")],
      );
      row.getCell(1).alignment = { horizontal: "left" };
      grid[i].forEach((m, j) => {
        const cell = row.getCell(j + 2);
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: `FF${sensitivityColor(m).slice(1).toUpperCase()}` },
        };
        cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
        cell.alignment = { horizontal: "center" };
        if (SENSITIVITY_HOUR_MULTS[i] === 1 && SENSITIVITY_STEEL_MULTS[j] === 1) {
          const edge = { style: "medium" as const, color: { argb: "FF0F1E33" } };
          cell.border = { top: edge, left: edge, bottom: edge, right: edge };
        }
      });
    });
  }

  /* ---- Approval history ---------------------------------------------- */
  if (x.approvals.length > 0) {
    section(sheet, "Approval history");
    columnHeader(sheet, ["Approver", "Decision", "Version", "Date", "Comment"], [0, 1, 4]);
    for (const a of x.approvals) {
      const row = add(sheet, [a.approver, a.decision, a.version, shortDate(a.createdAt), a.comment ?? ""]);
      row.getCell(3).alignment = { horizontal: "right" };
      row.getCell(4).alignment = { horizontal: "right" };
      row.getCell(5).alignment = { indent: 1 };
    }
  }
}

/* ---------------------------------------------------------------------------
   All quotes: one summary row each, linked to its sheet
--------------------------------------------------------------------------- */

export function writeQuotesSummarySheet(
  sheet: ExcelJS.Worksheet,
  quotes: { x: BargeQuoteExport; sheetName: string }[],
) {
  heading(sheet, "Barge quotes", [
    `Every quote in the Barge Program, newest first — ${quotes.length} quote${quotes.length === 1 ? "" : "s"}, each detailed on its own sheet (click a name).`,
    "Saved quotes, priced by the database cost views. Quotes are often alternatives for the same vessel, so columns are not totaled.",
  ]);
  sheet.addRow([]);
  const cols: { header: string; width: number; fmt?: string }[] = [
    { header: "Quote", width: 36 },
    { header: "Customer", width: 26 },
    { header: "Status", width: 18 },
    { header: "Version", width: 9 },
    { header: "Created by", width: 22 },
    { header: "Net tons", width: 10, fmt: TONS },
    { header: "Labor hours", width: 12, fmt: HOURS },
    { header: "Hrs / ton", width: 10, fmt: "#,##0.0" },
    { header: "Steel", width: 15, fmt: MONEY },
    { header: "Labor", width: 15, fmt: MONEY },
    { header: "Fit-out", width: 14, fmt: MONEY },
    { header: "Overhead", width: 14, fmt: MONEY },
    { header: "Direct cost", width: 16, fmt: MONEY },
    { header: "Fully absorbed cost", width: 18, fmt: MONEY },
    { header: "Sales price", width: 16, fmt: MONEY },
    { header: "Direct contribution", width: 18, fmt: MONEY },
    { header: "Direct %", width: 10, fmt: PCT },
    { header: "Fully absorbed margin", width: 20, fmt: MONEY },
    { header: "Absorbed %", width: 11, fmt: PCT },
    { header: "Price @ target", width: 16, fmt: MONEY },
    { header: "Updated", width: 13 },
  ];
  widths(sheet, cols.map((c) => c.width));
  sheet.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  columnHeader(sheet, cols.map((c) => c.header), [0, 1, 2, 4]);
  sheet.views = [{ state: "frozen", ySplit: sheet.lastRow!.number, xSplit: 1 }];

  for (const { x, sheetName } of quotes) {
    const { quote: q, totals: t } = x;
    const row = add(
      sheet,
      [
        q.name,
        x.customer ?? "",
        STATUS_LABELS[q.status] ?? q.status,
        q.version,
        x.creator,
        t.net_tons,
        t.total_hours,
        t.hours_per_ton,
        t.steel_cost,
        t.labor_cost,
        t.fitout_cost,
        t.overhead_cost,
        t.direct_cost,
        t.absorbed_cost,
        t.sales_price,
        t.direct_margin,
        t.direct_margin_pct,
        t.absorbed_margin,
        t.sales_price > 0 ? t.absorbed_margin / t.sales_price : 0,
        t.price_at_target,
        shortDate(q.updated_at),
      ],
      cols.map((c) => c.fmt),
    );
    // A HYPERLINK formula, not exceljs's hyperlink value: exceljs also writes
    // in-workbook links as an external relationship, which Excel can misread.
    const target = `#'${sheetName.replace(/'/g, "''")}'!A1`;
    const link = row.getCell(1);
    link.value = {
      formula: `HYPERLINK("${target.replace(/"/g, '""')}","${q.name.replace(/"/g, '""')}")`,
      result: q.name,
    };
    link.font = { color: { argb: "FF1F5FBF" }, underline: true };
    row.getCell(21).alignment = { horizontal: "right" };
  }
}

/* ---------------------------------------------------------------------------
   Rough quote: the builder's inputs, re-priced by its own model
--------------------------------------------------------------------------- */

export function writeRoughQuoteSheet(sheet: ExcelJS.Worksheet, c: BargeConfigValues) {
  const r = computeRoughQuote(c);
  const lbs = (n: number) => Math.round(n).toLocaleString("en-US");
  widths(sheet, [58, 16, 16, 16]);
  printSetup(sheet);

  heading(sheet, `Rough quote — ${c.name.trim() || "unsaved configuration"}`, [
    `${c.length_ft}′ × ${c.beam_ft}′ × ${c.depth_ft}′ · ${c.spud_wells} spud wells`,
    "Parametric estimate from the Rough Quote Builder, using the inputs on screen when exported. Not a saved quote — create an editable quote to take it through approval.",
  ]);

  /* ---- Headline ------------------------------------------------------ */
  section(sheet, "Headline");
  add(sheet, ["Net steel (tons)", r.netTons], ["", TONS]);
  add(sheet, ["Net steel (lbs)", r.netLbs], ["", LBS]);
  add(sheet, ["Ordered steel (lbs)", r.orderedLbs], ["", LBS]);
  add(sheet, ["Labor hours", r.hours], ["", HOURS]);
  add(sheet, ["Rough direct cost", r.directCost], ["", MONEY], { bold: true });
  add(sheet, ["Direct cost per net ton", r.netTons > 0 ? r.directCost / r.netTons : null], ["", MONEY]);
  add(
    sheet,
    [`Suggested price @ ${c.target_pct}% contribution (nearest $5,000)`, roundedSuggestedPrice(r)],
    ["", MONEY],
    { bold: true },
  );
  add(sheet, [`Contribution @ ${c.target_pct}%`, r.suggestedPrice - r.directCost], ["", MONEY]);

  /* ---- Inputs -------------------------------------------------------- */
  section(sheet, "Inputs");
  for (const g of CONFIG_FIELD_GROUPS) {
    sheet.addRow([g.title]).font = { bold: true, italic: true };
    for (const f of g.fields) {
      const row = add(sheet, [f.label, c[f.key], f.hint ?? ""], [], { indent: true });
      row.getCell(3).font = { color: { argb: "FF5B6573" } };
      row.getCell(3).alignment = { indent: 1 };
    }
  }

  /* ---- Build-up ------------------------------------------------------ */
  section(sheet, "Rough quote build-up");
  columnHeader(sheet, ["Component", "Net lbs", "Ordered lbs", "Cost"]);
  const yieldFrac = c.yield_pct / 100;
  for (const row of roughBuildUp(c, r))
    add(
      sheet,
      [row.label, row.lbs, row.lbs / yieldFrac, (row.lbs / yieldFrac) * c.steel_per_lb],
      ["", LBS, LBS, MONEY],
    );
  add(
    sheet,
    [
      `Steel — ${lbs(r.netLbs)} net lbs ÷ ${c.yield_pct}% yield × $${c.steel_per_lb.toFixed(2)}/lb`,
      r.netLbs,
      r.orderedLbs,
      r.steelCost,
    ],
    ["", LBS, LBS, MONEY],
    { bold: true, total: true },
  );
  add(
    sheet,
    [`Direct labor — ${r.hours.toLocaleString("en-US")} hrs × $${c.labor_rate}`, null, null, r.laborCost],
    ["", "", "", MONEY],
  );
  add(
    sheet,
    [`Blast & paint — ${lbs(r.extArea)} sqft × $${c.blast_per_sqft.toFixed(2)}`, null, null, r.blastCost],
    ["", "", "", MONEY],
  );
  add(
    sheet,
    [`Spud well package — ${c.spud_wells} × ${moneyWhole(c.spud_well_cost)}`, null, null, r.spudsCost],
    ["", "", "", MONEY],
  );
  add(
    sheet,
    [`Fittings & hatches — ${lbs(r.deckArea)} sqft × $${c.fittings_per_sqft.toFixed(2)}`, null, null, r.fittingsCost],
    ["", "", "", MONEY],
  );
  add(sheet, ["Rough direct cost", null, null, r.directCost], ["", "", "", MONEY], {
    bold: true,
    total: true,
  });
  add(
    sheet,
    [`Suggested price @ ${c.target_pct}% contribution (nearest $5,000)`, null, null, roundedSuggestedPrice(r)],
    ["", "", "", MONEY],
    { bold: true },
  );

  /* ---- Geometry ------------------------------------------------------ */
  section(sheet, "Geometry");
  add(sheet, ["Deck area (sqft)", r.deckArea], ["", LBS]);
  add(sheet, ["Side shell area, both sides (sqft)", r.sideArea], ["", LBS]);
  add(sheet, ["End area, both ends (sqft)", r.endArea], ["", LBS]);
  add(sheet, ["Exterior blast area (sqft)", r.extArea], ["", LBS]);
  add(sheet, ["Longitudinal bulkheads", r.longBhds]);
  add(sheet, ["Watertight bulkheads", r.wtBhds]);

  /* ---- Method note --------------------------------------------------- */
  section(sheet, "How this estimate is built");
  const note = add(sheet, [
    "Shell and bulkhead plate is computed from geometry at the thicknesses entered (steel = 40.8 lb/sqft per inch). The plate allowance covers rakes, spud-well structure, laps and brackets, and the framing-and-trusses factor converts plate weight to total net steel — both calibrated so that at 150′ × 54′ × 8′ this model reproduces the naval architect's engineered takeoff (≈807,000 lbs net) within 0.5%. Hours default to the industry first-article benchmark — deliberately conservative against the yard's 8.7 hrs/ton claim.",
  ]);
  sheet.mergeCells(note.number, 1, note.number, 4);
  note.getCell(1).alignment = { wrapText: true, vertical: "top" };
  note.height = 90;
}
