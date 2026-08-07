"use client";

import { Fragment, useState } from "react";
import { ChevronRight } from "lucide-react";
import { moneyWhole } from "@/lib/format";
import type {
  CategoryStatement,
  StatementEliminations,
  StatementSection,
  StatementTotals,
} from "@/lib/financials";
import { Table, Th, buttonCls } from "@/components/ui";

/**
 * The expandable income statement: one row per Category with its subtotal,
 * expanding to the member accounts. Collapse state is per category and
 * client-only; the statement itself is assembled on the server
 * (buildCategoryStatement) and arrives as plain JSON.
 */
export function StatementTable({
  statement,
  eliminations,
  colLabels,
  showRowTotal,
}: {
  statement: CategoryStatement;
  eliminations: StatementEliminations | null;
  colLabels: Record<string, string>;
  showRowTotal: boolean;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const sections = [
    statement.income,
    statement.directCosts,
    statement.expenses,
  ].filter((s) => s.groups.length > 0);
  const allKeys = sections.flatMap((s) =>
    s.groups.map((g) => `${s.label}|${g.label}`),
  );
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const moneyCell = (v: number | undefined, bold = false) => (
    <td
      className={`whitespace-nowrap px-4 py-2 text-right tabular-nums ${
        bold ? "font-semibold text-ink-900" : "text-ink-900"
      } ${v !== undefined && v < 0 ? "text-bad-600" : ""}`}
    >
      {v === undefined || v === 0 ? (
        <span className="text-ink-400">—</span>
      ) : (
        moneyWhole(v)
      )}
    </td>
  );

  const totalCells = (t: StatementTotals, bold = false) => (
    <>
      {statement.colKeys.map((k) => (
        <Fragment key={k}>{moneyCell(t.cells[k], bold)}</Fragment>
      ))}
      {showRowTotal && moneyCell(t.total, bold)}
    </>
  );

  const sectionRows = (section: StatementSection) => {
    const colSpan = 1 + statement.colKeys.length + (showRowTotal ? 1 : 0);
    return (
      <Fragment key={section.label}>
        <tr className="bg-surface/50">
          <td
            colSpan={colSpan}
            className="px-4 py-1.5 text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-ink-400"
          >
            {section.label}
          </td>
        </tr>
        {section.groups.map((group) => {
          const key = `${section.label}|${group.label}`;
          const isOpen = expanded.has(key);
          return (
            <Fragment key={key}>
              <tr
                onClick={() => toggle(key)}
                className="cursor-pointer select-none hover:bg-surface/50"
              >
                <td className="px-4 py-2 font-medium text-ink-900">
                  <span className="flex items-center gap-1.5">
                    <ChevronRight
                      size={14}
                      strokeWidth={2}
                      className={`shrink-0 text-ink-400 transition-transform ${isOpen ? "rotate-90" : ""}`}
                    />
                    {group.label}
                    <span className="text-xs font-normal text-ink-400">
                      {group.rows.length}
                    </span>
                  </span>
                </td>
                {totalCells(group)}
              </tr>
              {isOpen &&
                group.rows.map((row) => (
                  <tr key={row.key} className="hover:bg-surface/50">
                    <td className="px-4 py-1.5 pl-10 text-[0.8rem] text-ink-600">
                      {row.key}
                    </td>
                    {totalCells(row)}
                  </tr>
                ))}
            </Fragment>
          );
        })}
        <tr className="bg-surface">
          <td className="px-4 py-2 font-semibold text-ink-900">
            Total {section.label.toLowerCase()}
          </td>
          {totalCells(section, true)}
        </tr>
      </Fragment>
    );
  };

  return (
    <div>
      <div className="flex items-center justify-end gap-2 border-b border-line/70 px-4 py-2">
        <button
          type="button"
          onClick={() => setExpanded(new Set(allKeys))}
          className={buttonCls("secondary", "sm")}
        >
          Expand all
        </button>
        <button
          type="button"
          onClick={() => setExpanded(new Set())}
          className={buttonCls("secondary", "sm")}
        >
          Collapse all
        </button>
      </div>
      <Table
        head={
          <tr>
            <Th>Category</Th>
            {statement.colKeys.map((k) => (
              <Th key={k} right>
                {colLabels[k] ?? k}
              </Th>
            ))}
            {showRowTotal && <Th right>Total</Th>}
          </tr>
        }
      >
        {sectionRows(statement.income)}
        {statement.directCosts.groups.length > 0 &&
          sectionRows(statement.directCosts)}
        {statement.grossProfit && (
          <tr className="bg-surface">
            <td className="px-4 py-2 font-semibold text-ink-900">
              Gross profit
            </td>
            {totalCells(statement.grossProfit, true)}
          </tr>
        )}
        {sectionRows(statement.expenses)}
        <tr className="bg-surface">
          <td className="px-4 py-2 font-semibold text-ink-900">
            {eliminations ? "Net income before eliminations" : "Net income"}
          </td>
          {totalCells(statement.netIncome, true)}
        </tr>
        {eliminations && (
          <>
            <tr className="bg-surface/50">
              <td
                colSpan={1 + statement.colKeys.length + (showRowTotal ? 1 : 0)}
                className="px-4 py-1.5 text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-ink-400"
              >
                Intercompany eliminations
              </td>
            </tr>
            {eliminations.lines.map((line) => (
              <tr key={line.label} className="hover:bg-surface/50">
                <td className="px-4 py-2 text-ink-900">{line.label}</td>
                {totalCells(line)}
              </tr>
            ))}
            <tr className="bg-surface">
              <td className="px-4 py-2 font-semibold text-ink-900">
                Net income after eliminations
              </td>
              {totalCells(eliminations.adjusted, true)}
            </tr>
          </>
        )}
      </Table>
    </div>
  );
}
