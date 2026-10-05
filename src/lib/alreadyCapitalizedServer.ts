import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  assembleCapSchedule,
  capScheduleWindow,
  parseCapLines,
  type CapSchedule,
} from "@/lib/alreadyCapitalized";

// Shared by the Already Capitalized page and its Excel export so both read
// exactly the same lines. Callers verify the admin role first and pass the
// service-role client (GL data is admin-only — same access pattern as every
// Financials read; see migrations 0014/0015/0032).
export async function loadCapSchedule(
  db: SupabaseClient,
  year: number,
): Promise<{ period: ReturnType<typeof capScheduleWindow>; schedule: CapSchedule }> {
  const period = capScheduleWindow(year);
  const { data, error } = await db.rpc("capitalized_labor_entries", {
    p_from: period.from,
    p_to: period.to,
  });
  if (error) throw new Error(error.message);
  return { period, schedule: assembleCapSchedule(parseCapLines(data)) };
}
