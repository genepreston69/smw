import "server-only";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { supabaseServiceRoleKey, supabaseUrl } from "@/lib/env";

// Service-role client: bypasses RLS. Server-side only — used by the
// QuickBooks sync, which writes customers/jobs and reads/writes qb_connections.
export function createServiceClient() {
  return createSupabaseClient(supabaseUrl(), supabaseServiceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
