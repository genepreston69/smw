"use client";

import { Fragment, useState } from "react";
import { ChevronRight } from "lucide-react";
import { moneyWhole, pct } from "@/lib/format";
import type {
  CategoryStatement,
  StatementSection,
  StatementTotals,
} from "@/lib/financials";
import { Table, Th, buttonCls } from "@/components/ui";

/**
 * Budget vs Actual in the Income Statement's expandable layout. The
 * statement arrives with three columns — "fy" (full-year budget), "budget"
 * (year-to-date budget) and "actual" (year-to-date ledger) — and variance is
 * shown favorable-positive: actual − budget for income and profit lines,
 * budget − actual for cost lines.
 */
export function VarianceTable({
  statement,
  ytdLabel,
}: {
  statement: CategoryStatement;
  ytdLabel: string;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const sections = [
    { section: statement.income, cost: false },
    { section: statement.directCosts, cost: true },
    { section: statement.expenses, cost: true },
  ].filter((s) => s.section.groups.length > 0);
  const allKeys = sections.flatMap(({ section }) =>
    section.groups.map((g) => `${section.label}|${g.label}`),
  );
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const moneyCell = (v: number, bold: boolean, tone = false) => (
    <td
      className={`whitespace-nowrap px-4 py-2 text-right tabular-nums ${
        bold ? "font-semibold" : ""
      } ${tone && v > 0 ? "text-ok-600" : v < 0 ? "text-bad-600" : "text-ink-900"}`}
    >
      {v === 0 ? <span className="text-ink-400">—</span> : moneyWhole(v)}
    </td>
  );

  const cells = (t: StatementTotals, cost: boolean, bold = false) => {
    const fy = t.cells.fy ?? 0;
    const budget = t.cells.budget ?? 0;
    const actual = t.cells.actual ?? 0;
    const variance = cost ? budget - actual : actual - budget;
    const varPct = budget !== 0 ? variance / Math.abs(budget) : null;
    return (
      <>
        {moneyCell(fy, bold)}
        {moneyCell(budget, bold)}
        {moneyCell(actual, bold)}
        {moneyCell(variance, bold, true)}
        <td
          className={`whitespace-nowrap py-2 pr-4 pl-1 text-right text-xs tabular-nums ${
            varPct !== null && varPct < 0
              ? "text-bad-600"
              : varPct !== null && varPct > 0
                ? "text-ok-600"
                : "text-ink-400"
          }`}
        >
          {varPct === null || variance === 0 ? "—" : pct(varPct)}
        </td>
      </>
    );
  };

  const COLS = 6;
  const sectionRows = (section: StatementSection, cost: boolean) => (
    <Fragment key={section.label}>
      <tr className="bg-surface/50">
        <td
          colSpan={COLS}
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
              {cells(group, cost)}
            </tr>
            {isOpen &&
              group.rows.map((row) => (
                <tr key={row.key} className="hover:bg-surface/50">
                  <td className="px-4 py-1.5 pl-10 text-[0.8rem] text-ink-600">
                    {row.key}
                  </td>
                  {cells(row, cost)}
                </tr>
              ))}
          </Fragment>
        );
      })}
      <tr className="bg-surface">
        <td className="px-4 py-2 font-semibold text-ink-900">
          Total {section.label.toLowerCase()}
        </td>
        {cells(section, cost, true)}
      </tr>
    </Fragment>
  );

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
            <Th right>Full-year budget</Th>
            <Th right>{ytdLabel} budget</Th>
            <Th right>{ytdLabel} actual</Th>
            <Th right>Variance</Th>
            <Th right>%</Th>
          </tr>
        }
      >
        {sectionRows(statement.income, false)}
        {statement.directCosts.groups.length > 0 &&
          sectionRows(statement.directCosts, true)}
        {statement.grossProfit && (
          <tr className="bg-surface">
            <td className="px-4 py-2 font-semibold text-ink-900">Gross profit</td>
            {cells(statement.grossProfit, false, true)}
          </tr>
        )}
        {sectionRows(statement.expenses, true)}
        <tr className="bg-surface">
          <td className="px-4 py-2 font-semibold text-ink-900">Net income</td>
          {cells(statement.netIncome, false, true)}
        </tr>
      </Table>
    </div>
  );
}
