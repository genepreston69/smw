"use client";

import { useEffect, useRef, useState } from "react";
import { saveAssumption } from "./actions";

interface CompanyAssumption {
  realmId: string;
  name: string;
  revenueGrowthPct: number;
  expenseGrowthPct: number;
}

const SAVE_DELAY_MS = 700;

/**
 * Per-company growth assumptions applied to the baseline: revenue accounts
 * by the revenue %, every expense account (direct costs included) by the
 * expense %. Edits re-price the budget immediately (onChange feeds the live
 * statement in BudgetWorkspace) and auto-save shortly after typing stops.
 */
export function AssumptionsEditor({
  budgetYear,
  companies,
  action,
  onChange,
}: {
  budgetYear: number;
  companies: CompanyAssumption[];
  /** Header control on the right (the New Initiative button). */
  action?: React.ReactNode;
  onChange: (realmId: string, revenueGrowthPct: number, expenseGrowthPct: number) => void;
}) {
  if (companies.length === 0) return null;
  return (
    <div className="mb-4 rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(13,36,56,0.05)]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/70 px-4 py-2.5">
        <h2 className="text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
          Growth assumptions
        </h2>
        {action}
      </div>
      <div className="divide-y divide-line/70">
        {companies.map((c) => (
          <AssumptionRow
            key={c.realmId}
            budgetYear={budgetYear}
            company={c}
            onChange={onChange}
          />
        ))}
      </div>
    </div>
  );
}

type SaveState = "idle" | "pending" | "saving" | "saved" | "error";

function AssumptionRow({
  budgetYear,
  company,
  onChange,
}: {
  budgetYear: number;
  company: CompanyAssumption;
  onChange: (realmId: string, revenueGrowthPct: number, expenseGrowthPct: number) => void;
}) {
  // Inputs stay as strings so "-", "" or "1." can be typed mid-edit.
  const [revenue, setRevenue] = useState(String(company.revenueGrowthPct));
  const [expense, setExpense] = useState(String(company.expenseGrowthPct));
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Only the latest save may report back, so a slow earlier save can't
  // overwrite a newer status.
  const seq = useRef(0);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const parse = (v: string): number | null => {
    if (v.trim() === "" || v.trim() === "-") return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const update = (nextRevenue: string, nextExpense: string) => {
    setRevenue(nextRevenue);
    setExpense(nextExpense);
    const r = parse(nextRevenue);
    const e = parse(nextExpense);
    if (r === null || e === null) return;
    if (r < -100 || r > 1000 || e < -100 || e > 1000) {
      setState("error");
      setError("Growth must be between -100% and 1000%");
      return;
    }
    onChange(company.realmId, r, e);

    setError(null);
    setState("pending");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const mine = ++seq.current;
      setState("saving");
      const result = await saveAssumption({
        budgetYear,
        realmId: company.realmId,
        revenueGrowthPct: r,
        expenseGrowthPct: e,
      });
      if (mine !== seq.current) return;
      if (result.ok) {
        setState("saved");
      } else {
        setState("error");
        setError(`Not saved: ${result.error}`);
      }
    }, SAVE_DELAY_MS);
  };

  const input = (
    label: string,
    value: string,
    onInput: (v: string) => void,
  ) => (
    <label className="flex items-center gap-2 text-sm text-ink-600">
      {label}
      <span className="relative">
        <input
          type="number"
          step="0.1"
          value={value}
          onChange={(e) => onInput(e.target.value)}
          className="w-24 rounded-md border border-line bg-white py-1 pr-6 pl-2 text-right text-sm tabular-nums text-ink-900 focus:border-brand-500"
        />
        <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-xs text-ink-400">
          %
        </span>
      </span>
    </label>
  );

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5">
      <span className="min-w-40 text-sm font-medium text-ink-900">{company.name}</span>
      {input("Revenue growth", revenue, (v) => update(v, expense))}
      {input("Expense growth", expense, (v) => update(revenue, v))}
      <span
        className={`text-xs ${state === "error" ? "text-bad-600" : "text-ink-400"}`}
        aria-live="polite"
      >
        {state === "pending" || state === "saving"
          ? "Saving…"
          : state === "saved"
            ? "Saved"
            : state === "error"
              ? error
              : ""}
      </span>
    </div>
  );
}
