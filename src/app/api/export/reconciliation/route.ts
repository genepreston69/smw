import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  MAX_RECONCILE_FILE_BYTES,
  reconcileQbWorkbook,
} from "@/lib/reconcileServer";
import {
  PlParseError,
  RECON_STATUS_LABELS,
  type ReconciliationResult,
} from "@/lib/reconciliation";
import { monthLabel } from "@/lib/financials";

// Excel export of the QuickBooks reconciliation: POST the same P&L export
// the Reconciliation page uploads, and the shared pipeline
// (src/lib/reconcileServer.ts) re-runs the identical parse → truncate →
// compare steps — the file always matches the tie-out on screen. POST
// rather than GET because the reconciliation is derived from an uploaded
// workbook, not from query params.
export async function POST(request: Request) {
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

  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json(
      { error: "Attach the QuickBooks Excel export as \"file\"" },
      { status: 400 },
    );
  }
  if (file.size > MAX_RECONCILE_FILE_BYTES) {
    return NextResponse.json(
      { error: "File is too large to be a QuickBooks export" },
      { status: 400 },
    );
  }

  let result: ReconciliationResult;
  try {
    result = await reconcileQbWorkbook(await file.arrayBuffer());
  } catch (e) {
    const message =
      e instanceof PlParseError
        ? e.message
        : e instanceof Error
          ? e.message
          : "Reconciliation failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Reconciliation");

  sheet.addRow(["Reconciliation with QuickBooks"]).font = {
    bold: true,
    size: 13,
  };
  const { summary } = result;
  sheet.addRow([
    [
      `${result.period.start} – ${result.period.end}`,
      "QuickBooks Profit and Loss vs imported general ledger",
      "Difference = QuickBooks − imported GL",
      `${summary.tied} tied · ${summary.variance} with variances · ${summary.qbOnly + summary.glOnly} unmatched`,
    ].join(" · "),
  ]);
  sheet.addRow([]);
  const header = sheet.addRow([
    "Account",
    "QuickBooks",
    "Imported GL",
    "Difference",
    "Status",
  ]);
  header.font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 4 }];

  sheet.getColumn(1).width = 42;
  for (const i of [2, 3, 4]) {
    const col = sheet.getColumn(i);
    col.width = 15;
    col.numFmt = "#,##0.00";
  }
  sheet.getColumn(5).width = 18;

  for (const section of result.sections) {
    sheet.addRow([section.label]).font = { bold: true };
    for (const r of section.rows) {
      sheet.addRow([
        r.account,
        r.qbTotal,
        r.glTotal,
        r.diff,
        RECON_STATUS_LABELS[r.status],
      ]);
    }
    sheet.addRow([
      `Total ${section.label}`,
      section.qbTotal,
      section.glTotal,
      section.diff,
    ]).font = { bold: true };
  }
  sheet.addRow([
    result.eliminations ? "Net income before eliminations" : "Net income",
    result.netIncome.qb,
    result.netIncome.gl,
    result.netIncome.diff,
  ]).font = { bold: true };

  // Same adjustment as the page: eliminations hit only the GL side, and the
  // meaningful tie for a consolidated export is the after-eliminations row.
  if (result.eliminations) {
    sheet.addRow(["Intercompany eliminations (imported GL side)"]).font = {
      bold: true,
    };
    for (const line of result.eliminations.lines) {
      sheet.addRow([line.label, null, line.total]);
    }
    sheet.addRow([
      "Net income after eliminations",
      result.eliminations.netIncome.qb,
      result.eliminations.netIncome.gl,
      result.eliminations.netIncome.diff,
    ]).font = { bold: true };
  }

  if (result.warnings.length > 0) {
    sheet.addRow([]);
    for (const w of result.warnings) sheet.addRow([`Note: ${w}`]);
  }

  // Month-level variances on a second sheet: one row per account × month
  // where the two sides disagree — the same chips the page shows inline.
  const monthRows = [
    ...result.sections.flatMap((section) =>
      section.rows.flatMap((r) =>
        r.monthDiffs.map((m) => [section.label, r.account, m] as const),
      ),
    ),
    ...result.netIncome.monthDiffs.map(
      (m) =>
        [
          "",
          result.eliminations ? "Net income before eliminations" : "Net income",
          m,
        ] as const,
    ),
    ...(result.eliminations?.netIncome.monthDiffs.map(
      (m) => ["", "Net income after eliminations", m] as const,
    ) ?? []),
  ];
  if (monthRows.length > 0) {
    const detail = workbook.addWorksheet("Month variances");
    const detailHeader = detail.addRow([
      "Section",
      "Account",
      "Month",
      "QuickBooks",
      "Imported GL",
      "Difference",
    ]);
    detailHeader.font = { bold: true };
    detail.views = [{ state: "frozen", ySplit: 1 }];
    detail.getColumn(1).width = 22;
    detail.getColumn(2).width = 42;
    detail.getColumn(3).width = 12;
    for (const i of [4, 5, 6]) {
      const col = detail.getColumn(i);
      col.width = 15;
      col.numFmt = "#,##0.00";
    }
    for (const [sectionLabel, account, m] of monthRows) {
      detail.addRow([sectionLabel, account, monthLabel(m.key), m.qb, m.gl, m.diff]);
    }
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return new Response(Buffer.from(buffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="reconciliation-${result.period.start}-to-${result.period.end}.xlsx"`,
    },
  });
}
