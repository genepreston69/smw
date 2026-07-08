import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { revokeConnection } from "@/lib/quickbooks";

export async function POST(request: NextRequest) {
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
      { error: "Only admins can disconnect QuickBooks" },
      { status: 403 },
    );
  }

  let realmId: string | undefined;
  try {
    const body = await request.json();
    if (typeof body?.realmId === "string") realmId = body.realmId;
  } catch {
    // No body — disconnect the only/first connection.
  }

  try {
    await revokeConnection(realmId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Disconnect failed" },
      { status: 500 },
    );
  }
}
