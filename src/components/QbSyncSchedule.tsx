import { Card, CardTitle } from "@/components/ui";
import { dateTimeIn } from "@/lib/format";
import type { QbSyncRun, QbSyncStep } from "@/lib/types";

// Read-only view of the nightly sync (migration 0024 + /api/cron/qb-sync).
// Admins need to know the morning sync actually ran without opening Vercel's
// cron logs, so the last run's steps are shown with whatever each imported.

const RUN_STATUS: Record<QbSyncRun["status"], { label: string; cls: string }> = {
  running: { label: "In progress", cls: "text-brand-700" },
  succeeded: { label: "Completed", cls: "text-ok-600" },
  partial: { label: "Completed with errors", cls: "text-amber-600" },
  failed: { label: "Failed", cls: "text-bad-600" },
};

const STEP_STATUS: Record<QbSyncStep["status"], { label: string; cls: string }> = {
  pending: { label: "Queued", cls: "text-ink-400" },
  running: { label: "Running", cls: "text-brand-700" },
  succeeded: { label: "Done", cls: "text-ok-600" },
  failed: { label: "Failed", cls: "text-bad-600" },
};

function count(n: number | undefined, one: string, many = `${one}s`): string | null {
  if (n === undefined) return null;
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

function summarize(step: QbSyncStep): string | null {
  const r = step.result;
  if (!r) return null;
  const parts =
    step.kind === "customers_jobs"
      ? [count(r.customers, "customer"), count(r.jobs, "job")]
      : step.kind === "job_costs"
        ? [count(r.costLines, "cost line"), count(r.invoices, "invoice")]
        : [count(r.glLines, "ledger line"), count(r.glAccounts, "account")];
  const kept = parts.filter(Boolean);
  return kept.length > 0 ? kept.join(" · ") : null;
}

export function QbSyncSchedule({
  run,
  steps,
  timezone,
  hour,
}: {
  run: QbSyncRun | null;
  steps: QbSyncStep[];
  timezone: string;
  hour: number;
}) {
  const scheduleLabel = new Date(Date.UTC(2000, 0, 1, hour)).toLocaleTimeString(
    "en-US",
    { timeZone: "UTC", hour: "numeric", minute: "2-digit" },
  );
  const zoneLabel = timezone.split("/").pop()?.replace(/_/g, " ") ?? timezone;

  return (
    <Card>
      <CardTitle>Automatic sync</CardTitle>
      <p className="text-sm text-ink-600">
        QuickBooks imports run on their own every morning at{" "}
        <span className="font-medium text-ink-900">
          {scheduleLabel} {zoneLabel} time
        </span>
        : customers and jobs, then actual costs and invoices, then the general
        ledger for each connected company. Manual syncs stay available above and
        are never blocked by the scheduled one.
      </p>

      {run ? (
        <div className="mt-4">
          <p className="text-sm text-ink-900">
            Last run{" "}
            <span className={`font-medium ${RUN_STATUS[run.status].cls}`}>
              {RUN_STATUS[run.status].label.toLowerCase()}
            </span>{" "}
            — started {dateTimeIn(run.started_at, timezone)}
            {run.finished_at && `, finished ${dateTimeIn(run.finished_at, timezone)}`}
            {run.trigger === "manual" && " (triggered manually)"}
          </p>
          <ul className="mt-3 divide-y divide-line rounded-lg border border-line bg-surface/50">
            {steps.map((step) => {
              const summary = summarize(step);
              return (
                <li
                  key={step.id}
                  className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-3 py-2 text-sm"
                >
                  <span className="text-ink-900">{step.label}</span>
                  <span className="text-xs text-ink-400">
                    {summary && <span className="mr-2 text-ink-600">{summary}</span>}
                    {step.error && (
                      <span className="mr-2 text-bad-600">{step.error}</span>
                    )}
                    <span className={STEP_STATUS[step.status].cls}>
                      {STEP_STATUS[step.status].label}
                    </span>
                    {step.attempts > 1 && step.status !== "succeeded" && (
                      <span className="ml-1">· attempt {step.attempts}</span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <p className="mt-4 text-sm text-ink-400">
          No scheduled sync has run yet — the first one runs tomorrow morning.
        </p>
      )}
    </Card>
  );
}
