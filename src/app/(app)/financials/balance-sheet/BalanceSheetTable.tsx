"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { moneyWhole } from "@/lib/format";
import { linesHref, monthLabel } from "@/lib/financials";
import type {
  BalanceGroup,
  BalanceLine,
  BalanceSection,
  BalanceSheet,
  BalanceTotals,
} from "@/lib/balanceSheet";
import { Table, Th, buttonCls } from "@/components/ui";

/**
 * The expandable balance sheet: Assets, Liabilities and Equity, one row per
 * account-type group with its subtotal, expanding to the member accounts.
 * Collapse state is per group and client-only; the sheet itself is assembled
 * on the server (buildBalanceSheet) and arrives as plain JSON.
 */
export function BalanceSheetTable({
  sheet,
  colLabels,
  drillCompany,
}: {
  sheet: BalanceSheet;
  colLabels: Record<string, string>;
  /** Set when columns are month ends: each account balance then links to
      that month's ledger activity for the account (realm id or "all"). */
  drillCompany: string | null;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const sections = [sheet.assets, sheet.liabilities, sheet.equity, sheet.other];
  const allKeys = sections.flatMap((s) =>
    s.groups.filter((g) => !g.single).map((g) => `${s.key}|${g.label}`),
  );
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const amount = (v: number | undefined) =>
    v === undefined || Math.abs(v) < 0.005 ? (
      <span className="text-ink-400">—</span>
    ) : (
      moneyWhole(v)
    );
  const cellCls = (v: number | undefined, bold: boolean) =>
    `whitespace-nowrap px-4 py-2 text-right tabular-nums ${
      bold ? "font-semibold text-ink-900" : "text-ink-900"
    } ${v !== undefined && v <= -0.005 ? "text-bad-600" : ""}`;

  const totalCells = (t: BalanceTotals, bold = false) =>
    sheet.colKeys.map((k) => (
      <td key={k} className={cellCls(t.cells[k], bold)}>
        {amount(t.cells[k])}
      </td>
    ));

  const accountCells = (row: BalanceLine) =>
    sheet.colKeys.map((k) => {
      const v = row.cells[k];
      if (drillCompany === null || row.computed) {
        return (
          <td key={k} className={cellCls(v, false)}>
            {amount(v)}
          </td>
        );
      }
      return (
        <td key={k} className={cellCls(v, false)}>
          <Link
            href={linesHref(
              {
                company: drillCompany,
                from: k,
                to: k,
                rows: "account",
                cols: "month",
                scope: "all",
                display: "amount",
              },
              row.key,
              k,
            )}
            title={`Ledger activity in ${monthLabel(k)}`}
            className="hover:underline"
          >
            {amount(v)}
          </Link>
        </td>
      );
    });

  const totalRow = (label: string, t: BalanceTotals, strong = false) => (
    <tr className={strong ? "bg-surface" : "bg-surface/50"}>
      <td className={`px-4 py-2 ${strong ? "font-semibold" : "font-medium"} text-ink-900`}>
        {label}
      </td>
      {totalCells(t, true)}
    </tr>
  );

  const groupRows = (section: BalanceSection, group: BalanceGroup) => {
    if (group.single) {
      return (
        <tr key={`${section.key}|${group.label}`} className="hover:bg-surface/50">
          <td className="px-4 py-2 pl-9 font-medium text-ink-900">{group.label}</td>
          {totalCells(group)}
        </tr>
      );
    }
    const key = `${section.key}|${group.label}`;
    const isOpen = expanded.has(key);
    return (
      <Fragment key={key}>
        <tr onClick={() => toggle(key)} className="cursor-pointer select-none hover:bg-surface/50">
          <td className="px-4 py-2 font-medium text-ink-900">
            <span className="flex items-center gap-1.5">
              <ChevronRight
                size={14}
                strokeWidth={2}
                className={`shrink-0 text-ink-400 transition-transform ${isOpen ? "rotate-90" : ""}`}
              />
              {group.label}
              <span className="text-xs font-normal text-ink-400">{group.rows.length}</span>
            </span>
          </td>
          {totalCells(group)}
        </tr>
        {isOpen &&
          group.rows.map((row) => (
            <tr key={row.key} className="hover:bg-surface/50">
              <td className="px-4 py-1.5 pl-10 text-[0.8rem] text-ink-600">
                {row.accountNumber ? `${row.accountNumber} · ${row.key}` : row.key}
              </td>
              {accountCells(row)}
            </tr>
          ))}
      </Fragment>
    );
  };

  const sectionRows = (section: BalanceSection) => {
    if (section.groups.length === 0) return null;
    // "Total current …" goes after the last current group, and only when
    // non-current groups follow — otherwise it would repeat the section total.
    const lastCurrent = section.groups.findLastIndex((g) => g.current);
    const showCurrent =
      section.current !== null && section.groups.some((g) => !g.current);
    return (
      <Fragment key={section.key}>
        <tr className="bg-surface/50">
          <td
            colSpan={1 + sheet.colKeys.length}
            className="px-4 py-1.5 text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-ink-400"
          >
            {section.label}
          </td>
        </tr>
        {section.groups.map((g, i) => (
          <Fragment key={g.label}>
            {groupRows(section, g)}
            {showCurrent && i === lastCurrent &&
              totalRow(`Total current ${section.label.toLowerCase()}`, section.current!)}
          </Fragment>
        ))}
        {totalRow(`Total ${section.label.toLowerCase()}`, section, true)}
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
            <Th>Account</Th>
            {sheet.colKeys.map((k) => (
              <Th key={k} right>
                {colLabels[k] ?? k}
              </Th>
            ))}
          </tr>
        }
      >
        {sectionRows(sheet.assets)}
        {sectionRows(sheet.liabilities)}
        {sectionRows(sheet.equity)}
        {totalRow("Total liabilities and equity", sheet.liabilitiesAndEquity, true)}
        {sectionRows(sheet.other)}
        {sheet.difference && (
          <tr className="bg-red-50">
            <td className="px-4 py-2 font-semibold text-red-800">
              Out of balance (assets − liabilities and equity)
            </td>
            {totalCells(sheet.difference, true)}
          </tr>
        )}
      </Table>
    </div>
  );
}
