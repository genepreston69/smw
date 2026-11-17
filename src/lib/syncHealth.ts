import "server-only";

import { createServiceClient } from "@/lib/supabase/service";
import { SYNC_TIMEZONE } from "@/lib/qbSyncSchedule";

// How fresh the QuickBooks data is, and whether the sync needs attention.
//
// The app layout shows this on every page: a "data as of" stamp for everyone,
// and for admins a banner whenever the sync is failing or has gone quiet — a
// failed nightly run used to be visible only on the Settings page, so the
// dashboards could sit days behind with nothing saying so.
//
// Read through the service-role client because the sync tables are admin-only
// under RLS; what leaves this module is timestamps for everyone and problem
// text for admins only (the layout decides). Every successful import — nightly
// or manual — is a succeeded step in qb_sync_steps (migrations 0024 / 0039).

/** A sync this old means at least one morning was missed. */
const STALE_AFTER_HOURS = 36;

export interface SyncHealth {
  /** Timezone the stamps should be shown in. */
  timezone: string;
  /** Last successful import of job costs and invoices; null if never. */
  costsAsOf: string | null;
  /** Last successful ledger import of the company whose ledger is oldest;
      null if any connected company has never had one. */
  ledgerAsOf: string | null;
  /** True when costsAsOf is missing or older than STALE_AFTER_HOURS. */
  costsStale: boolean;
  /** Admin-facing: what is wrong, most important first. Empty = healthy. */
  problems: string[];
}

const hoursSince = (iso: string | null): number =>
  iso ? (Date.now() - Date.parse(iso)) / 3_600_000 : Infinity;

/**
 * Sync health for the layout, or null when QuickBooks isn't connected or the
 * check itself failed — this must never take a page down.
 */
export async function loadSyncHealth(): Promise<SyncHealth | null> {
  try {
    const db = createServiceClient();
    const [connRes, stepRes, runRes] = await Promise.all([
      db
        .from("qb_connections")
        .select("realm_id, company_name, status, last_sync_error")
        .order("created_at"),
      // Newest first; a month of nightly runs plus manual syncs fits easily.
      db
        .from("qb_sync_steps")
        .select("kind, realm_id, finished_at")
        .eq("status", "succeeded")
        .in("kind", ["job_costs", "general_ledger"])
        .order("finished_at", { ascending: false })
        .limit(300),
      db
        .from("qb_sync_runs")
        .select("id, status, started_at")
        .eq("trigger", "scheduled")
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (connRes.error) throw new Error(connRes.error.message);
    if (stepRes.error) throw new Error(stepRes.error.message);
    if (runRes.error) throw new Error(runRes.error.message);

    const connections = (connRes.data ?? []) as {
      realm_id: string;
      company_name: string | null;
      status: string;
      last_sync_error: string | null;
    }[];
    // Same set the nightly run plans steps for; a revoked company is gone.
    const active = connections.filter(
      (c) => c.status === "connected" || c.status === "error",
    );
    if (active.length === 0) return null;
    const nameOf = (c: { realm_id: string; company_name: string | null }) =>
      c.company_name ?? `Company ${c.realm_id}`;

    // Steps arrive newest first, so the first one seen per key is the latest.
    let costsAsOf: string | null = null;
    const ledgerByRealm = new Map<string, string>();
    for (const s of (stepRes.data ?? []) as {
      kind: string;
      realm_id: string | null;
      finished_at: string | null;
    }[]) {
      if (!s.finished_at) continue;
      if (s.kind === "job_costs") costsAsOf ??= s.finished_at;
      else if (s.realm_id && !ledgerByRealm.has(s.realm_id)) {
        ledgerByRealm.set(s.realm_id, s.finished_at);
      }
    }
    const ledgerTimes = active.map((c) => ledgerByRealm.get(c.realm_id) ?? null);
    const ledgerAsOf = ledgerTimes.some((t) => t === null)
      ? null
      : (ledgerTimes as string[]).sort()[0] ?? null;

    const problems: string[] = [];

    for (const c of active) {
      if (c.status === "error") {
        problems.push(
          `${nameOf(c)} is not syncing${c.last_sync_error ? ` (${c.last_sync_error})` : ""} — reconnect it in Settings.`,
        );
      }
    }

    const run = runRes.data as { id: string; status: string; started_at: string } | null;
    if (!run || hoursSince(run.started_at) > STALE_AFTER_HOURS) {
      problems.push(
        run
          ? "The nightly QuickBooks sync has not started in over a day — check the Vercel cron and CRON_SECRET."
          : "The nightly QuickBooks sync has never run — check the Vercel cron and CRON_SECRET.",
      );
    } else if (run.status === "failed" || run.status === "partial") {
      const { data: failed, error } = await db
        .from("qb_sync_steps")
        .select("label, error")
        .eq("run_id", run.id)
        .eq("status", "failed")
        .order("position");
      if (error) throw new Error(error.message);
      const steps = (failed ?? []) as { label: string; error: string | null }[];
      problems.push(
        `Last night's sync ${run.status === "failed" ? "failed" : "finished with errors"}: ${
          steps.map((s) => `${s.label}${s.error ? ` (${s.error})` : ""}`).join("; ") ||
          "see Settings"
        }.`,
      );
    }

    if (hoursSince(costsAsOf) > STALE_AFTER_HOURS) {
      problems.push(
        costsAsOf
          ? "Job costs and invoices have not imported successfully in over a day."
          : "Job costs and invoices have not been imported yet.",
      );
    }
    for (const c of active) {
      const at = ledgerByRealm.get(c.realm_id) ?? null;
      if (c.status !== "error" && hoursSince(at) > STALE_AFTER_HOURS) {
        problems.push(
          at
            ? `${nameOf(c)}'s general ledger has not imported successfully in over a day.`
            : `${nameOf(c)}'s general ledger has no recorded import yet.`,
        );
      }
    }

    return {
      timezone: SYNC_TIMEZONE,
      costsAsOf,
      ledgerAsOf,
      costsStale: hoursSince(costsAsOf) > STALE_AFTER_HOURS,
      problems,
    };
  } catch (e) {
    console.error(`Sync health check failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}
