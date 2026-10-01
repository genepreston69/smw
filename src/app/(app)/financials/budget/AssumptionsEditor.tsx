"use client";

import { useEffect, useState, useTransition } from "react";
import { buttonCls } from "@/components/ui";
import { saveAssumption } from "./actions";

interface CompanyAssumption {
  realmId: string;
  name: string;
  revenueGrowthPct: number;
  expenseGrowthPct: number;
}

type Draft = Record<string, { revenue: string; expense: string }>;

const toDraft = (companies: CompanyAssumption[]): Draft =>
  Object.fromEntries(
    companies.map((c) => [
      c.realmId,
      { revenue: String(c.revenueGrowthPct), expense: String(c.expenseGrowthPct) },
    ]),
  );

/** "", "-" → 0; anything non-numeric → null. */
const parse = (v: string): number | null => {
  const t = v.trim();
  if (t === "" || t === "-") return 0;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

const inRange = (n: number) => n >= -100 && n <= 1000;

/**
 * Per-company growth assumptions applied to the baseline: revenue accounts
 * by the revenue %, every expense account (direct costs included) by the
 * expense %. Edits re-price the budget immediately (onChange feeds the live
 * statement in BudgetWorkspace) but are only stored when the user chooses
 * Save changes; Revert restores the saved values and Reset to baseline
 * zeroes every growth % (still to be saved).
 */
export function AssumptionsEditor({
  budgetYear,
  companies,
  action,
  onChange,
}: {
  budgetYear: number;
  /** Saved assumptions per company. */
  companies: CompanyAssumption[];
  /** Header control on the right (the New Initiative button). */
  action?: React.ReactNode;
  onChange: (realmId: string, revenueGrowthPct: number, expenseGrowthPct: number) => void;
}) {
  const [saved, setSaved] = useState<Draft>(() => toDraft(companies));
  const [draft, setDraft] = useState<Draft>(() => toDraft(companies));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const changed = companies.filter((c) => {
    const d = draft[c.realmId];
    const s = saved[c.realmId];
    return parse(d.revenue) !== parse(s.revenue) || parse(d.expense) !== parse(s.expense);
  });
  const dirty = changed.length > 0;
  const atBaseline = companies.every(
    (c) => parse(draft[c.realmId].revenue) === 0 && parse(draft[c.realmId].expense) === 0,
  );

  // Warn before leaving the page with unsaved assumptions.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // Push a whole draft into the live statement.
  const apply = (next: Draft) => {
    setDraft(next);
    for (const c of companies) {
      const r = parse(next[c.realmId].revenue);
      const e = parse(next[c.realmId].expense);
      if (r !== null && e !== null) onChange(c.realmId, r, e);
    }
  };

  const edit = (realmId: string, field: "revenue" | "expense", value: string) => {
    setError(null);
    setNotice(null);
    const next = { ...draft, [realmId]: { ...draft[realmId], [field]: value } };
    setDraft(next);
    const r = parse(next[realmId].revenue);
    const e = parse(next[realmId].expense);
    if (r !== null && e !== null) onChange(realmId, r, e);
  };

  const revert = () => {
    setError(null);
    setNotice(null);
    apply(saved);
  };

  const resetToBaseline = () => {
    setError(null);
    setNotice(null);
    apply(
      Object.fromEntries(
        companies.map((c) => [c.realmId, { revenue: "0", expense: "0" }]),
      ),
    );
  };

  const save = () => {
    setError(null);
    setNotice(null);
    for (const c of changed) {
      const r = parse(draft[c.realmId].revenue);
      const e = parse(draft[c.realmId].expense);
      if (r === null || e === null || !inRange(r) || !inRange(e)) {
        setError(`${c.name}: growth must be a number between -100% and 1000%`);
        return;
      }
    }
    startTransition(async () => {
      const results = await Promise.all(
        changed.map((c) =>
          saveAssumption({
            budgetYear,
            realmId: c.realmId,
            revenueGrowthPct: parse(draft[c.realmId].revenue)!,
            expenseGrowthPct: parse(draft[c.realmId].expense)!,
          }).then((result) => ({ c, result })),
        ),
      );
      // Rows that saved become the new saved state even if another failed.
      const next = { ...saved };
      const failures: string[] = [];
      for (const { c, result } of results) {
        if (result.ok) next[c.realmId] = draft[c.realmId];
        else failures.push(`${c.name}: ${result.error}`);
      }
      setSaved(next);
      if (failures.length > 0) setError(`Not saved — ${failures.join("; ")}`);
      else setNotice("Changes saved");
    });
  };

  if (companies.length === 0) return null;

  const input = (realmId: string, field: "revenue" | "expense", label: string) => {
    const value = draft[realmId][field];
    const n = parse(value);
    const invalid = n === null || !inRange(n);
    const isChanged = n !== parse(saved[realmId][field]);
    return (
      <label className="flex items-center gap-2 text-sm text-ink-600">
        {label}
        <span className="relative">
          <input
            type="number"
            step="0.1"
            value={value}
            disabled={pending}
            onChange={(e) => edit(realmId, field, e.target.value)}
            className={`w-24 rounded-md border py-1 pr-6 pl-2 text-right text-sm tabular-nums text-ink-900 disabled:opacity-60 ${
              invalid
                ? "border-bad-600/60 bg-white"
                : isChanged
                  ? "border-warn-700/50 bg-amber-50"
                  : "border-line bg-white focus:border-brand-500"
            }`}
          />
          <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-xs text-ink-400">
            %
          </span>
        </span>
      </label>
    );
  };

  return (
    <div className="mb-4 rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(13,36,56,0.05)]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/70 px-4 py-2.5">
        <h2 className="text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
          Growth assumptions
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={resetToBaseline}
            disabled={pending || atBaseline}
            className={buttonCls("secondary", "sm")}
            title="Set every growth % to 0 so the budget equals the baseline actuals"
          >
            Reset to baseline
          </button>
          {action}
        </div>
      </div>
      <div className="divide-y divide-line/70">
        {companies.map((c) => (
          <div
            key={c.realmId}
            className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5"
          >
            <span className="min-w-40 text-sm font-medium text-ink-900">{c.name}</span>
            {input(c.realmId, "revenue", "Revenue growth")}
            {input(c.realmId, "expense", "Expense growth")}
          </div>
        ))}
      </div>
      {(dirty || error || notice) && (
        <div
          className={`flex flex-wrap items-center justify-between gap-3 border-t px-4 py-2.5 text-sm ${
            error
              ? "border-bad-600/25 bg-bad-50 text-bad-600"
              : dirty
                ? "border-warn-700/25 bg-amber-50 text-amber-800"
                : "border-ok-600/25 bg-ok-50 text-ok-600"
          }`}
          aria-live="polite"
        >
          <span>
            {error ??
              (dirty
                ? `Unsaved changes for ${changed.map((c) => c.name).join(", ")} — the budget below reflects them. Save changes or revert?`
                : notice)}
          </span>
          {dirty && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={revert}
                disabled={pending}
                className={buttonCls("secondary", "sm")}
              >
                Revert
              </button>
              <button
                type="button"
                onClick={save}
                disabled={pending}
                className={buttonCls("primary", "sm")}
              >
                {pending ? "Saving…" : "Save changes"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
