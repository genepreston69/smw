import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import {
  SYNC_HOUR,
  SYNC_TIMEZONE,
  beginScheduledRun,
  drainSteps,
  isWithinStartWindow,
  localClock,
  planSteps,
} from "@/lib/qbSyncSchedule";

// The nightly QuickBooks sync worker.
//
// vercel.json points a cron at this route every 15 minutes across a UTC window
// that covers 4 AM in SYNC_TIMEZONE under both standard and daylight time. The
// first tick at or after the local sync hour creates the day's run (Postgres
// enforces one per local date); that tick and the ones after it drain the
// queued steps, one step at a time. So the schedule is "4 AM local", and the
// extra ticks are just workers finishing what the 4 AM tick couldn't.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

// Stop claiming new steps this far into the window: a single step (a big
// company's general ledger) can take most of a 300s invocation, so starting
// one late just gets it killed and retried. The next tick takes over.
const CLAIM_UNTIL_MS = 90_000;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  if (header.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

async function handle(request: Request) {
  const startedAt = Date.now();

  if (!process.env.CRON_SECRET) {
    return NextResponse.json(
      { error: "Scheduled sync is not configured: CRON_SECRET is unset" },
      { status: 503 },
    );
  }
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const clock = localClock();
    let runId: string | null = null;
    let startedRun = false;

    if (isWithinStartWindow(clock.hour)) {
      const steps = await planSteps();
      if (steps.length === 0) {
        // Nothing is connected to QuickBooks — don't record an empty run.
        return NextResponse.json({
          ok: true,
          skipped: "QuickBooks is not connected",
          timezone: SYNC_TIMEZONE,
          localDate: clock.date,
          localHour: clock.hour,
        });
      }
      runId = await beginScheduledRun(clock, steps);
      startedRun = runId !== null;
    }

    // Always drain, whether or not this tick opened the run: that is how the
    // work started at 4 AM gets finished, and how a step stranded by a
    // timeout gets retried.
    const summary = await drainSteps({ startedAt, claimUntilMs: CLAIM_UNTIL_MS });

    return NextResponse.json({
      ok: true,
      timezone: SYNC_TIMEZONE,
      localDate: clock.date,
      localHour: clock.hour,
      syncHour: SYNC_HOUR,
      startedRun,
      runId,
      ...summary,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Scheduled sync failed" },
      { status: 500 },
    );
  }
}

// Vercel cron sends GET; POST is here so the same endpoint can be driven by an
// external scheduler holding CRON_SECRET.
export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
