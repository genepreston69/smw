"use client";

import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { money } from "@/lib/format";
import type { CustomerSummaryRow } from "@/lib/customerSummary";

export function SummaryRows({
  rows,
  showCompany,
}: {
  rows: CustomerSummaryRow[];
  showCompany: boolean;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());

  // Customer + Intercompany + Jobs + Materials + Direct labor + Contract
  // services + Actual cost + Invoiced + Net, plus the optional QB Company
  // column.
  const colSpan = 9 + (showCompany ? 1 : 0);

  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <>
      {rows.map((r) => {
        const expanded = open.has(r.key);
        return (
          <Fragment key={r.key}>
            <tr className="transition-colors hover:bg-surface/60">
              <td className="px-4 py-3 font-medium text-ink-900">
                <button
                  onClick={() => toggle(r.key)}
                  className="flex items-center gap-1.5 text-left font-medium text-ink-900 hover:text-brand-700"
                  title={expanded ? "Hide jobs" : "List jobs"}
                >
                  {expanded ? (
                    <ChevronDown
                      size={14}
                      strokeWidth={2}
                      className="shrink-0 text-ink-400"
                    />
                  ) : (
                    <ChevronRight
                      size={14}
                      strokeWidth={2}
                      className="shrink-0 text-ink-400"
                    />
                  )}
                  {r.name}
                </button>
              </td>
              {showCompany && (
                <td className="px-4 py-3 text-ink-600">
                  {r.companyName ?? "—"}
                </td>
              )}
              <td className="px-4 py-3 text-ink-600">
                {r.intercompany ? "Yes" : "No"}
              </td>
              <td className="px-4 py-3 text-right tabular-nums">{r.jobs}</td>
              <td className="px-4 py-3 text-right tabular-nums">
                {money(r.materials)}
              </td>
              <td className="px-4 py-3 text-right tabular-nums">
                {money(r.labor)}
              </td>
              <td className="px-4 py-3 text-right tabular-nums">
                {money(r.other)}
              </td>
              <td className="px-4 py-3 text-right tabular-nums">
                {money(r.cost)}
              </td>
              <td className="px-4 py-3 text-right tabular-nums">
                {money(r.invoiced)}
              </td>
              <td
                className={`px-4 py-3 text-right tabular-nums ${
                  r.net < 0 ? "text-bad-600" : ""
                }`}
              >
                {money(r.net)}
              </td>
            </tr>
            {expanded && (
              <tr>
                <td colSpan={colSpan} className="bg-surface/40 px-6 py-4">
                  <JobList row={r} />
                </td>
              </tr>
            )}
          </Fragment>
        );
      })}
    </>
  );
}

function JobList({ row }: { row: CustomerSummaryRow }) {
  return (
    <div>
      <h3 className="mb-1 text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
        Jobs ({row.jobList.length})
      </h3>
      <table className="w-full text-[0.8rem]">
        <thead className="text-left text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
          <tr>
            <th className="py-1.5 pr-3 font-semibold">Job</th>
            <th className="w-28 py-1.5 pr-3 text-right font-semibold">
              Materials
            </th>
            <th className="w-28 py-1.5 pr-3 text-right font-semibold">
              Direct labor
            </th>
            <th className="w-32 py-1.5 pr-3 text-right font-semibold">
              Contract services
            </th>
            <th className="w-28 py-1.5 pr-3 text-right font-semibold">
              Actual cost
            </th>
            <th className="w-28 py-1.5 pr-3 text-right font-semibold">
              Invoiced
            </th>
            <th className="w-28 py-1.5 text-right font-semibold">Net</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line/50">
          {row.jobList.map((j) => {
            const net =
              j.cost != null || j.invoiced != null
                ? (j.invoiced ?? 0) - (j.cost ?? 0)
                : null;
            return (
              <tr key={j.id}>
                <td className="py-1.5 pr-3 text-ink-900">{j.name}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums text-ink-600">
                  {j.materials != null ? money(j.materials) : "—"}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums text-ink-600">
                  {j.labor != null ? money(j.labor) : "—"}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums text-ink-600">
                  {j.contractServices != null ? money(j.contractServices) : "—"}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums text-ink-600">
                  {j.cost != null ? money(j.cost) : "—"}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums text-ink-600">
                  {j.invoiced != null ? money(j.invoiced) : "—"}
                </td>
                <td
                  className={`py-1.5 text-right tabular-nums ${
                    net != null && net < 0 ? "text-bad-600" : "text-ink-900"
                  }`}
                >
                  {net != null ? money(net) : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t border-line font-semibold text-ink-900">
            <td className="py-1.5 pr-3">Total</td>
            <td className="py-1.5 pr-3 text-right tabular-nums">
              {money(row.materials)}
            </td>
            <td className="py-1.5 pr-3 text-right tabular-nums">
              {money(row.labor)}
            </td>
            <td className="py-1.5 pr-3 text-right tabular-nums">
              {money(row.other)}
            </td>
            <td className="py-1.5 pr-3 text-right tabular-nums">
              {money(row.cost)}
            </td>
            <td className="py-1.5 pr-3 text-right tabular-nums">
              {money(row.invoiced)}
            </td>
            <td
              className={`py-1.5 text-right tabular-nums ${
                row.net < 0 ? "text-bad-600" : ""
              }`}
            >
              {money(row.net)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
