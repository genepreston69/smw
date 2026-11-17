import "server-only";

import type { StepOutcome } from "@/lib/qbSyncSchedule";

/**
 * Tells someone the nightly sync gave up on a step, without waiting for them
 * to open the app (where the layout banner shows the same thing).
 *
 * Optional: set QB_SYNC_ALERT_WEBHOOK_URL to an incoming-webhook URL that
 * accepts `{ "text": "…" }` as JSON — Slack and Microsoft Teams webhooks both
 * do. Unset, this only logs. A failed alert never fails the sync.
 */
export async function alertSyncFailures(failed: StepOutcome[]): Promise<void> {
  if (failed.length === 0) return;
  const text = `SMW Job Plans: the nightly QuickBooks sync failed on ${failed.length} ${
    failed.length === 1 ? "step" : "steps"
  } and will not retry today.\n${failed
    .map((s) => `• ${s.label}: ${s.error ?? "failed"}`)
    .join("\n")}`;
  console.error(text);

  const url = process.env.QB_SYNC_ALERT_WEBHOOK_URL?.trim();
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error(`Sync alert webhook returned ${res.status}`);
  } catch (e) {
    console.error(`Sync alert webhook failed: ${e instanceof Error ? e.message : e}`);
  }
}
