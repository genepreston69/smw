import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_SETTINGS, settingsFromRows, type AppSettings } from "@/lib/appSettings";

/**
 * The admin-editable business rules (public.app_settings, migration 0041).
 * Works with any client: every signed-in user may read them.
 *
 * Until migration 0041 is applied there is no table; that reads as "nothing
 * changed yet" and returns the defaults, so the app keeps working. Any other
 * failure throws — silently pricing a budget for the wrong year would be
 * worse than an error page.
 */
export async function loadAppSettings(db: SupabaseClient): Promise<AppSettings> {
  const { data, error } = await db.from("app_settings").select("key, value");
  if (error) {
    // 42P01 from Postgres, PGRST205 from the API's schema cache.
    if (error.code === "42P01" || error.code === "PGRST205") return DEFAULT_SETTINGS;
    throw new Error(`Could not load the business rules: ${error.message}`);
  }
  return settingsFromRows((data ?? []) as { key: string; value: unknown }[]);
}
