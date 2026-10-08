import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import {
  balanceColLabel,
  balanceSheetState,
  monthEndLabel,
  type BalanceSection,
  type BalanceTotals,
} from "@/lib/balanceSheet";
import { loadBalanceSheet } from "@/lib/balanceSheetServer";

// Excel export of the Balance Sheet: same query params as
// /financials/balance-sheet, same loadBalanceSheet read and
// buildBalanceSheet assembly — the file always matches the sheet on screen,
// with account rows nested under their group via Excel row grouping.
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
  const state = balanceSheetState((k) => sp.get(k), new Set(companyByRealm.keys()));
  const { company, from, to, cols } = state;
  let sheet;
  try {
    ({ sheet } = await loadBalanceSheet(db, state, [...companyByRealm.keys()]));
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Balance sheet load failed" },
      { status: 500 },
    );
  }
  const colLabels = sheet.colKeys.map((k) => balanceColLabel(cols, k, companyByRealm));

  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet("Balance Sheet");
  // Group rows sit above their member accounts, so Excel's outline collapse
  // buttons belong on the row above the group.
  ws.properties.outlineProperties = { summaryBelow: false, summaryRight: false };

  ws.addRow(["Balance Sheet"]).font = { bold: true, size: 13 };
  ws.addRow([
    [
      company === "all" ? "All companies" : companyByRealm.get(company),
      cols === "company"
        ? `As of ${monthEndLabel(to)}`
        : `${monthEndLabel(from)} – ${monthEndLabel(to)}`,
      "QuickBooks month-end balances, accrual basis",
      company === "all" ? "Companies added together as booked, no intercompany eliminations" : null,
    ]
      .filter(Boolean)
      .join(" · "),
  ]);
  ws.addRow([]);
  ws.addRow(["Account", ...colLabels]).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 4, xSplit: 1 }];
  ws.getColumn(1).width = 48;
  colLabels.forEach((_, i) => {
    const c = ws.getColumn(2 + i);
    c.width = 16;
    c.numFmt = "#,##0.00;[Red]-#,##0.00";
  });

  const cells = (t: BalanceTotals) => sheet.colKeys.map((k) => t.cells[k] ?? null);
  const boldRow = (label: string, t: BalanceTotals) => {
    ws.addRow([label, ...cells(t)]).font = { bold: true };
  };

  const writeSection = (section: BalanceSection) => {
    if (section.groups.length === 0) return;
    ws.addRow([section.label.toUpperCase()]).font = { bold: true };
    const lastCurrent = section.groups.findLastIndex((g) => g.current);
    const showCurrent = section.current !== null && section.groups.some((g) => !g.current);
    section.groups.forEach((group, i) => {
      ws.addRow([group.label, ...cells(group)]);
      if (!group.single) {
        // Member accounts nest under the group as a collapsible Excel
        // group, mirroring the expandable rows on screen.
        for (const r of group.rows) {
          const row = ws.addRow([
            r.accountNumber ? `${r.accountNumber} · ${r.key}` : r.key,
            ...cells(r),
          ]);
          row.outlineLevel = 1;
          row.getCell(1).alignment = { indent: 2 };
        }
      }
      if (showCurrent && i === lastCurrent) {
        boldRow(`Total current ${section.label.toLowerCase()}`, section.current!);
      }
    });
    boldRow(`Total ${section.label.toLowerCase()}`, section);
  };

  writeSection(sheet.assets);
  writeSection(sheet.liabilities);
  writeSection(sheet.equity);
  boldRow("Total liabilities and equity", sheet.liabilitiesAndEquity);
  writeSection(sheet.other);
  if (sheet.difference) boldRow("Out of balance (assets − liabilities and equity)", sheet.difference);

  const buffer = await workbook.xlsx.writeBuffer();
  const companySlug =
    company === "all"
      ? "all-companies"
      : (companyByRealm.get(company) ?? company)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") || "company";
  const period = cols === "company" ? `as-of-${to}` : `${from}-to-${to}`;
  return new Response(Buffer.from(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="balance-sheet-${companySlug}-${cols}-${period}.xlsx"`,
    },
  });
}
