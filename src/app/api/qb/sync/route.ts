import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { syncCustomersAndJobs, syncJobCosts } from "@/lib/quickbooks";

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
    const result = await syncCustomersAndJobs();
    const costs = await syncJobCosts();
    return NextResponse.json({ ok: true, ...result, costLines: costs.costLines });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Sync failed" },
      { status: 500 },
    );
  }
}
