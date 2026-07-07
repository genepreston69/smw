// The Vercel Supabase Marketplace add-on injects SUPABASE_URL / SUPABASE_ANON_KEY
// (and NEXT_PUBLIC_ variants depending on framework detection). Accept both.
export function supabaseUrl(): string {
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  if (!url) throw new Error("Missing SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL");
  return url;
}

export function supabaseAnonKey(): string {
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (!key)
    throw new Error("Missing SUPABASE_ANON_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY");
  return key;
}

export function supabaseServiceRoleKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
  return key;
}
