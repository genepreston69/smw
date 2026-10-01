"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { buttonCls } from "@/components/ui";
import { saveAssumption } from "./actions";

interface CompanyAssumption {
  realmId: string;
  name: string;
  revenueGrowthPct: number;
  expenseGrowthPct: number;
}

/**
 * Per-company growth assumptions applied to the baseline: revenue accounts
 * by the revenue %, every expense account (direct costs included) by the
 * expense %. Each company row saves on its own.
 */
export function AssumptionsEditor({
  budgetYear,
  companies,
  action,
}: {
  budgetYear: number;
  companies: CompanyAssumption[];
  /** Header control on the right (the New Initiative button). */
  action?: React.ReactNode;
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
            key={`${c.realmId}:${c.revenueGrowthPct}:${c.expenseGrowthPct}`}
            budgetYear={budgetYear}
            company={c}
          />
        ))}
      </div>
    </div>
  );
}

function AssumptionRow({
  budgetYear,
  company,
}: {
  budgetYear: number;
  company: CompanyAssumption;
}) {
  const router = useRouter();
  const [revenue, setRevenue] = useState(String(company.revenueGrowthPct));
  const [expense, setExpense] = useState(String(company.expenseGrowthPct));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const dirty =
    Number(revenue) !== company.revenueGrowthPct ||
    Number(expense) !== company.expenseGrowthPct;

  const save = () => {
    setError(null);
    startTransition(async () => {
      const result = await saveAssumption({
        budgetYear,
        realmId: company.realmId,
        revenueGrowthPct: revenue === "" ? 0 : revenue,
        expenseGrowthPct: expense === "" ? 0 : expense,
      });
      if (result.ok) router.refresh();
      else setError(result.error);
    });
  };

  const input = (
    label: string,
    value: string,
    onChange: (v: string) => void,
  ) => (
    <label className="flex items-center gap-2 text-sm text-ink-600">
      {label}
      <span className="relative">
        <input
          type="number"
          step="0.1"
          value={value}
          disabled={pending}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && dirty) save();
          }}
          className="w-24 rounded-md border border-line bg-white py-1 pr-6 pl-2 text-right text-sm tabular-nums text-ink-900 focus:border-brand-500 disabled:opacity-60"
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
      {input("Revenue growth", revenue, setRevenue)}
      {input("Expense growth", expense, setExpense)}
      <button
        type="button"
        onClick={save}
        disabled={!dirty || pending}
        className={buttonCls("secondary", "sm")}
      >
        {pending ? "Saving…" : "Save"}
      </button>
      {error && <span className="text-xs text-bad-600">{error}</span>}
    </div>
  );
}
