"use client";

import { Fragment, useState } from "react";
import { ChevronRight } from "lucide-react";
import { moneyWhole, pct } from "@/lib/format";
import type {
  CategoryStatement,
  StatementLine,
  StatementSection,
  StatementTotals,
} from "@/lib/financials";
import { Table, Th, buttonCls } from "@/components/ui";

/**
 * Lets account cells be typed over (the Budget page passes one; the Income
 * Statement doesn't). Column "total" is the row-total column — or the lone
 * Total column in the total layout.
 */
export interface StatementCellEditor {
  /** Whether this account's cell in this column can be typed over. */
  editable: (account: string, colKey: string) => boolean;
  /** The figure the field opens with. */
  value: (account: string, colKey: string) => number;
  /** Whether the cell holds a typed figure (highlighted). */
  typed: (account: string, colKey: string) => boolean;
  /** Tooltip for the cell. */
  title: (account: string, colKey: string) => string | undefined;
  /** A committed figure; null (an emptied field) clears it. */
  commit: (account: string, colKey: string, value: number | null) => void;
}

/** Field text as a number: tolerates "$", thousands separators and spaces;
    "" → null (clear); anything else non-numeric → NaN. */
const parseFigure = (text: string): number | null => {
  const t = text.replace(/[\s,$]/g, "");
  return t === "" ? null : Number(t);
};

/** One typed-over-able account cell: shows the amount, and on click (or
    Enter) turns into a plain text field — no spinner arrows. Enter or
    leaving the field commits; Escape cancels. */
function EditableMoneyCell({
  amount,
  account,
  colKey,
  editor,
}: {
  amount: number | undefined;
  account: string;
  colKey: string;
  editor: StatementCellEditor;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const typed = editor.typed(account, colKey);

  const open = () => {
    const v = Math.round(editor.value(account, colKey) * 100) / 100;
    setDraft(v === 0 && !typed ? "" : String(v));
    setInvalid(false);
  };
  const close = () => {
    setDraft(null);
    setInvalid(false);
  };
  // Returns false when the text isn't a number (the field stays open).
  const commit = (): boolean => {
    if (draft === null) return true;
    const v = parseFigure(draft);
    if (v !== null && !Number.isFinite(v)) return false;
    // Clicking through a cell without changing it must not turn it into a
    // typed figure.
    const unchanged =
      v === null ? !typed : Math.abs(v - editor.value(account, colKey)) < 0.005;
    if (!unchanged) editor.commit(account, colKey, v);
    close();
    return true;
  };

  if (draft !== null) {
    return (
      <td className="whitespace-nowrap px-2 py-1 text-right">
        <input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          autoFocus
          value={draft}
          aria-label={`${account} budget`}
          aria-invalid={invalid}
          onChange={(e) => {
            setDraft(e.target.value);
            setInvalid(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (!commit()) setInvalid(true);
            } else if (e.key === "Escape") {
              e.preventDefault();
              close();
            }
          }}
          onBlur={() => {
            // A field left with text that isn't a number changes nothing.
            if (!commit()) close();
          }}
          className={`w-28 rounded-md border bg-white px-2 py-0.5 text-right text-[0.8rem] tabular-nums text-ink-900 ${
            invalid ? "border-bad-600/60" : "border-brand-500"
          }`}
        />
      </td>
    );
  }
  return (
    <td className="whitespace-nowrap px-1 py-0.5 text-right">
      <button
        type="button"
        onClick={open}
        title={editor.title(account, colKey)}
        className={`w-full cursor-text rounded-md px-3 py-1 text-right tabular-nums ring-brand-500/40 transition-colors hover:ring-1 ${
          typed ? "bg-brand-50 font-medium text-brand-700" : "text-ink-900"
        } ${amount !== undefined && amount < 0 ? "text-bad-600" : ""}`}
      >
        {amount === undefined || amount === 0 ? (
          <span className="text-ink-400">—</span>
        ) : (
          moneyWhole(amount)
        )}
      </button>
    </td>
  );
}

/**
 * The expandable income statement: one row per Category with its subtotal,
 * expanding to the member accounts. Collapse state is per category and
 * client-only; the statement itself is assembled on the server
 * (buildCategoryStatement) and arrives as plain JSON.
 */
export function StatementTable({
  statement,
  colLabels,
  showRowTotal,
  editor,
}: {
  statement: CategoryStatement;
  colLabels: Record<string, string>;
  showRowTotal: boolean;
  /** Makes account cells typed-over-able (Budget page only). */
  editor?: StatementCellEditor;
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

  // Common-size denominator: the same column's total income (null = row total).
  const revenueFor = (colKey: string | null): number =>
    colKey === null
      ? statement.income.total
      : (statement.income.cells[colKey] ?? 0);

  const pctCell = (v: number | undefined, colKey: string | null, bold = false) => {
    const denom = revenueFor(colKey);
    const show = v !== undefined && v !== 0 && denom !== 0;
    return (
      <td
        className={`whitespace-nowrap py-2 pr-4 pl-1 text-right text-xs tabular-nums ${
          bold ? "font-medium" : ""
        } ${show && v < 0 ? "text-bad-600" : "text-ink-500"}`}
      >
        {show ? pct(v / denom) : <span className="text-ink-400">—</span>}
      </td>
    );
  };

  const totalCells = (t: StatementTotals, bold = false) => (
    <>
      {statement.colKeys.map((k) => (
        <Fragment key={k}>
          {moneyCell(t.cells[k], bold)}
          {pctCell(t.cells[k], k, bold)}
        </Fragment>
      ))}
      {showRowTotal && (
        <>
          {moneyCell(t.total, bold)}
          {pctCell(t.total, null, bold)}
        </>
      )}
    </>
  );

  // An account row: like totalCells, but each amount the editor allows is a
  // typed-over-able cell.
  const accountCells = (row: StatementLine) => {
    const amountCell = (colKey: string, v: number | undefined) =>
      editor?.editable(row.key, colKey) ? (
        <EditableMoneyCell amount={v} account={row.key} colKey={colKey} editor={editor} />
      ) : (
        moneyCell(v)
      );
    return (
      <>
        {statement.colKeys.map((k) => (
          <Fragment key={k}>
            {amountCell(k, row.cells[k])}
            {pctCell(row.cells[k], k)}
          </Fragment>
        ))}
        {showRowTotal && (
          <>
            {amountCell("total", row.total)}
            {pctCell(row.total, null)}
          </>
        )}
      </>
    );
  };

  const sectionRows = (section: StatementSection) => {
    const colSpan = 1 + 2 * statement.colKeys.length + (showRowTotal ? 2 : 0);
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
                    {accountCells(row)}
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
              <Fragment key={k}>
                <Th right>{colLabels[k] ?? k}</Th>
                <Th right>%</Th>
              </Fragment>
            ))}
            {showRowTotal && (
              <>
                <Th right>Total</Th>
                <Th right>%</Th>
              </>
            )}
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
          <td className="px-4 py-2 font-semibold text-ink-900">Net income</td>
          {totalCells(statement.netIncome, true)}
        </tr>
      </Table>
    </div>
  );
}
