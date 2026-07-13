import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/fetchAll";
import { csvResponse, toCsv } from "@/lib/csv";
import { isEnterpriseName } from "@/lib/enterprise";
import { shortDate } from "@/lib/format";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Paged read so the CSV includes every customer past Supabase's
  // 1000-row cap.
  const [customers, { data: connRows }] = await Promise.all([
    fetchAllRows((from, to) =>
      supabase
        .from("customers")
        .select(
          "id, realm_id, display_name, company_name, email, phone, active, last_synced_at",
        )
        .order("display_name")
        .order("id")
        .range(from, to),
    ),
    supabase.from("qb_connection_status").select("realm_id, company_name"),
  ]);

  const companyByRealm = new Map(
    (connRows ?? []).map((c) => [c.realm_id, c.company_name]),
  );

  const csv = toCsv(
    [
      "Customer",
      "QB Company",
      "Company",
      "Email",
      "Phone",
      "Intercompany",
      "Active",
      "Last Synced",
    ],
    customers.map((c) => [
      c.display_name,
      c.realm_id ? (companyByRealm.get(c.realm_id) ?? c.realm_id) : "",
      c.company_name,
      c.email,
      c.phone,
      isEnterpriseName(c.display_name) || isEnterpriseName(c.company_name)
        ? "Yes"
        : "No",
      c.active ? "Yes" : "No",
      c.last_synced_at ? shortDate(c.last_synced_at) : "",
    ]),
  );

  return csvResponse(csv, "customers.csv");
}
