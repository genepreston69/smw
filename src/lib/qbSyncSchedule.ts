import "server-only";

import { createServiceClient } from "@/lib/supabase/service";
import {
  syncCustomersAndJobs,
  syncGeneralLedger,
  syncJobCosts,
} from "@/lib/quickbooks";
import type { QbSyncStep, QbSyncStepKind } from "@/lib/types";

// ---------------------------------------------------------------------------
// Nightly QuickBooks sync — the worker half of migration 0024
//
// A run is a queue of ordered steps (customers/jobs, then costs/invoices, then
// one general-ledger import per connected company). Postgres owns the queue's
// rules; this module decides which steps a run contains, runs one at a time,
// and reports what happened. /api/cron/qb-sync is the only caller.
// ---------------------------------------------------------------------------

/** Timezone the 4 AM schedule is expressed in. */
export const SYNC_TIMEZONE = process.env.QB_SYNC_TIMEZONE?.trim() || "America/New_York";

/** Local hour the run starts at. */
export const SYNC_HOUR = parseHour(process.env.QB_SYNC_HOUR);

/**
 * How many hours after SYNC_HOUR a tick may still *start* the day's run, so a
 * missed 4 AM tick (deployment, QuickBooks outage) is caught up rather than
 * skipped. The one-run-per-local-date index keeps it to a single run.
 */
export const SYNC_START_WINDOW_HOURS = 3;

function parseHour(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : 4;
}

export interface LocalClock {
  /** Calendar date in SYNC_TIMEZONE, `YYYY-MM-DD`. */
  date: string;
  /** Hour of day in SYNC_TIMEZONE, 0–23. */
  hour: number;
}

/**
 * Wall-clock date and hour in the sync's timezone. Vercel cron schedules are
 * UTC-only, so the schedule is a UTC *window* (see vercel.json) and the local
 * hour read here is what actually decides when the run starts — that keeps
 * 4 AM at 4 AM across daylight saving time.
 */
export function localClock(now: Date = new Date(), timeZone = SYNC_TIMEZONE): LocalClock {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
  } catch {
    throw new Error(
      `QB_SYNC_TIMEZONE is not a valid IANA timezone: ${timeZone}`,
    );
  }
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
  };
}

/** True when a tick at this local hour should open the day's run. */
export function isWithinStartWindow(hour: number): boolean {
  return hour >= SYNC_HOUR && hour < SYNC_HOUR + SYNC_START_WINDOW_HOURS;
}

interface StepPlan {
  kind: QbSyncStepKind;
  realm_id: string | null;
  label: string;
}

/**
 * The steps a nightly run consists of. Split the way the manual sync buttons
 * are split — entity import in one step, then the general ledger one company
 * per step — because a single invocation can't hold all of it (see
 * src/app/api/qb/sync-ledger/route.ts).
 */
export async function planSteps(): Promise<StepPlan[]> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("qb_connections")
    .select("realm_id, company_name")
    .eq("status", "connected")
    .order("created_at");
  if (error) throw new Error(error.message);

  const companies = data ?? [];
  if (companies.length === 0) return [];

  return [
    { kind: "customers_jobs", realm_id: null, label: "Customers & jobs" },
    { kind: "job_costs", realm_id: null, label: "Actual costs & invoices" },
    ...companies.map((c) => ({
      kind: "general_ledger" as const,
      realm_id: c.realm_id,
      label: `General ledger — ${c.company_name ?? `Company ${c.realm_id}`}`,
    })),
  ];
}

/** Creates today's scheduled run, or returns null if it already exists. */
export async function beginScheduledRun(
  clock: LocalClock,
  steps: StepPlan[],
): Promise<string | null> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("begin_qb_sync_run", {
    p_local_date: clock.date,
    p_timezone: SYNC_TIMEZONE,
    p_steps: steps,
    p_trigger: "scheduled",
  });
  if (error) throw new Error(error.message);
  return (data as string | null) ?? null;
}

async function claimStep(): Promise<QbSyncStep | null> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("claim_qb_sync_step", {});
  if (error) throw new Error(error.message);
  return (data as QbSyncStep | null) ?? null;
}

async function finishStep(
  stepId: string,
  ok: boolean,
  result: Record<string, number> | null,
  errorMessage: string | null,
): Promise<QbSyncStep | null> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("finish_qb_sync_step", {
    p_step_id: stepId,
    p_ok: ok,
    p_result: result,
    p_error: errorMessage,
  });
  if (error) throw new Error(error.message);
  return (data as QbSyncStep | null) ?? null;
}

async function executeStep(step: QbSyncStep): Promise<Record<string, number>> {
  switch (step.kind) {
    case "customers_jobs": {
      const r = await syncCustomersAndJobs();
      return {
        customers: r.customers,
        jobs: r.jobs,
        companies: r.companies,
        dbCustomers: r.dbCustomers,
        dbJobs: r.dbJobs,
      };
    }
    case "job_costs": {
      const r = await syncJobCosts();
      return { costLines: r.costLines, invoices: r.invoices, companies: r.companies };
    }
    case "general_ledger": {
      if (!step.realm_id) throw new Error("General-ledger step has no realm");
      const r = await syncGeneralLedger(step.realm_id);
      return { glAccounts: r.accounts, glLines: r.glLines };
    }
  }
}

export interface StepOutcome {
  kind: QbSyncStepKind;
  label: string;
  ok: boolean;
  ms: number;
  result?: Record<string, number>;
  error?: string;
  /** True once the step has burned its retries and won't be attempted again. */
  giveUp?: boolean;
}

export interface DrainSummary {
  executed: StepOutcome[];
  /** Steps still pending or running after this invocation gave up its slot. */
  remaining: number;
  /** Set when the invocation stopped claiming to stay inside its window. */
  outOfTime: boolean;
}

/**
 * Runs queued steps until the invocation is close enough to its own deadline
 * that another step probably wouldn't finish. Whatever is left is picked up by
 * the next cron tick — a step can take most of a 300s window on its own, so
 * one invocation deliberately doesn't try to drain the whole run.
 */
export async function drainSteps(opts: {
  startedAt: number;
  /** Stop claiming new steps once this much of the window has been used. */
  claimUntilMs: number;
}): Promise<DrainSummary> {
  const executed: StepOutcome[] = [];
  let outOfTime = false;

  for (;;) {
    if (Date.now() - opts.startedAt >= opts.claimUntilMs) {
      outOfTime = true;
      break;
    }
    const step = await claimStep();
    if (!step) break;

    const startedAt = Date.now();
    try {
      const result = await executeStep(step);
      await finishStep(step.id, true, result, null);
      executed.push({
        kind: step.kind,
        label: step.label,
        ok: true,
        ms: Date.now() - startedAt,
        result,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Sync step failed";
      const finished = await finishStep(step.id, false, null, message);
      executed.push({
        kind: step.kind,
        label: step.label,
        ok: false,
        ms: Date.now() - startedAt,
        error: message,
        giveUp: finished?.status === "failed",
      });
    }
  }

  return { executed, remaining: await countOpenSteps(), outOfTime };
}

async function countOpenSteps(): Promise<number> {
  const supabase = createServiceClient();
  const { count, error } = await supabase
    .from("qb_sync_steps")
    .select("id", { count: "exact", head: true })
    .in("status", ["pending", "running"]);
  if (error) throw new Error(error.message);
  return count ?? 0;
}
