"use client";

import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { money, shortDate } from "@/lib/format";
import {
  CAP_LINE_KIND_LABELS,
  capLineSide,
  type CapEntry,
} from "@/lib/alreadyCapitalized";

const KIND_STYLES = {
  asset: "bg-blue-50 text-blue-700 border-blue-200",
  labor: "bg-amber-50 text-amber-700 border-amber-200",
  other: "bg-surface text-ink-600 border-line",
} as const;

/**
 * The capitalization entries, one row each, expanding to every ledger line
 * of the entry (asset debits, labor credits, anything else it touched).
 * Everything arrives with the page — no extra fetch on expand.
 */
export function EntryRows({
  entries,
  companyName,
  showCompany,
}: {
  entries: CapEntry[];
  companyName: Record<string, string>;
  showCompany: boolean;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  // Date + Journal entry + Asset + Job + Labor capitalized + Memo, plus the
  // optional company column.
  const colSpan = 6 + (showCompany ? 1 : 0);

  return (
    <>
      {entries.map((e) => {
        const expanded = open.has(e.key);
        return (
          <Fragment key={e.key}>
            <tr className="align-top transition-colors hover:bg-surface/60">
              <td className="whitespace-nowrap px-4 py-3 text-ink-600">{shortDate(e.date)}</td>
              <td className="whitespace-nowrap px-4 py-3">
                <button
                  type="button"
                  onClick={() => toggle(e.key)}
                  className="flex items-center gap-1.5 font-medium text-ink-900 hover:text-brand-700"
                  title={expanded ? "Hide the entry's lines" : "Show every line of the entry"}
                >
                  {expanded ? (
                    <ChevronDown size={14} strokeWidth={2} className="shrink-0 text-ink-400" />
                  ) : (
                    <ChevronRight size={14} strokeWidth={2} className="shrink-0 text-ink-400" />
                  )}
                  JE {e.docNumber ?? `#${e.qbTxnId}`}
                </button>
              </td>
              {showCompany && (
                <td className="px-4 py-3 text-ink-600">{companyName[e.realmId] ?? e.realmId}</td>
              )}
              <td className="px-4 py-3 text-ink-900">
                {e.assets.map((a) => (
                  <div key={a.account}>{a.account}</div>
                ))}
              </td>
              <td className="px-4 py-3 text-ink-600">{e.jobs.length ? e.jobs.join(", ") : "—"}</td>
              <td className="whitespace-nowrap px-4 py-3 text-right font-medium tabular-nums text-ink-900">
                {money(e.labor)}
              </td>
              <td className="px-4 py-3 text-ink-600">{e.memo ?? "—"}</td>
            </tr>
            {expanded && (
              <tr>
                <td colSpan={colSpan} className="bg-surface/40 px-6 py-3">
                  <table className="w-full text-[0.8rem]">
                    <thead>
                      <tr className="text-left text-[0.7rem] uppercase tracking-[0.08em] text-ink-400">
                        <th className="py-1 pr-3 font-semibold">Line</th>
                        <th className="py-1 pr-3 font-semibold">Account</th>
                        <th className="py-1 pr-3 font-semibold">Job</th>
                        <th className="py-1 pr-3 text-right font-semibold">Debit</th>
                        <th className="py-1 text-right font-semibold">Credit</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line/50">
                      {e.lines.map((l, i) => {
                        const { debit, credit } = capLineSide(l);
                        return (
                          <tr key={i}>
                            <td className="py-1.5 pr-3">
                              <span
                                className={`inline-block rounded-full border px-2 py-0.5 text-[0.65rem] font-medium ${KIND_STYLES[l.kind]}`}
                              >
                                {CAP_LINE_KIND_LABELS[l.kind]}
                              </span>
                            </td>
                            <td className="py-1.5 pr-3 text-ink-900">{l.account}</td>
                            <td className="py-1.5 pr-3 text-ink-600">{l.customer ?? "—"}</td>
                            <td className="py-1.5 pr-3 text-right tabular-nums text-ink-900">
                              {debit ? money(debit) : ""}
                            </td>
                            <td className="py-1.5 text-right tabular-nums text-ink-900">
                              {credit ? money(credit) : ""}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {e.laborAccounts.length > 1 && (
                    <p className="mt-2 text-xs text-ink-500">
                      Labor capitalized:{" "}
                      {e.laborAccounts.map((a) => `${a.account} ${money(a.amount)}`).join(" · ")}
                    </p>
                  )}
                </td>
              </tr>
            )}
          </Fragment>
        );
      })}
    </>
  );
}
