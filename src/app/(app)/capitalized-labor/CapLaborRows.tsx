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
  /** null when the job has no journal labor activity in the selected period. */
  amount: number | null;
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

  // Job + Customer + Type + Entries + Latest entry + Capitalized labor,
  // plus the optional company column.
  const colSpan = 6 + (showCompany ? 1 : 0);

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
              <td className="px-4 py-3 text-right font-medium tabular-nums text-ink-900">
                {j.amount != null ? money(j.amount) : "—"}
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

  const total = state.lines.reduce((s, l) => s + l.amount, 0);
  return (
    <div>
      <table className="w-full text-[0.8rem]">
        <tbody className="divide-y divide-line/50">
          {state.lines.map((l) => (
            <tr key={l.id}>
              <td className="w-24 py-1.5 pr-3 whitespace-nowrap text-ink-400">
                {shortDate(l.txn_date)}
              </td>
              <td className="w-28 py-1.5 pr-3 whitespace-nowrap text-ink-400">
                JE {l.qb_doc_number ?? `#${l.qb_txn_id}`}
              </td>
              <td className="py-1.5 pr-3 text-ink-900">{l.category ?? "—"}</td>
              <td className="py-1.5 pr-3 text-ink-600">
                {l.description ?? "—"}
              </td>
              <td className="w-24 py-1.5 text-right tabular-nums text-ink-900">
                {money(l.amount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 flex justify-between border-t border-line pt-2 text-sm font-semibold text-ink-900">
        <span>Total journal-entry labor</span>
        <span className="tabular-nums">{money(total)}</span>
      </p>
    </div>
  );
}
