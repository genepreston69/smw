"use client";

import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { money } from "@/lib/format";
import type { BsRow } from "@/lib/balanceSheet";
import { Table, Th, buttonCls } from "@/components/ui";

/**
 * The balance sheet as QuickBooks prints it: each section's heading, its
 * lines, then its total. A collapsed section shows as one line carrying its
 * total.
 */
export function BalanceSheetTable({
  rows,
  columns,
}: {
  rows: BsRow[];
  columns: { key: string; label: string }[];
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const sectionPaths = useMemo(
    () => rows.filter((r) => r.kind === "section").map((r) => r.path),
    [rows],
  );
  const totalsByPath = useMemo(
    () =>
      new Map(
        rows
          .filter((r) => r.kind === "total")
          .map((r) => [r.path.slice(0, -"#total".length), r.amounts]),
      ),
    [rows],
  );

  const hidden = (row: BsRow) =>
    [...collapsed].some(
      (p) => row.path.startsWith(`${p}/`) || row.path === `${p}#total`,
    );
  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  const cells = (amounts: Record<string, number>, strong: boolean) =>
    columns.map((c) => (
      <td
        key={c.key}
        className={`whitespace-nowrap px-4 py-1.5 text-right tabular-nums ${
          strong ? "font-semibold text-ink-900" : "text-ink-600"
        } ${(amounts[c.key] ?? 0) < 0 ? "text-bad-600" : ""}`}
      >
        {amounts[c.key] === undefined ? "" : money(amounts[c.key])}
      </td>
    ));

  return (
    <div>
      <div className="flex items-center justify-end gap-2 border-b border-line/70 px-4 py-2">
        <button
          type="button"
          onClick={() => setCollapsed(new Set())}
          className={buttonCls("secondary", "sm")}
        >
          Expand all
        </button>
        <button
          type="button"
          // Everything below the two halves folds into its section total.
          onClick={() =>
            setCollapsed(new Set(sectionPaths.filter((p) => p.lastIndexOf("/") > 0)))
          }
          className={buttonCls("secondary", "sm")}
        >
          Collapse all
        </button>
      </div>
      <Table
        head={
          <tr>
            <Th>Account</Th>
            {columns.map((c) => (
              <Th key={c.key} right>
                {c.label}
              </Th>
            ))}
          </tr>
        }
      >
        {rows.filter((r) => !hidden(r)).map((row) => {
          const indent = { paddingLeft: `${1 + row.depth * 1.25}rem` };
          if (row.kind === "section") {
            const isCollapsed = collapsed.has(row.path);
            return (
              <tr key={row.path} className={row.depth === 0 ? "bg-surface" : undefined}>
                <td className="py-1.5 pr-4" style={indent}>
                  <button
                    type="button"
                    onClick={() => toggle(row.path)}
                    aria-expanded={!isCollapsed}
                    className="flex items-center gap-1 text-left font-semibold text-ink-900 hover:text-brand-700"
                  >
                    <ChevronRight
                      size={14}
                      strokeWidth={2}
                      className={`shrink-0 transition-transform ${isCollapsed ? "" : "rotate-90"}`}
                    />
                    {row.label}
                  </button>
                </td>
                {cells(
                  isCollapsed ? (totalsByPath.get(row.path) ?? {}) : row.amounts,
                  isCollapsed,
                )}
              </tr>
            );
          }
          const isTotal = row.kind === "total";
          return (
            <tr
              key={row.path}
              className={
                isTotal
                  ? row.depth === 0
                    ? "bg-surface"
                    : undefined
                  : "hover:bg-surface/50"
              }
            >
              <td
                className={`py-1.5 pr-4 ${
                  isTotal ? "font-semibold text-ink-900" : "text-[0.8rem] text-ink-600"
                }`}
                // Lines up with the section labels, past their chevrons.
                style={{ paddingLeft: `${2.15 + row.depth * 1.25}rem` }}
              >
                {row.label}
              </td>
              {cells(row.amounts, isTotal)}
            </tr>
          );
        })}
      </Table>
    </div>
  );
}
