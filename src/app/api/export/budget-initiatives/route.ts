import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { BUDGET_YEAR } from "@/lib/budget";
import { loadInitiatives } from "@/lib/budgetServer";
import { writeInitiativesByMonth } from "@/lib/budgetInitiativeSheet";

// Excel export of budget initiatives by month (/financials/budget's New
// initiatives panel). `?id=<initiative>` exports that one initiative;
// otherwise `?company=<realm|all>` exports every initiative for the companies
// in view, led by what the approved ones add to the budget each month. Reads
// only the initiative tables — no ledger — so it's quick; the spread is the
// budget's own (spreadInitiativeLine), so the file matches the statement.
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
  const companyName = (realmId: string) => companyByRealm.get(realmId) ?? realmId;

  const sp = new URL(request.url).searchParams;
  const id = sp.get("id");
  const company =
    sp.get("company") && companyByRealm.has(sp.get("company")!)
      ? sp.get("company")!
      : "all";
  const realms = id || company === "all" ? [...companyByRealm.keys()] : [company];
  const year = BUDGET_YEAR;

  let initiatives = await loadInitiatives(db, year, realms);
  if (id) {
    initiatives = initiatives.filter((i) => i.id === id);
    if (initiatives.length === 0) {
      return NextResponse.json({ error: "Initiative not found" }, { status: 404 });
    }
  }

  const single = id ? initiatives[0] : null;
  const scopeLabel = company === "all" ? "All companies" : companyName(company);
  const workbook = new ExcelJS.Workbook();
  writeInitiativesByMonth(workbook.addWorksheet("By month"), initiatives, {
    year,
    title: single
      ? `${single.name} — ${year} by month`
      : `New initiatives ${year} by month — ${scopeLabel}`,
    companyName,
    summary: !single,
  });

  const slug = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "initiative";
  const filename = single
    ? `initiative-${year}-${slug(single.name)}-by-month.xlsx`
    : `initiatives-${year}-${company === "all" ? "all-companies" : company}-by-month.xlsx`;
  const buffer = await workbook.xlsx.writeBuffer();
  return new Response(Buffer.from(buffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
