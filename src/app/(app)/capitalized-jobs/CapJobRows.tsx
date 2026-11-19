"use client";

import { Fragment, useState, useTransition } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { money, shortDate } from "@/lib/format";
import { monthLabel } from "@/lib/financials";
import {
  CAP_LABOR_BUCKET_LABELS,
  type CapLaborBucket,
  type CapLaborPeriodParams,
} from "@/lib/capitalizedLabor";
import {
  addCapJobLine,
  blankCapJobSums,
  capJobDocRef,
  capJobSourceLabel,
  CAP_JOB_KINDS,
  CAP_JOB_KIND_LABELS,
  type CapJobLine,
  type CapJobRow,
} from "@/lib/capitalizedJobs";
import { getCapJobLines } from "./actions";

const BUCKET_STYLES: Record<CapLaborBucket, string> = {
  nonbillable: "bg-amber-50 text-amber-700 border-amber-200",
  intercompany: "bg-blue-50 text-blue-700 border-blue-200",
};

type LoadState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "loaded"; lines: CapJobLine[] };

/**
 * The candidate jobs, each expanding to its counted lines for the period on
 * screen. Lines load on first expand and are kept; the page re-keys this
 * component per period so a new period never shows another period's lines.
 */
export function CapJobRows({
  jobs,
  showCompany,
  period,
}: {
  jobs: CapJobRow[];
  showCompany: boolean;
  /** The page's period params, passed back to the drill-down read. */
  period: CapLaborPeriodParams;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [lines, setLines] = useState<Record<string, LoadState>>({});
  const [, startTransition] = useTransition();

  // Job + Customer + Type + Transactions + Latest + one per Direct Cost
  // column + Total cost + Already capitalized + Awaiting review + Benefit
  // allocation, plus the optional company column.
  const colSpan = 9 + CAP_JOB_KINDS.length + (showCompany ? 1 : 0);

  const toggle = (jobId: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
    if (lines[jobId]) return; // already loaded (or loading)
    setLines((prev) => ({ ...prev, [jobId]: { status: "loading" } }));
    startTransition(async () => {
      const res = await getCapJobLines(jobId, period);
      setLines((prev) => ({
        ...prev,
        [jobId]: res.ok
          ? { status: "loaded", lines: res.lines }
          : { status: "error", error: res.error },
      }));
    });
  };

  return (
    <>
      {jobs.map((j) => {
        const expanded = open.has(j.id);
        return (
          <Fragment key={j.id}>
            <tr className="transition-colors hover:bg-surface/60">
              <td className="px-4 py-3 font-medium text-ink-900">
                <button
                  onClick={() => toggle(j.id)}
                  className="flex items-center gap-1.5 text-left font-medium text-ink-900 hover:text-brand-700"
                  title={expanded ? "Hide transactions" : "View transactions"}
                >
                  {expanded ? (
                    <ChevronDown size={14} strokeWidth={2} className="shrink-0 text-ink-400" />
                  ) : (
                    <ChevronRight size={14} strokeWidth={2} className="shrink-0 text-ink-400" />
                  )}
                  {j.name}
                </button>
              </td>
              {showCompany && (
                <td className="px-4 py-3 text-ink-600">{j.companyName ?? "—"}</td>
              )}
              <td className="px-4 py-3 text-ink-600">{j.customerName ?? "—"}</td>
              <td className="px-4 py-3">
                <span
                  className={`inline-block rounded-full border px-2 py-0.5 text-[0.7rem] font-medium ${BUCKET_STYLES[j.bucket]}`}
                >
                  {CAP_LABOR_BUCKET_LABELS[j.bucket]}
                </span>
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-ink-600">
                {j.txnCount}
              </td>
              <td className="px-4 py-3 text-right text-ink-400">
                {shortDate(j.latestDate)}
              </td>
              {CAP_JOB_KINDS.map((k) => (
                <td key={k} className="px-4 py-3 text-right tabular-nums text-ink-600">
                  {j[k] !== 0 ? money(j[k]) : "—"}
                </td>
              ))}
              <td className="px-4 py-3 text-right tabular-nums text-ink-900">
                {money(j.posted)}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-ink-600">
                {j.capitalized !== 0 ? money(j.capitalized) : "—"}
              </td>
              <td className="px-4 py-3 text-right font-medium tabular-nums text-ink-900">
                {money(j.net)}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-ink-600">
                {j.benefitAllocation != null ? money(j.benefitAllocation) : "—"}
              </td>
            </tr>
            {expanded && (
              <tr>
                <td colSpan={colSpan} className="bg-surface/40 px-6 py-4">
                  <JobLines state={lines[j.id]} />
                </td>
              </tr>
            )}
          </Fragment>
        );
      })}
    </>
  );
}

function JobLines({ state }: { state: LoadState | undefined }) {
  if (!state || state.status === "loading") {
    return (
      <p className="flex items-center gap-2 py-2 text-sm text-ink-400">
        <Loader2 size={14} className="animate-spin" />
        Loading transactions…
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <p className="py-2 text-sm text-bad-600">
        Couldn&apos;t load transactions: {state.error}
      </p>
    );
  }
  if (state.lines.length === 0) {
    return (
      <p className="py-2 text-sm text-ink-600">
        No direct-cost lines in this period. Run a QuickBooks sync in Settings
        to pull the latest transactions.
      </p>
    );
  }

  // Same split as the page: capitalized lines are cost credited off by an
  // entry that debits a capital asset; everything else is cost posted, in
  // its Direct Cost column.
  const sums = blankCapJobSums();
  for (const l of state.lines) addCapJobLine(sums, l);

  // Lines arrive newest first, so they group by month in order, each header
  // carrying the month's net. Undated lines (rare) fall into their own group
  // at the end.
  const groups: { month: string; lines: CapJobLine[] }[] = [];
  for (const l of state.lines) {
    const month = l.txn_date ? l.txn_date.slice(0, 7) : "Undated";
    const last = groups[groups.length - 1];
    if (last && last.month === month) last.lines.push(l);
    else groups.push({ month, lines: [l] });
  }

  return (
    <div>
      <table className="w-full text-[0.8rem]">
        {groups.map((g) => (
          <tbody key={g.month} className="divide-y divide-line/50">
            <tr>
              <td
                colSpan={6}
                className="pt-3 pb-1 text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-ink-400"
              >
                {g.month === "Undated" ? g.month : monthLabel(g.month)}
              </td>
              <td className="pt-3 pb-1 text-right text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-ink-400 tabular-nums">
                {money(g.lines.reduce((s, l) => s + l.amount, 0))}
              </td>
            </tr>
            {g.lines.map((l) => (
              <tr key={l.id}>
                <td className="w-24 py-1.5 pr-3 whitespace-nowrap text-ink-400">
                  {shortDate(l.txn_date)}
                </td>
                <td className="w-36 py-1.5 pr-3 whitespace-nowrap text-ink-400">
                  {capJobSourceLabel(l.qb_txn_type)} {capJobDocRef(l)}
                </td>
                <td className="w-32 py-1.5 pr-3 whitespace-nowrap text-ink-600">
                  {CAP_JOB_KIND_LABELS[l.kind]}
                </td>
                <td className="py-1.5 pr-3 text-ink-900">{l.vendor_name ?? "—"}</td>
                <td className="py-1.5 pr-3 text-ink-900">
                  {l.category ?? "—"}
                  {l.treatment === "capitalized" && (
                    <span className="ml-2 inline-block rounded-full border border-ok-600/25 bg-ok-50 px-1.5 py-px text-[0.65rem] font-medium text-ok-600">
                      Capitalized
                    </span>
                  )}
                </td>
                <td className="py-1.5 pr-3 text-ink-600">{l.description ?? "—"}</td>
                <td
                  className={`w-24 py-1.5 text-right tabular-nums ${
                    l.amount < 0 ? "text-ok-600" : "text-ink-900"
                  }`}
                >
                  {money(l.amount)}
                </td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
      <div className="mt-2 space-y-1 border-t border-line pt-2 text-sm">
        {CAP_JOB_KINDS.filter((k) => sums[k] !== 0).map((k) => (
          <p key={k} className="flex justify-between text-ink-400">
            <span className="pl-3">{CAP_JOB_KIND_LABELS[k]}</span>
            <span className="tabular-nums">{money(sums[k])}</span>
          </p>
        ))}
        <p className="flex justify-between text-ink-600">
          <span>Total cost posted (net of refunds, credits and reversals)</span>
          <span className="tabular-nums">{money(sums.posted)}</span>
        </p>
        <p className="flex justify-between text-ink-600">
          <span>Already capitalized (credited off to an asset)</span>
          <span className="tabular-nums">{money(-sums.capitalized)}</span>
        </p>
        <p className="flex justify-between font-semibold text-ink-900">
          <span>Awaiting review (net)</span>
          <span className="tabular-nums">{money(sums.net)}</span>
        </p>
      </div>
    </div>
  );
}
