// Enterprise (intercompany) entities. A job whose customer is one of these
// is work performed for a sister company, not external revenue.
//
// Matching is deliberately fuzzy: QuickBooks customer names vary
// ("Superior Marine", "Superior Marine Inc.", "SMW LLC"), so phrases match as
// substrings and short acronyms match as whole words only.

//
// The list itself is a setting (Settings → Business rules, public.app_settings;
// defaults in appSettings.ts). It is a required argument rather than an import
// so every screen and export that buckets jobs is forced to pass the same
// loaded list — they must all bucket identically.
import type { IntercompanyRules } from "@/lib/appSettings";

export function isEnterpriseName(
  name: string | null | undefined,
  rules: IntercompanyRules,
): boolean {
  if (!name) return false;
  const n = name.toLowerCase();
  if (rules.phrases.some((p) => n.includes(p))) return true;
  const words = n.split(/[^a-z0-9]+/);
  return rules.acronyms.some((a) => words.includes(a));
}
