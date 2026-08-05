// Client-side mirror of the signup domain whitelist enforced by
// handle_new_user (supabase/migrations/0016_signup_domain_whitelist.sql).
// The database is the real gate; this exists so the signup form can show a
// clear message instead of Supabase's generic database error. Keep both
// lists in lockstep.
export const ALLOWED_SIGNUP_DOMAINS = [
  "superiormarineinc.com",
  "stravisor.com",
  "riverwalkoh.com",
] as const;

export function isAllowedSignupEmail(email: string): boolean {
  const domain = email.trim().toLowerCase().split("@").pop() ?? "";
  return (ALLOWED_SIGNUP_DOMAINS as readonly string[]).includes(domain);
}
