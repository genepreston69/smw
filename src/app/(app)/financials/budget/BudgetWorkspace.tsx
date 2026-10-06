"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Building2, Download, Landmark, Layers, Loader2 } from "lucide-react";
import { moneyWhole } from "@/lib/format";
import {
  MONTH_NAMES,
  NO_CLASS,
  accountBaseMonths,
  assembleBudget,
  budgetColLabel,
  budgetExportHref,
  respreadTotal,
  spreadInitiativeLine,
  zeroAssumption,
  type AccountMonths,
  type BudgetAssumption,
  type BudgetCell,
  type BudgetClass,
  type BudgetColDim,
  type BudgetInitiative,
  type BudgetOverride,
  type BudgetView,
  type GrowthCategory,
} from "@/lib/budget";
import { Card, EmptyState, PageHeader, StatTile, buttonCls } from "@/components/ui";
import { StatementTable, type StatementCellEditor } from "../statement/StatementTable";
import { AssumptionsEditor } from "./AssumptionsEditor";
import { VarianceTable } from "./VarianceTable";
import { saveAccountOverrides } from "./actions";

/**
 * The live part of the Budget page. The server hands over the raw inputs —
 * per-company baseline cells and account categories, YTD actuals, approved
 * initiatives, and the saved growth assumptions — and the budget
 * statement is assembled here, so editing a growth % re-prices every row
 * immediately; AssumptionsEditor then asks to save or revert. With one
 * company and one class selected, account cells can also be typed over (a
 * month, or the annual Total re-spread in the months' current shape); those
 * figures save per class as each cell is committed (saveAccountOverrides).
 * Same
 * helpers and statement builder as before (src/lib/budget.ts,
 * buildCategoryStatement), so the numbers are identical to a fresh load.
 */
export function BudgetWorkspace({
  title,
  subtitle,
  headerLinks,
  filters,
  company,
  cls,
  classes,
  classesByRealm,
  year,
  colDim,
  view,
  closedThrough,
  companies,
  initialAssumptions,
  initialOverrides,
  baselineByRealm,
  actuals,
  approved,
  categoryEntries,
  realmCategoryEntries,
  growthCategories,
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
  /** Selected class, or null for All classes (the roll-up). */
  cls: BudgetClass;
  /** Every class the selected companies budget, sorted (NO_CLASS last). */
  classes: string[];
  /** The classes each selected company budgets. */
  classesByRealm: Record<string, string[]>;
  year: number;
  colDim: BudgetColDim;
  view: BudgetView;
  /** Budget-year months already closed (0 = none). */
  closedThrough: number;
  companies: { realmId: string; name: string }[];
  initialAssumptions: BudgetAssumption[];
  /** Saved typed account-months for the selected companies and class. */
  initialOverrides: BudgetOverride[];
  /** Baseline account × month × class cells, one array per company
      (companies order). */
  baselineByRealm: BudgetCell[][];
  /** YTD actual account × month × class cells, all companies (null = not
      loaded). */
  actuals: BudgetCell[] | null;
  approved: BudgetInitiative[];
  categoryEntries: [string, string][];
  /** Each company's own account → category entries (companies order). */
  realmCategoryEntries: [string, string][][];
  /** Rows of the growth assumptions grid. */
  growthCategories: GrowthCategory[];
  approvedNet: number;
  proposedNet: number;
  proposedCount: number;
  baselineHint: string;
  assumptionsAction: React.ReactNode;
}) {
  const [assumptions, setAssumptions] = useState<Record<string, BudgetAssumption>>(
    () => Object.fromEntries(initialAssumptions.map((a) => [a.realm_id, a])),
  );

  // Typed account-months. A ref mirrors the state so rapid commits build on
  // each other, and saves run one at a time in commit order.
  const [overrides, setOverridesState] = useState<BudgetOverride[]>(initialOverrides);
  const overridesRef = useRef(overrides);
  const setOverrides = (next: BudgetOverride[]) => {
    overridesRef.current = next;
    setOverridesState(next);
  };
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  // Latest commit per account: a failed save only rolls the account back if
  // no newer edit to it is queued (that one carries the full set anyway).
  const latestCommit = useRef(new Map<string, number>());
  const commitSeq = useRef(0);
  const [saving, setSaving] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Warn before leaving while typed figures are still saving.
  useEffect(() => {
    if (saving === 0) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [saving]);

  const categoryByAccount = useMemo(
    () => new Map(categoryEntries),
    [categoryEntries],
  );
  const realmCategories = useMemo(
    () => realmCategoryEntries.map((entries) => new Map(entries)),
    [realmCategoryEntries],
  );

  const { statement, variance } = useMemo(
    () =>
      assembleBudget({
        year,
        colDim,
        view,
        cls,
        closedThrough,
        companies,
        assumptions,
        baselineByRealm,
        realmCategories,
        actuals,
        approved,
        overrides,
        categoryByAccount,
      }),
    [
      assumptions,
      overrides,
      companies,
      baselineByRealm,
      realmCategories,
      actuals,
      approved,
      categoryByAccount,
      year,
      colDim,
      view,
      cls,
      closedThrough,
    ],
  );

  // The export carries the class and the growth rates on screen (saved or
  // not), so the file matches what the user is looking at.
  const onScreenRates = companies.map(
    (c) => assumptions[c.realmId] ?? zeroAssumption(c.realmId),
  );
  const exportHref = budgetExportHref({
    company,
    cls,
    cols: colDim,
    view,
    assumptions: onScreenRates,
  });

  // A download link rather than navigation, so an error response can't
  // replace the page and lose unsaved growth edits.
  const download = (href: string) => {
    const a = document.createElement("a");
    a.href = href;
    a.download = "";
    a.click();
  };

  // Company workbook: on All companies, one company's budget as its own file
  // — the same workbook that company's own view exports, carrying its rates
  // on screen and the class in view. With a class selected, only companies
  // that budget it are offered (another company's file would have nothing
  // in that class).
  const exportableCompanies =
    cls === null
      ? companies
      : companies.filter((c) => (classesByRealm[c.realmId] ?? []).includes(cls));
  const exportCompany = (realmId: string) =>
    download(
      budgetExportHref({
        company: realmId,
        cls,
        cols: colDim,
        view,
        assumptions: [assumptions[realmId] ?? zeroAssumption(realmId)],
      }),
    );

  // Class workbooks, for handing each class its budget: on All classes, one
  // class's budget for the companies in view as its own file — the same
  // workbook that class's own view exports — or every class at once as a
  // zip of those workbooks. Picker values are "zip" or a class's index, so
  // no class name can collide with the zip option.
  const exportClass = (value: string) => {
    const perClass = value === "zip";
    const one = perClass ? null : (classes[Number(value)] ?? null);
    if (!perClass && one === null) return;
    download(
      budgetExportHref({
        company,
        cls: one,
        cols: colDim,
        view,
        assumptions: onScreenRates,
        perClass,
      }),
    );
  };

  const colLabels = Object.fromEntries(
    statement.colKeys.map((k) => [k, budgetColLabel(colDim, k)]),
  );
  const hasBaseline = baselineByRealm.some((c) => c.length > 0);

  /* ---- Typing over account cells (one company, one class) ------------ */

  // On All companies an account row merges every company's account of that
  // name, and on All classes every class's, so a typed figure would have no
  // single home: editing needs one company and one class — the selected
  // class, or the company's only class.
  const editRealm =
    company !== "all" && companies.length === 1 && view === "budget"
      ? companies[0].realmId
      : null;
  const editClass: string | null =
    editRealm === null ? null : (cls ?? (classes.length <= 1 ? (classes[0] ?? NO_CLASS) : null));
  const canEdit = editRealm !== null && editClass !== null;
  const realmOverrides = useMemo(
    () =>
      editRealm && editClass !== null
        ? overrides.filter((o) => o.realm_id === editRealm && o.class_name === editClass)
        : [],
    [overrides, editRealm, editClass],
  );
  // Each account's budget per month in the class before initiatives — what a
  // field opens with, and the shape a typed Total re-spreads in. Keyed by
  // account (one class).
  const baseMonths = useMemo(() => {
    const out = new Map<string, AccountMonths>();
    if (!editRealm || editClass === null) return out;
    const grown = accountBaseMonths(
      (baselineByRealm[0] ?? []).filter((c) => c.class_name === editClass),
      assumptions[editRealm],
      realmCategories[0] ?? new Map(),
      realmOverrides,
    );
    for (const a of grown.values()) out.set(a.account, a);
    return out;
  }, [editRealm, editClass, baselineByRealm, assumptions, realmCategories, realmOverrides]);
  // Approved initiatives per account and month in the class, shown in cell
  // tooltips (they add on top of a typed figure).
  const initiativeMonths = useMemo(() => {
    const out = new Map<string, { classification: "Revenue" | "Expense"; months: number[] }>();
    if (!editRealm || editClass === null) return out;
    for (const i of approved) {
      if (i.realm_id !== editRealm || i.class_name !== editClass) continue;
      for (const l of i.lines) {
        let a = out.get(l.account_name);
        if (!a) out.set(l.account_name, (a = { classification: l.classification, months: Array(12).fill(0) }));
        spreadInitiativeLine(i, l.annual_amount).forEach((v, m) => (a.months[m] += v));
      }
    }
    return out;
  }, [editRealm, editClass, approved]);

  // Column key → budget month (1–12), "total", or null (a quarter: not
  // editable).
  const monthOf = (colKey: string): number | "total" | null => {
    if (colKey === "total") return "total";
    return colDim === "month" && /^\d{4}-\d{2}$/.test(colKey) ? Number(colKey.slice(5, 7)) : null;
  };

  const commitCell = (account: string, colKey: string, value: number | null) => {
    if (!editRealm || editClass === null) return;
    const at = monthOf(colKey);
    if (at === null) return;
    const base = baseMonths.get(account);
    const classification: "Revenue" | "Expense" =
      (base?.classification ?? initiativeMonths.get(account)?.classification) === "Revenue"
        ? "Revenue"
        : "Expense";
    const all = overridesRef.current;
    const isThis = (o: BudgetOverride) =>
      o.realm_id === editRealm && o.account === account && o.class_name === editClass;
    const previous = all.filter(isThis);
    const typed = new Map(previous.map((o) => [o.month, o.amount]));
    if (at === "total") {
      typed.clear();
      if (value !== null)
        respreadTotal(base?.months ?? Array(12).fill(0), value).forEach((v, m) =>
          typed.set(m + 1, v),
        );
    } else if (value === null) typed.delete(at);
    else typed.set(at, value);
    const next: BudgetOverride[] = [...typed].map(([month, amount]) => ({
      realm_id: editRealm,
      account,
      class_name: editClass,
      classification,
      month,
      amount,
    }));
    setOverrides([...all.filter((o) => !isThis(o)), ...next]);
    setSaveError(null);
    setSaving((n) => n + 1);
    const seq = ++commitSeq.current;
    const commitKey = `${editClass}\u0000${account}`;
    latestCommit.current.set(commitKey, seq);
    saveQueue.current = saveQueue.current.then(async () => {
      const result = await saveAccountOverrides({
        budgetYear: year,
        realmId: editRealm,
        account,
        className: editClass,
        classification,
        months: next.map(({ month, amount }) => ({ month, amount })),
      }).catch((e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : "Save failed",
      }));
      if (!result.ok) {
        // Put the account back the way it was before this edit — unless a
        // newer edit to it is queued — and say why.
        if (latestCommit.current.get(commitKey) === seq)
          setOverrides([
            ...overridesRef.current.filter((o) => !isThis(o)),
            ...previous,
          ]);
        setSaveError(`${account} not saved — ${result.error}`);
      }
      setSaving((n) => n - 1);
    });
  };

  const cellEditor: StatementCellEditor | undefined = canEdit
    ? {
        editable: (account, colKey) =>
          monthOf(colKey) !== null &&
          (baseMonths.has(account) || initiativeMonths.has(account)),
        value: (account, colKey) => {
          const at = monthOf(colKey);
          const months: number[] = baseMonths.get(account)?.months ?? [];
          if (at === "total") return months.reduce((s, v) => s + v, 0);
          return at === null ? 0 : (months[at - 1] ?? 0);
        },
        typed: (account, colKey) => {
          const at = monthOf(colKey);
          const t: boolean[] = baseMonths.get(account)?.typed ?? [];
          return at === "total" ? t.some(Boolean) : at !== null && !!t[at - 1];
        },
        title: (account, colKey) => {
          const at = monthOf(colKey);
          const ini = initiativeMonths.get(account)?.months ?? [];
          const plus =
            at === "total" ? ini.reduce((s, v) => s + v, 0) : at === null ? 0 : ini[at - 1];
          const iniNote =
            plus !== 0
              ? ` The cell also includes ${moneyWhole(plus)} from approved initiatives, which add on top of the figure you type.`
              : "";
          if (at === "total")
            return `Type an annual total to re-spread it across the months in their current shape. Clear it to return every month to the growth default.${iniNote}`;
          return (cellEditor!.typed(account, colKey)
            ? "Typed figure — growth % changes no longer move it. Clear the cell to return to the growth default."
            : "Click to type a budget figure for this month.") + iniNote;
        },
        commit: commitCell,
      }
    : undefined;

  const typedCount = realmOverrides.length;
  const classNote = editClass !== null && classes.length > 1 ? ` in ${editClass}` : "";
  const clearTyped = () => {
    if (!editRealm || editClass === null) return;
    if (
      !window.confirm(
        `Clear all ${typedCount} typed figure${typedCount === 1 ? "" : "s"} for this company${classNote}? Every account returns to its growth default.`,
      )
    )
      return;
    for (const account of new Set(realmOverrides.map((o) => o.account)))
      commitCell(account, "total", null);
  };

  return (
    <>
      <PageHeader
        title={title}
        subtitle={subtitle}
        action={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <a href={exportHref} className={buttonCls("secondary")}>
              <Download size={15} strokeWidth={2} />
              Export Excel
            </a>
            {company === "all" && companies.length > 1 && exportableCompanies.length > 0 && (
              <label
                className={`${buttonCls("secondary")} relative cursor-pointer`}
                title="Download one company's budget as its own Excel workbook"
              >
                <Building2 size={15} strokeWidth={2} />
                Export a company…
                {/* Invisible select over the button: picking a company
                    downloads its workbook, and the controlled value snaps
                    back so the same company can be picked again. */}
                <select
                  value=""
                  onChange={(e) => {
                    if (e.target.value) exportCompany(e.target.value);
                  }}
                  aria-label="Export one company's budget to Excel"
                  className="absolute inset-0 cursor-pointer opacity-0"
                >
                  <option value="" disabled>
                    Choose a company
                  </option>
                  {exportableCompanies.map((c) => (
                    <option key={c.realmId} value={c.realmId}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {cls === null && classes.length > 1 && (
              <label
                className={`${buttonCls("secondary")} relative cursor-pointer`}
                title="Download one class's budget as its own Excel workbook, or every class's as a zip — to hand each class its budget"
              >
                <Layers size={15} strokeWidth={2} />
                Export a class…
                {/* Same invisible-select pattern as Export a company…. */}
                <select
                  value=""
                  onChange={(e) => {
                    if (e.target.value) exportClass(e.target.value);
                  }}
                  aria-label="Export one class's budget to Excel"
                  className="absolute inset-0 cursor-pointer opacity-0"
                >
                  <option value="" disabled>
                    Choose a class
                  </option>
                  <option value="zip">Every class — one workbook each (.zip)</option>
                  {classes.map((c, i) => (
                    <option key={c} value={String(i)}>
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
        note={
          cls !== null
            ? `Growth rates are per company and apply to every class — changing one re-prices the whole company, not just ${cls}.`
            : undefined
        }
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
            value={moneyWhole(statement.netIncome.total)}
            hint={
              approvedNet !== 0
                ? `Includes ${moneyWhole(approvedNet)} from approved initiatives`
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
          <>
            <div
              className={`flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2 text-xs ${
                saveError
                  ? "border-bad-600/25 bg-bad-50 text-bad-600"
                  : "border-line/70 text-ink-500"
              }`}
              aria-live="polite"
            >
              <span>
                {saveError ??
                  (canEdit
                    ? colDim === "quarter"
                      ? `Click an account's Total to type an annual figure${classNote} (switch Columns to Months to type single months). Typed figures stay put when growth rates change; clear one to return to the growth default.`
                      : `Click an account's month or Total to type a budget figure${classNote}. Typed cells are highlighted and stay put when growth rates change; clear one to return to the growth default. A typed Total re-spreads in the months' current shape.`
                    : company === "all"
                      ? `Select a single company${cls === null && classes.length > 1 ? " and a class" : ""} to type budget figures into account cells.`
                      : editRealm
                        ? "Select a class to type budget figures into account cells — typed figures are kept per class."
                        : null)}
              </span>
              {canEdit && (
                <span className="flex items-center gap-3">
                  {saving > 0 ? (
                    <span className="flex items-center gap-1.5">
                      <Loader2 size={12} className="animate-spin" />
                      Saving…
                    </span>
                  ) : typedCount > 0 ? (
                    <span>
                      {typedCount} typed figure{typedCount === 1 ? "" : "s"} · saved
                    </span>
                  ) : null}
                  {typedCount > 0 && (
                    <button
                      type="button"
                      onClick={clearTyped}
                      disabled={saving > 0}
                      className={buttonCls("secondary", "sm")}
                    >
                      Clear typed figures
                    </button>
                  )}
                </span>
              )}
            </div>
            <StatementTable
              statement={statement}
              colLabels={colLabels}
              showRowTotal={colDim !== "total"}
              editor={cellEditor}
            />
          </>
        ) : variance ? (
          <VarianceTable
            statement={variance}
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
