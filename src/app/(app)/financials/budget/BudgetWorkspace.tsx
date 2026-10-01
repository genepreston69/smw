"use client";

import { useMemo, useState } from "react";
import { Landmark } from "lucide-react";
import { moneyWhole } from "@/lib/format";
import {
  buildCategoryStatement,
  buildEliminations,
  serializeEliminations,
  type CategoryStatement,
  type PivotCell,
  type PivotTotals,
  type RealmRevenueSlice,
  type StatementEliminations,
} from "@/lib/financials";
import {
  MONTH_NAMES,
  actualCells,
  budgetColKey,
  budgetColLabel,
  growBaselineCells,
  growEliminationSlice,
  initiativeCells,
  type BudgetAssumption,
  type BudgetColDim,
  type BudgetInitiative,
  type BudgetView,
  type MonthToCol,
} from "@/lib/budget";
import { Card, EmptyState, StatTile } from "@/components/ui";
import { StatementTable } from "../statement/StatementTable";
import { AssumptionsEditor } from "./AssumptionsEditor";
import { VarianceTable } from "./VarianceTable";

/**
 * The live part of the Budget page. The server hands over the raw inputs —
 * per-company baseline cells, the intercompany customer cells, YTD actuals,
 * approved initiatives, and the saved growth assumptions — and the budget
 * statement is assembled here, so editing a growth % re-prices every row
 * immediately while the new value auto-saves in the background. Same
 * helpers and statement builder as before (src/lib/budget.ts,
 * buildCategoryStatement), so the numbers are identical to a fresh load.
 */
export function BudgetWorkspace({
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
  wantEliminations,
  approvedNet,
  proposedNet,
  proposedCount,
  baselineHint,
  assumptionsAction,
}: {
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

  const { statement, eliminations, variance } = useMemo(() => {
    const budgetCells = (toCol: MonthToCol): PivotCell[] =>
      companies.flatMap((c, idx) => [
        ...growBaselineCells(baselineByRealm[idx] ?? [], assumptions[c.realmId], toCol),
        ...initiativeCells(
          approved.filter((i) => i.realm_id === c.realmId),
          toCol,
        ),
      ]);
    const budgetSlices = (toCol: MonthToCol): RealmRevenueSlice[] =>
      wantEliminations
        ? companies.map((c, idx) =>
            growEliminationSlice(
              { realmId: c.realmId, companyName: c.name, cells: eliminationCellsByRealm[idx] ?? [] },
              assumptions[c.realmId],
              toCol,
            ),
          )
        : [];
    const eliminationsFor = (
      slices: RealmRevenueSlice[],
      s: CategoryStatement,
    ): StatementEliminations | null => {
      if (!wantEliminations) return null;
      const net: PivotTotals = {
        bycol: new Map(Object.entries(s.netIncome.cells)),
        total: s.netIncome.total,
      };
      const raw = buildEliminations(slices, net);
      return raw ? serializeEliminations(raw) : null;
    };

    const toCol: MonthToCol = (m) => budgetColKey(year, m, colDim);
    const statement = buildCategoryStatement(budgetCells(toCol), categoryByAccount);
    const eliminations = eliminationsFor(budgetSlices(toCol), statement);

    // Budget vs Actual: full-year budget, YTD budget, and YTD actual as three
    // columns of one statement, so every row lines up.
    let variance: { statement: CategoryStatement; eliminations: StatementEliminations | null } | null =
      null;
    if (view === "variance" && actuals) {
      const fy: MonthToCol = () => "fy";
      const ytd: MonthToCol = (m) => (m <= closedThrough ? "budget" : null);
      const vStatement = buildCategoryStatement(
        [...budgetCells(fy), ...budgetCells(ytd), ...actualCells(actuals, "actual", closedThrough)],
        categoryByAccount,
      );
      variance = {
        statement: vStatement,
        eliminations: eliminationsFor(
          [
            ...budgetSlices(fy),
            ...budgetSlices(ytd),
            ...actualEliminationSlices.map((s) => ({
              ...s,
              cells: actualCells(s.cells, "actual", closedThrough),
            })),
          ],
          vStatement,
        ),
      };
    }
    return { statement, eliminations, variance };
  }, [
    assumptions,
    companies,
    baselineByRealm,
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
  ]);

  const colLabels = Object.fromEntries(
    statement.colKeys.map((k) => [k, budgetColLabel(colDim, k)]),
  );
  const hasBaseline = baselineByRealm.some((c) => c.length > 0);

  return (
    <>
      <AssumptionsEditor
        budgetYear={year}
        action={assumptionsAction}
        companies={companies.map((c) => {
          const a = assumptions[c.realmId];
          return {
            realmId: c.realmId,
            name: c.name,
            revenueGrowthPct: a?.revenue_growth_pct ?? 0,
            expenseGrowthPct: a?.expense_growth_pct ?? 0,
          };
        })}
        onChange={(realmId, revenueGrowthPct, expenseGrowthPct) =>
          setAssumptions((prev) => ({
            ...prev,
            [realmId]: {
              realm_id: realmId,
              revenue_growth_pct: revenueGrowthPct,
              expense_growth_pct: expenseGrowthPct,
            },
          }))
        }
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
