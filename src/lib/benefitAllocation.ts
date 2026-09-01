import "server-only";

import { createServiceClient } from "@/lib/supabase/service";

/**
 * Rebuild the cached per-job employee-benefit allocation
 * (job_benefit_allocation_cache, migration 0025).
 *
 * Deriving the allocation from the raw ledger is far too slow for a page
 * load, so it is materialized and rebuilt at the only three moments its
 * inputs change: a jobs/costs sync, a ledger sync, and an account's category
 * changing. Refreshing is granted to service_role alone, so this must run
 * behind an admin check on the server.
 *
 * A failed refresh leaves the previous numbers in place rather than failing
 * the caller's own work — the dashboards go stale until the next sync, which
 * is why the failure is logged.
 */
export async function refreshBenefitAllocation(): Promise<void> {
  const supabase = createServiceClient();
  const { error } = await supabase.rpc("refresh_job_benefit_allocation");
  if (error) {
    console.error(`Benefit allocation refresh failed: ${error.message}`);
  }
}
