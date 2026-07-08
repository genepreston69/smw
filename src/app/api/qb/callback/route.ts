import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { exchangeCode, saveConnection } from "@/lib/quickbooks";

export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const origin = url.origin;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const realmId = url.searchParams.get("realmId");

  const settings = new URL("/settings", origin);

  const cookieStore = await cookies();
  const expectedState = cookieStore.get("qb_oauth_state")?.value;
  cookieStore.delete("qb_oauth_state");

  if (!code || !realmId || !state || state !== expectedState) {
    settings.searchParams.set("qb_error", "OAuth state mismatch or missing code");
    return NextResponse.redirect(settings);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login", origin));

  try {
    const tokens = await exchangeCode(code, origin);
    await saveConnection({ realmId, tokens, connectedBy: user.id });
    settings.searchParams.set("qb_connected", "1");
  } catch (e) {
    settings.searchParams.set(
      "qb_error",
      e instanceof Error ? e.message : "Connection failed",
    );
  }
  return NextResponse.redirect(settings);
}
