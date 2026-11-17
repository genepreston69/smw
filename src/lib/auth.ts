import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Profile } from "@/lib/types";
import { throwIfError } from "@/lib/supabase/throwIfError";

export async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("id, email, full_name, role")
    .eq("id", user.id)
    .maybeSingle();
  // A failed read is an outage, not a missing profile: show the error page
  // rather than bouncing a signed-in user back to the login screen.
  throwIfError("your profile", error);

  if (!profile) redirect("/login");
  return { supabase, user, profile: profile as Profile };
}

// For admin-only pages (e.g. Financials). RLS already denies the underlying
// data to non-admins; this keeps them from landing on an empty page.
export async function requireAdmin() {
  const ctx = await requireUser();
  if (ctx.profile.role !== "admin") redirect("/");
  return ctx;
}
