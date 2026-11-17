import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { SyncBusyError, runManualSync } from "@/lib/qbSyncSchedule";
import { refreshBenefitAllocation } from "@/lib/benefitAllocation";

// Entity queries across several companies take a while; the general-ledger
// import runs separately (one request per company via /api/qb/sync-ledger)
// because everything in one invocation exceeds even this window.
export const maxDuration = 300;

export async function POST() {
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

  try {
    // Through the sync queue (migration 0039), so this can't overlap the
    // nightly sync or another admin's manual one.
    const [entities, costs] = await runManualSync([
      { kind: "customers_jobs", realm_id: null, label: "Customers & jobs" },
      { kind: "job_costs", realm_id: null, label: "Actual costs & invoices" },
    ]);
    // Job labor drives the allocation's pro-rata split, so the cache is
    // stale the moment costs change (migration 0025).
    await refreshBenefitAllocation();
    return NextResponse.json({
      ok: true,
      ...entities,
      costLines: costs.costLines,
      invoices: costs.invoices,
    });
  } catch (e) {
    if (e instanceof SyncBusyError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Sync failed" },
      { status: 500 },
    );
  }
}
