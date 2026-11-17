import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { SyncBusyError, runManualSync } from "@/lib/qbSyncSchedule";
import { refreshBenefitAllocation } from "@/lib/benefitAllocation";

// General-ledger import for ONE company per request. Importing every
// company's ledger in a single invocation exceeds Vercel's function window
// (the full sync 504s at 300s with several companies connected), so the
// sync button calls this once per connected realm after the main sync.
export const maxDuration = 300;

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "admin") {
    return NextResponse.json(
      { error: "Only admins can run a sync" },
      { status: 403 },
    );
  }

  const body = await request.json().catch(() => null);
  const realmId = typeof body?.realmId === "string" ? body.realmId : null;
  if (!realmId) {
    return NextResponse.json({ error: "Missing realmId" }, { status: 400 });
  }

  try {
    // Through the sync queue (migration 0039), so this can't overlap the
    // nightly sync or another manual one — two imports of one company's
    // ledger at once can delete each other's rows.
    const [result] = await runManualSync([
      { kind: "general_ledger", realm_id: realmId, label: "General ledger" },
    ]);
    // The ledger is where the benefits/salaries/labor pools come from, so
    // the cached allocation is rebuilt from the new lines (migration 0025).
    await refreshBenefitAllocation();
    return NextResponse.json({
      ok: true,
      glAccounts: result.glAccounts,
      glLines: result.glLines,
      // True when QuickBooks rejected the class/customer/vendor columns.
      withoutClasses: (result.withoutClasses ?? 0) > 0,
    });
  } catch (e) {
    if (e instanceof SyncBusyError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Ledger sync failed" },
      { status: 500 },
    );
  }
}
