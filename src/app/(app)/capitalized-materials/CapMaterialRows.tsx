"use client";

import { Fragment, useState, useTransition } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { money, shortDate } from "@/lib/format";
import { monthLabel } from "@/lib/financials";
import type { CapLaborPeriodParams } from "@/lib/capitalizedLabor";
import {
  capMaterialAmounts,
  capMaterialDocRef,
  capMaterialKind,
  capMaterialSourceLabel,
  CAP_MATERIAL_BUCKET_LABELS,
  CAP_MATERIAL_KIND_LABELS,
  type CapMaterialBucket,
  type CapMaterialJobRow,
  type CapMaterialKind,
  type CapMaterialLine,
} from "@/lib/capitalizedMaterials";
import { getCapMaterialLines } from "./actions";

const BUCKET_STYLES: Record<CapMaterialBucket, string> = {
  equipment: "bg-amber-50 text-amber-700 border-amber-200",
  internal: "bg-violet-50 text-violet-700 border-violet-200",
};

type LoadState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "loaded"; lines: CapMaterialLine[] };

/**
 * The non-billable jobs, each expanding to its expense lines for the period
 * on screen. Lines load on first expand and are kept; the page re-keys this
 * component per period so a new period never shows another period's lines.
 */
export function CapMaterialRows({
  jobs,
  showCompany,
  period,
}: {
  jobs: CapMaterialJobRow[];
  showCompany: boolean;
  /** The page's period params, passed back to the drill-down read. */
  period: CapLaborPeriodParams;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [lines, setLines] = useState<Record<string, LoadState>>({});
  const [, startTransition] = useTransition();

  // Job + Customer + Type + Transactions + Latest + Expensed + Already
  // capitalized + Awaiting review, plus the optional company column.
  const colSpan = 8 + (showCompany ? 1 : 0);

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
      const res = await getCapMaterialLines(jobId, period);
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
                  className={`inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-[0.7rem] font-medium ${BUCKET_STYLES[j.bucket]}`}
                >
                  {CAP_MATERIAL_BUCKET_LABELS[j.bucket]}
                </span>
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-ink-600">
                {j.txnCount}
              </td>
              <td className="px-4 py-3 text-right whitespace-nowrap text-ink-400">
                {shortDate(j.latestDate)}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-ink-600">
                {money(j.expensed)}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-ink-600">
                {j.capitalized !== 0 ? money(j.capitalized) : "—"}
              </td>
              <td className="px-4 py-3 text-right font-medium tabular-nums text-ink-900">
                {money(j.net)}
              </td>
            </tr>
            {expanded && (
              <tr>
                <td colSpan={colSpan} className="bg-surface/40 px-6 py-4">
                  <ExpenseLines state={lines[j.id]} />
                </td>
              </tr>
            )}
          </Fragment>
        );
      })}
    </>
  );
}

function ExpenseLines({ state }: { state: LoadState | undefined }) {
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
        No expense lines in this period. Run a QuickBooks sync in Settings to
        pull the latest transactions.
      </p>
    );
  }

  // Same split as the page: capitalized lines are cost credited off by an
  // entry that debits a capital asset; everything else is expensed, by kind.
  const byKind: Record<CapMaterialKind, number> = { materials: 0, outsideLabor: 0, other: 0 };
  let expensed = 0;
  let capitalized = 0;
  for (const l of state.lines) {
    const split = capMaterialAmounts(l.treatment, l.amount);
    expensed += split.expensed;
    capitalized += split.capitalized;
    byKind[capMaterialKind(l)] += split.expensed;
  }

  // Lines arrive newest first, so they group by month in order, each header
  // carrying the month's net. Undated lines (rare) fall into their own group
  // at the end.
  const groups: { month: string; lines: CapMaterialLine[] }[] = [];
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
                colSpan={5}
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
                  {capMaterialSourceLabel(l.qb_txn_type)} {capMaterialDocRef(l)}
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
        {(Object.keys(byKind) as CapMaterialKind[])
          .filter((k) => byKind[k] !== 0)
          .map((k) => (
            <p key={k} className="flex justify-between text-ink-400">
              <span className="pl-3">{CAP_MATERIAL_KIND_LABELS[k]}</span>
              <span className="tabular-nums">{money(byKind[k])}</span>
            </p>
          ))}
        <p className="flex justify-between text-ink-600">
          <span>Expensed (net of refunds, vendor credits and reversals)</span>
          <span className="tabular-nums">{money(expensed)}</span>
        </p>
        <p className="flex justify-between text-ink-600">
          <span>Already capitalized (credited off to an asset)</span>
          <span className="tabular-nums">{money(-capitalized)}</span>
        </p>
        <p className="flex justify-between font-semibold text-ink-900">
          <span>Awaiting review (net)</span>
          <span className="tabular-nums">{money(expensed - capitalized)}</span>
        </p>
      </div>
    </div>
  );
}
