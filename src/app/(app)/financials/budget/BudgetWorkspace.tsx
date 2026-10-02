"use client";

import { useMemo, useState } from "react";
import { Download, FileSpreadsheet, Landmark } from "lucide-react";
import { moneyWhole } from "@/lib/format";
import type { PivotCell, RealmRevenueSlice } from "@/lib/financials";
import {
  MONTH_NAMES,
  assembleBudget,
  budgetColLabel,
  budgetExportHref,
  zeroAssumption,
  type BudgetAssumption,
  type BudgetColDim,
  type BudgetInitiative,
  type BudgetView,
  type GrowthCategory,
} from "@/lib/budget";
import { Card, EmptyState, PageHeader, StatTile, buttonCls } from "@/components/ui";
import { StatementTable } from "../statement/StatementTable";
import { AssumptionsEditor } from "./AssumptionsEditor";
import { VarianceTable } from "./VarianceTable";

/**
 * The live part of the Budget page. The server hands over the raw inputs —
 * per-company baseline cells and account categories, the intercompany
 * customer cells, YTD actuals, approved initiatives, and the saved growth
 * assumptions — and the budget
 * statement is assembled here, so editing a growth % re-prices every row
 * immediately; AssumptionsEditor then asks to save or revert. Same
 * helpers and statement builder as before (src/lib/budget.ts,
 * buildCategoryStatement), so the numbers are identical to a fresh load.
 */
export function BudgetWorkspace({
  title,
  subtitle,
  headerLinks,
  filters,
  company,
  year,
  colDim,
  view,
  closedThrough,
  companies,
  initialAssumptions,
  baselineByRealm,
  eliminationCellsByRealm,
  actuals,
  actualEliminationSlices,
  approved,
  categoryEntries,
  realmCategoryEntries,
  growthCategories,
  wantEliminations,
  approvedNet,
  proposedNet,
  proposedCount,
  baselineHint,
  assumptionsAction,
}: {
  title: string;
  subtitle: string;
  /** Extra header buttons after Export Excel (server-rendered links). */
  headerLinks: React.ReactNode;
  /** The Company / View / Columns filter card (server-rendered links). */
  filters: React.ReactNode;
  /** Selected company: realm id or "all". */
  company: string;
  year: number;
  colDim: BudgetColDim;
  view: BudgetView;
  /** Budget-year months already closed (0 = none). */
  closedThrough: number;
  companies: { realmId: string; name: string }[];
  initialAssumptions: BudgetAssumption[];
  /** Baseline account × month cells, one array per company (companies order). */
  baselineByRealm: PivotCell[][];
  /** Baseline customer × month cells that feed an elimination, per company. */
  eliminationCellsByRealm: PivotCell[][];
  /** YTD actual account × month cells, all companies (null = not loaded). */
  actuals: PivotCell[] | null;
  actualEliminationSlices: RealmRevenueSlice[];
  approved: BudgetInitiative[];
  categoryEntries: [string, string][];
  /** Each company's own account → category entries (companies order). */
  realmCategoryEntries: [string, string][][];
  /** Rows of the growth assumptions grid. */
  growthCategories: GrowthCategory[];
  wantEliminations: boolean;
  approvedNet: number;
  proposedNet: number;
  proposedCount: number;
  baselineHint: string;
  assumptionsAction: React.ReactNode;
}) {
  const [assumptions, setAssumptions] = useState<Record<string, BudgetAssumption>>(
    () => Object.fromEntries(initialAssumptions.map((a) => [a.realm_id, a])),
  );

  const categoryByAccount = useMemo(
    () => new Map(categoryEntries),
    [categoryEntries],
  );
  const realmCategories = useMemo(
    () => realmCategoryEntries.map((entries) => new Map(entries)),
    [realmCategoryEntries],
  );

  const { statement, eliminations, variance } = useMemo(
    () =>
      assembleBudget({
        year,
        colDim,
        view,
        closedThrough,
        companies,
        assumptions,
        baselineByRealm,
        realmCategories,
        eliminationCellsByRealm,
        actuals,
        actualEliminationSlices,
        approved,
        categoryByAccount,
        wantEliminations,
      }),
    [
      assumptions,
      companies,
      baselineByRealm,
      realmCategories,
      eliminationCellsByRealm,
      actuals,
      actualEliminationSlices,
      approved,
      categoryByAccount,
      wantEliminations,
      year,
      colDim,
      view,
      closedThrough,
    ],
  );

  // The export carries the growth rates on screen (saved or not), so the
  // file matches what the user is looking at.
  const exportState = {
    company,
    cols: colDim,
    view,
    assumptions: companies.map((c) => assumptions[c.realmId] ?? zeroAssumption(c.realmId)),
  };
  const exportHref = budgetExportHref(exportState);

  // Category workbook: one account category's budget as its own file. A label
  // used on both income and expense accounts is one entry (and one file).
  const categoryLabels = useMemo(
    () =>
      [...new Set(growthCategories.map((c) => c.category))].sort((a, b) => a.localeCompare(b)),
    [growthCategories],
  );
  const exportCategory = (category: string) => {
    // A download link rather than navigation, so an error response can't
    // replace the page and lose unsaved growth edits.
    const a = document.createElement("a");
    a.href = budgetExportHref({ ...exportState, category });
    a.download = "";
    a.click();
  };

  const colLabels = Object.fromEntries(
    statement.colKeys.map((k) => [k, budgetColLabel(colDim, k)]),
  );
  const hasBaseline = baselineByRealm.some((c) => c.length > 0);

  return (
    <>
      <PageHeader
        title={title}
        subtitle={subtitle}
        action={
          <div className="flex items-center gap-2">
            <a href={exportHref} className={buttonCls("secondary")}>
              <Download size={15} strokeWidth={2} />
              Export Excel
            </a>
            {categoryLabels.length > 0 && (
              <label
                className={`${buttonCls("secondary")} relative cursor-pointer`}
                title="Download one category's budget as its own Excel workbook"
              >
                <FileSpreadsheet size={15} strokeWidth={2} />
                Export a category…
                {/* Invisible select over the button: picking a category
                    downloads it, and the controlled value snaps back. */}
                <select
                  value=""
                  onChange={(e) => {
                    if (e.target.value) exportCategory(e.target.value);
                  }}
                  aria-label="Export one category to Excel"
                  className="absolute inset-0 cursor-pointer opacity-0"
                >
                  <option value="" disabled>
                    Choose a category
                  </option>
                  {categoryLabels.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {headerLinks}
          </div>
        }
      />
      {filters}

      <AssumptionsEditor
        budgetYear={year}
        action={assumptionsAction}
        companies={companies}
        initial={companies.map(
          (c) =>
            initialAssumptions.find((a) => a.realm_id === c.realmId) ?? zeroAssumption(c.realmId),
        )}
        categories={growthCategories}
        onChange={(a) => setAssumptions((prev) => ({ ...prev, [a.realm_id]: a }))}
      />

      {hasBaseline && (
        <div
          className={`mb-4 grid gap-4 sm:grid-cols-2 ${statement.grossProfit ? "xl:grid-cols-4" : "xl:grid-cols-3"}`}
        >
          <StatTile
            label="Budgeted income"
            value={moneyWhole(statement.income.total)}
            hint={baselineHint}
          />
          {statement.grossProfit && (
            <StatTile
              label="Budgeted gross profit"
              value={moneyWhole(statement.grossProfit.total)}
              hint="Income less direct costs"
            />
          )}
          <StatTile
            label="Budgeted net income"
            value={moneyWhole((eliminations?.adjusted ?? statement.netIncome).total)}
            hint={
              approvedNet !== 0
                ? `Includes ${moneyWhole(approvedNet)} from approved initiatives`
                : eliminations
                  ? "After intercompany eliminations"
                  : "Income less all expenses"
            }
          />
          <StatTile
            label="Proposed initiatives"
            value={moneyWhole(proposedNet)}
            hint={`${proposedCount} awaiting approval — not in budget`}
          />
        </div>
      )}

      <Card pad={false}>
        {!hasBaseline ? (
          <EmptyState icon={Landmark} title="No baseline ledger data">
            The budget is built from {baselineHint.replace(/^Baseline /, "")}{" "}
            actuals. Run a QuickBooks sync in Settings to import the general
            ledger.
          </EmptyState>
        ) : view === "budget" ? (
          <StatementTable
            statement={statement}
            eliminations={eliminations}
            colLabels={colLabels}
            showRowTotal={colDim !== "total"}
          />
        ) : variance ? (
          <VarianceTable
            statement={variance.statement}
            eliminations={variance.eliminations}
            ytdLabel={`YTD ${MONTH_NAMES[closedThrough - 1]} ${year}`}
          />
        ) : (
          <EmptyState icon={Landmark} title="No actuals yet">
            Budget vs Actual starts once January {year} closes; until then the
            Budget view shows the full plan.
          </EmptyState>
        )}
      </Card>
    </>
  );
}
