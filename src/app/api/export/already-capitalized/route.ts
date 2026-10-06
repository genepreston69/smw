import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import {
  CAP_LINE_KIND_LABELS,
  capLineSide,
  capScheduleErrorMessage,
  capScheduleYear,
} from "@/lib/alreadyCapitalized";
import { loadCapSchedule } from "@/lib/alreadyCapitalizedServer";
import { shortDate } from "@/lib/format";

// Excel workbook for the Already Capitalized schedule
// (/capitalized-labor/already-capitalized): By Asset Account, Journal
// Entries, and every line of those entries, for the year on screen. Same
// loader (loadCapSchedule) and assembly as the page, so the file matches it.
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Built from the general ledger, which is admin-only (the 403 gives
  // direct callers a clear error instead of an empty workbook).
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Admin verified; GL reads go through the service-role client because the
  // admin RLS qual on the gl_* tables is too slow for app reads.
  const db = createServiceClient();
  const year = capScheduleYear(new URL(request.url).searchParams.get("year") ?? undefined);

  let loaded: Awaited<ReturnType<typeof loadCapSchedule>>;
  try {
    loaded = await loadCapSchedule(db, year);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`Already Capitalized export: schedule read failed: ${message}`);
    return NextResponse.json({ error: capScheduleErrorMessage(message) }, { status: 503 });
  }
  const { period, schedule } = loaded;
  const { data: connRows } = await db
    .from("qb_connection_status")
    .select("realm_id, company_name");
  const companyName = new Map(
    ((connRows ?? []) as { realm_id: string; company_name: string | null }[]).map((c) => [
      c.realm_id,
      c.company_name ?? `Company ${c.realm_id}`,
    ]),
  );
  const company = (realmId: string) => companyName.get(realmId) ?? realmId;
  const moneyFmt = "#,##0.00";

  const workbook = new ExcelJS.Workbook();
  const titled = (name: string, title: string, note: string) => {
    const sheet = workbook.addWorksheet(name);
    sheet.addRow([title]).font = { bold: true, size: 13 };
    sheet.addRow([note]);
    sheet.addRow([]);
    return sheet;
  };
  const header = (sheet: ExcelJS.Worksheet, cols: { header: string; width: number; money?: boolean }[]) => {
    sheet.addRow(cols.map((c) => c.header)).font = { bold: true };
    sheet.views = [{ state: "frozen", ySplit: 4 }];
    cols.forEach((c, i) => {
      const col = sheet.getColumn(i + 1);
      col.width = c.width;
      if (c.money) col.numFmt = moneyFmt;
    });
  };
  const definition =
    "Journal entries that debit a Fixed Asset or Other Asset account and credit wages or employer payroll taxes; labor capitalized is the entry's net credit to those accounts.";

  /* ---- By asset account ------------------------------------------- */
  const assetSheet = titled(
    "By Asset Account",
    `Labor capitalized by asset account — ${period.label}`,
    `${definition} An entry that debits several assets splits its labor in proportion to each asset's debit.`,
  );
  header(assetSheet, [
    { header: "Asset Account", width: 42 },
    { header: "QB Company", width: 24 },
    { header: "Entries", width: 9 },
    { header: "Labor Capitalized", width: 18, money: true },
  ]);
  for (const a of schedule.byAsset)
    assetSheet.addRow([a.account, company(a.realmId), a.entries, a.labor]);
  assetSheet.addRow(["Total", "", schedule.entries.length, schedule.total]).font = { bold: true };

  /* ---- Journal entries -------------------------------------------- */
  const entrySheet = titled("Journal Entries", `Capitalization entries — ${period.label}`, definition);
  header(entrySheet, [
    { header: "Date", width: 12 },
    { header: "Journal Entry", width: 14 },
    { header: "QB Company", width: 24 },
    { header: "Asset Account(s)", width: 40 },
    { header: "Job(s)", width: 32 },
    { header: "Labor Account(s)", width: 36 },
    { header: "Labor Capitalized", width: 18, money: true },
    { header: "Asset Debit", width: 15, money: true },
    { header: "Memo", width: 48 },
  ]);
  for (const e of schedule.entries)
    entrySheet.addRow([
      shortDate(e.date),
      e.docNumber ?? `#${e.qbTxnId}`,
      company(e.realmId),
      e.assets.map((a) => a.account).join("; "),
      e.jobs.join("; "),
      e.laborAccounts.map((a) => a.account).join("; "),
      e.labor,
      e.assetDebit,
      e.memo ?? "",
    ]);
  entrySheet.addRow(["Total", "", "", "", "", "", schedule.total, null, ""]).font = {
    bold: true,
  };

  /* ---- Lines ------------------------------------------------------- */
  const lineSheet = titled(
    "Lines",
    `Capitalization entry lines — ${period.label}`,
    "Every ledger line of the entries above, so each one traces to QuickBooks by journal number.",
  );
  header(lineSheet, [
    { header: "Date", width: 12 },
    { header: "Journal Entry", width: 14 },
    { header: "QB Company", width: 24 },
    { header: "Line", width: 8 },
    { header: "Account", width: 42 },
    { header: "Job", width: 32 },
    { header: "Debit", width: 14, money: true },
    { header: "Credit", width: 14, money: true },
    { header: "Memo", width: 48 },
  ]);
  for (const e of schedule.entries)
    for (const l of e.lines) {
      const { debit, credit } = capLineSide(l);
      lineSheet.addRow([
        shortDate(l.date),
        l.docNumber ?? `#${l.qbTxnId}`,
        company(l.realmId),
        CAP_LINE_KIND_LABELS[l.kind],
        l.account,
        l.customer ?? "",
        debit || null,
        credit || null,
        l.memo ?? "",
      ]);
    }

  const buffer = await workbook.xlsx.writeBuffer();
  return new Response(Buffer.from(buffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="already-capitalized-${year}.xlsx"`,
    },
  });
}
