"use client";

import { Fragment, useState, useTransition } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { hours as fmtHours, money, shortDate } from "@/lib/format";
import { DeleteRowButton } from "@/components/DeleteRowButton";
import { deleteJob, getJobCosts, type JobCostLine } from "./actions";

export interface JobRowData {
  id: string;
  name: string;
  companyName: string | null;
  customerName: string | null;
  active: boolean;
  lastSyncedAt: string | null;
  /** null when the job has no imported cost lines. */
  totalCost: number | null;
  /** null when the job has no imported invoices. */
  invoiced: number | null;
  /** Date of the most recent imported cost line or invoice, if any. */
  latestTxnDate: string | null;
}

const COST_SECTIONS = [
  { type: "materials", label: "Materials" },
  { type: "labor", label: "Direct labor" },
  { type: "other", label: "Other direct costs" },
] as const;

type LoadState = { status: "loading" } | { status: "error"; error: string } | {
  status: "loaded";
  lines: JobCostLine[];
};

export function JobRows({
  jobs,
  showCompany,
  isAdmin,
}: {
  jobs: JobRowData[];
  showCompany: boolean;
  isAdmin: boolean;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [costs, setCosts] = useState<Record<string, LoadState>>({});
  const [, startTransition] = useTransition();

  // Job + Customer + Actual cost + Invoiced + Latest transaction + Active +
  // Last synced, plus optional columns.
  const colSpan = 7 + (showCompany ? 1 : 0) + (isAdmin ? 1 : 0);

  const toggle = (jobId: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
    if (costs[jobId]) return; // already loaded (or loading)
    setCosts((prev) => ({ ...prev, [jobId]: { status: "loading" } }));
    startTransition(async () => {
      const res = await getJobCosts(jobId);
      setCosts((prev) => ({
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
                    expanded ? "Hide transactions" : "View transaction history"
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
              <td className="px-4 py-3 text-right tabular-nums">
                {j.totalCost != null ? money(j.totalCost) : "—"}
              </td>
              <td className="px-4 py-3 text-right tabular-nums">
                {j.invoiced != null ? money(j.invoiced) : "—"}
              </td>
              <td className="px-4 py-3 text-right text-ink-400">
                {shortDate(j.latestTxnDate)}
              </td>
              <td className="px-4 py-3 text-ink-600">{j.active ? "Yes" : "No"}</td>
              <td className="px-4 py-3 text-right text-ink-400">
                {shortDate(j.lastSyncedAt)}
              </td>
              {isAdmin && (
                <td className="px-4 py-3 text-right">
                  <DeleteRowButton
                    action={() => deleteJob(j.id)}
                    confirmText={`Delete job "${j.name}"? This only removes the local record — the job stays in QuickBooks and will re-import on the next sync.`}
                    title="Delete job"
                  />
                </td>
              )}
            </tr>
            {expanded && (
              <tr>
                <td colSpan={colSpan} className="bg-surface/40 px-6 py-4">
                  <TransactionHistory state={costs[j.id]} />
                </td>
              </tr>
            )}
          </Fragment>
        );
      })}
    </>
  );
}

function TransactionHistory({ state }: { state: LoadState | undefined }) {
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
        No transactions since Jan 1, 2023. Run a QuickBooks sync in Settings to
        pull the latest costs.
      </p>
    );
  }

  const total = state.lines.reduce((s, l) => s + l.amount, 0);
  return (
    <div className="space-y-4">
      {COST_SECTIONS.map(({ type, label }) => (
        <CostSection
          key={type}
          label={label}
          lines={state.lines.filter((l) => l.cost_type === type)}
        />
      ))}
      <p className="flex justify-between border-t border-line pt-2 text-sm font-semibold text-ink-900">
        <span>Total direct cost</span>
        <span className="tabular-nums">{money(total)}</span>
      </p>
    </div>
  );
}

function CostSection({ label, lines }: { label: string; lines: JobCostLine[] }) {
  const subtotal = lines.reduce((s, l) => s + l.amount, 0);
  const totalHours = lines.reduce((s, l) => s + (l.hours ?? 0), 0);
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <h3 className="text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
          {label} ({lines.length})
        </h3>
        <span className="text-sm font-medium tabular-nums text-ink-900">
          {totalHours > 0 && (
            <span className="mr-3 font-normal text-ink-400">
              {fmtHours(totalHours)}
            </span>
          )}
          {money(subtotal)}
        </span>
      </div>
      {lines.length === 0 && (
        <p className="py-1 text-[0.8rem] text-ink-400">No transactions.</p>
      )}
      <table className="w-full text-[0.8rem]">
        <tbody className="divide-y divide-line/50">
          {lines.map((l) => (
            <tr key={l.id}>
              <td className="w-24 py-1.5 pr-3 whitespace-nowrap text-ink-400">
                {shortDate(l.txn_date)}
              </td>
              <td className="w-20 py-1.5 pr-3 text-ink-400">
                {l.qb_txn_type === "TimeActivity"
                  ? "Time"
                  : l.qb_txn_type === "JournalEntry"
                    ? "Journal"
                    : l.qb_txn_type}
              </td>
              <td className="py-1.5 pr-3 text-ink-900">
                {l.vendor_name ?? "—"}
              </td>
              <td className="py-1.5 pr-3 text-ink-600">
                {l.description ?? l.category ?? "—"}
                {l.description && l.category && (
                  <span className="text-ink-400"> · {l.category}</span>
                )}
              </td>
              <td className="w-20 py-1.5 pr-3 text-right tabular-nums text-ink-400">
                {l.hours != null ? fmtHours(l.hours) : ""}
              </td>
              <td className="w-24 py-1.5 text-right tabular-nums text-ink-900">
                {money(l.amount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
