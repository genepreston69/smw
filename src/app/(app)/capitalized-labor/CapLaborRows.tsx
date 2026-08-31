"use client";

import { Fragment, useState, useTransition } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { money, shortDate } from "@/lib/format";
import {
  CAP_LABOR_BUCKET_LABELS,
  type CapLaborBucket,
} from "@/lib/capitalizedLabor";
import { getCapLaborLines, type CapLaborLine } from "./actions";

export interface CapLaborRowData {
  id: string;
  name: string;
  companyName: string | null;
  customerName: string | null;
  bucket: CapLaborBucket;
  /**
   * Period sums of the job's journal labor lines: debits posted to labor
   * accounts, credits against them (already capitalized/reversed, stored
   * positive), and their net. All null when the job has no journal labor
   * activity in the selected period.
   */
  grossAmount: number | null;
  capitalizedAmount: number | null;
  amount: number | null;
  /** Direct-labor share of Employee Benefits allocated to this job in the
      selected period (same figure as the Jobs dashboard column); null when
      nothing was allocated. */
  benefitAllocation: number | null;
  entryCount: number;
  latestDate: string | null;
}

const BUCKET_STYLES: Record<CapLaborBucket, string> = {
  nonbillable: "bg-amber-50 text-amber-700 border-amber-200",
  intercompany: "bg-blue-50 text-blue-700 border-blue-200",
};

type LoadState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "loaded"; lines: CapLaborLine[] };

export function CapLaborRows({
  jobs,
  showCompany,
}: {
  jobs: CapLaborRowData[];
  showCompany: boolean;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [lines, setLines] = useState<Record<string, LoadState>>({});
  const [, startTransition] = useTransition();

  // Job + Customer + Type + Entries + Latest entry + Labor posted +
  // Already capitalized + Awaiting review + Benefit allocation, plus the
  // optional company column.
  const colSpan = 9 + (showCompany ? 1 : 0);

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
      const res = await getCapLaborLines(jobId);
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
                  title={
                    expanded ? "Hide journal entries" : "View journal entries"
                  }
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
                {j.entryCount}
              </td>
              <td className="px-4 py-3 text-right text-ink-400">
                {shortDate(j.latestDate)}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-ink-600">
                {j.grossAmount != null ? money(j.grossAmount) : "—"}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-ink-600">
                {j.capitalizedAmount != null && j.capitalizedAmount !== 0
                  ? money(j.capitalizedAmount)
                  : "—"}
              </td>
              <td className="px-4 py-3 text-right font-medium tabular-nums text-ink-900">
                {j.amount != null ? money(j.amount) : "—"}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-ink-600">
                {j.benefitAllocation != null ? money(j.benefitAllocation) : "—"}
              </td>
            </tr>
            {expanded && (
              <tr>
                <td colSpan={colSpan} className="bg-surface/40 px-6 py-4">
                  <JournalLines state={lines[j.id]} />
                </td>
              </tr>
            )}
          </Fragment>
        );
      })}
    </>
  );
}

function JournalLines({ state }: { state: LoadState | undefined }) {
  if (!state || state.status === "loading") {
    return (
      <p className="flex items-center gap-2 py-2 text-sm text-ink-400">
        <Loader2 size={14} className="animate-spin" />
        Loading journal entries…
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <p className="py-2 text-sm text-bad-600">
        Couldn&apos;t load journal entries: {state.error}
      </p>
    );
  }
  if (state.lines.length === 0) {
    return (
      <p className="py-2 text-sm text-ink-600">
        No journal-entry labor lines. Run a QuickBooks sync in Settings to pull
        the latest transactions.
      </p>
    );
  }

  // Credits (negative lines) are labor already moved off the job's labor
  // accounts — the trace a capitalization entry leaves when its credit line
  // is tagged to the job.
  const debits = state.lines.reduce((s, l) => s + Math.max(l.amount, 0), 0);
  const credits = state.lines.reduce((s, l) => s + Math.min(l.amount, 0), 0);
  const total = debits + credits;

  // Lines arrive newest first; grouping them by calendar year with a net
  // subtotal per year matches how the dashboard splits the totals. Undated
  // lines (rare) fall into their own group at the end.
  const groups: { year: string; lines: CapLaborLine[] }[] = [];
  for (const l of state.lines) {
    const year = l.txn_date ? l.txn_date.slice(0, 4) : "Undated";
    const last = groups[groups.length - 1];
    if (last && last.year === year) last.lines.push(l);
    else groups.push({ year, lines: [l] });
  }

  return (
    <div>
      <table className="w-full text-[0.8rem]">
        {groups.map((g) => {
          const groupNet = g.lines.reduce((s, l) => s + l.amount, 0);
          return (
            <tbody key={g.year} className="divide-y divide-line/50">
              <tr>
                <td
                  colSpan={4}
                  className="pt-3 pb-1 text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-ink-400"
                >
                  {g.year}
                </td>
                <td className="pt-3 pb-1 text-right text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-ink-400 tabular-nums">
                  {money(groupNet)}
                </td>
              </tr>
              {g.lines.map((l) => (
                <tr key={l.id}>
                  <td className="w-24 py-1.5 pr-3 whitespace-nowrap text-ink-400">
                    {shortDate(l.txn_date)}
                  </td>
                  <td className="w-28 py-1.5 pr-3 whitespace-nowrap text-ink-400">
                    JE {l.qb_doc_number ?? `#${l.qb_txn_id}`}
                  </td>
                  <td className="py-1.5 pr-3 text-ink-900">
                    {l.category ?? "—"}
                  </td>
                  <td className="py-1.5 pr-3 text-ink-600">
                    {l.description ?? "—"}
                  </td>
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
          );
        })}
      </table>
      <div className="mt-2 space-y-1 border-t border-line pt-2 text-sm">
        <p className="flex justify-between text-ink-600">
          <span>Labor posted (debits)</span>
          <span className="tabular-nums">{money(debits)}</span>
        </p>
        <p className="flex justify-between text-ink-600">
          <span>Already capitalized / reversed (credits)</span>
          <span className="tabular-nums">{money(credits)}</span>
        </p>
        <p className="flex justify-between font-semibold text-ink-900">
          <span>Awaiting review (net)</span>
          <span className="tabular-nums">{money(total)}</span>
        </p>
      </div>
    </div>
  );
}
