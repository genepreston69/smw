// Enterprise (intercompany) entities. A job whose customer is one of these
// is work performed for a sister company, not external revenue.
//
// Matching is deliberately fuzzy: QuickBooks customer names vary
// ("Superior Marine", "Superior Marine Inc.", "SMW LLC"), so phrases match as
// substrings and short acronyms match as whole words only.

const ENTERPRISE_PHRASES = [
  "precision paint",
  "superior marine",
  "inland river dredging",
];

const ENTERPRISE_ACRONYMS = ["smw", "irdc"];

export function isEnterpriseName(name: string | null | undefined): boolean {
  if (!name) return false;
  const n = name.toLowerCase();
  if (ENTERPRISE_PHRASES.some((p) => n.includes(p))) return true;
  const words = n.split(/[^a-z0-9]+/);
  return ENTERPRISE_ACRONYMS.some((a) => words.includes(a));
}
