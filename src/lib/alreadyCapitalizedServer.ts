import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  assembleCapSchedule,
  parseCapLines,
  type CapSchedule,
} from "@/lib/alreadyCapitalized";
import type { CapLaborWindow } from "@/lib/capitalizedLabor";

// Shared by the Already Capitalized page and its Excel export so both read
// exactly the same lines. Callers verify the admin role first and pass the
// service-role client (GL data is admin-only — same access pattern as every
// Financials read; see migrations 0014/0015/0032).
export async function loadCapSchedule(
  db: SupabaseClient,
  period: CapLaborWindow,
): Promise<CapSchedule> {
  const { data, error } = await db.rpc("capitalized_labor_entries", {
    p_from: period.from,
    p_to: period.to,
  });
  if (error) throw new Error(error.message);
  return assembleCapSchedule(parseCapLines(data));
}
