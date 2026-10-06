"use client";

import { useEffect, useState, useTransition } from "react";
import { buttonCls } from "@/components/ui";
import {
  emptyCategoryGrowth,
  sameAssumption,
  type BudgetAssumption,
  type GrowthCategory,
  type GrowthClass,
} from "@/lib/budget";
import { saveAssumption } from "./actions";

/** Text in the fields, per company. Category cells are keyed by
    `${classification}:${category}`; "" means "use the default". */
interface CompanyDraft {
  revenue: string;
  expense: string;
  categories: Record<string, string>;
}

type Draft = Record<string, CompanyDraft>;

const cellKey = (classification: GrowthClass, category: string) =>
  `${classification}:${category}`;

const toCompanyDraft = (a: BudgetAssumption): CompanyDraft => {
  const categories: Record<string, string> = {};
  for (const cls of ["Revenue", "Expense"] as const)
    for (const [category, pct] of Object.entries(a.category_growth[cls]))
      categories[cellKey(cls, category)] = String(pct);
  return {
    revenue: String(a.revenue_growth_pct),
    expense: String(a.expense_growth_pct),
    categories,
  };
};

/** Field text without the "%" or spaces people may type. */
const clean = (v: string) => v.replace(/[\s%]/g, "");

/** Default fields: "", "-" → 0; anything non-numeric → null. */
const parse = (v: string): number | null => {
  const t = clean(v);
  if (t === "" || t === "-") return 0;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/** Category fields: "", "-" → "default"; anything non-numeric → null. */
const parseCategory = (v: string | undefined): number | "default" | null => {
  const t = clean(v ?? "");
  if (t === "" || t === "-") return "default";
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

const inRange = (n: number) => n >= -100 && n <= 1000;

/** The assumption a company's fields describe, or null while any field is
    not a number in range. */
const fromCompanyDraft = (realmId: string, d: CompanyDraft): BudgetAssumption | null => {
  const r = parse(d.revenue);
  const e = parse(d.expense);
  if (r === null || e === null || !inRange(r) || !inRange(e)) return null;
  const category_growth = emptyCategoryGrowth();
  for (const [key, value] of Object.entries(d.categories)) {
    const n = parseCategory(value);
    if (n === null) return null;
    if (n === "default") continue;
    if (!inRange(n)) return null;
    const split = key.indexOf(":");
    category_growth[key.slice(0, split) as GrowthClass][key.slice(split + 1)] = n;
  }
  return { realm_id: realmId, revenue_growth_pct: r, expense_growth_pct: e, category_growth };
};

/**
 * Per-company growth assumptions applied to the baseline, as a grid of
 * categories × companies. Each account grows at its category's rate for its
 * company; a blank category cell — and any uncategorized account — uses the
 * company's default revenue or expense rate (the first two rows). Edits
 * re-price the budget immediately (onChange feeds the live statement in
 * BudgetWorkspace) but are only stored when the user chooses Save changes;
 * Revert restores the saved values and Reset to baseline zeroes the defaults
 * and clears every category rate (still to be saved).
 */
export function AssumptionsEditor({
  budgetYear,
  companies,
  initial,
  categories,
  action,
  note,
  onChange,
}: {
  budgetYear: number;
  companies: { realmId: string; name: string }[];
  /** Saved assumptions, one per company. */
  initial: BudgetAssumption[];
  /** Category rows, in display order. */
  categories: GrowthCategory[];
  /** Header control on the right (the New Initiative button). */
  action?: React.ReactNode;
  /** Extra line under the description (e.g. that rates span every class). */
  note?: string;
  onChange: (assumption: BudgetAssumption) => void;
}) {
  const [saved, setSaved] = useState<Record<string, BudgetAssumption>>(() =>
    Object.fromEntries(initial.map((a) => [a.realm_id, a])),
  );
  const [draft, setDraft] = useState<Draft>(() =>
    Object.fromEntries(initial.map((a) => [a.realm_id, toCompanyDraft(a)])),
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const changed = companies.filter((c) => {
    const next = fromCompanyDraft(c.realmId, draft[c.realmId]);
    return next === null || !sameAssumption(next, saved[c.realmId]);
  });
  const dirty = changed.length > 0;
  const atBaseline = companies.every((c) => {
    const d = draft[c.realmId];
    return (
      parse(d.revenue) === 0 &&
      parse(d.expense) === 0 &&
      Object.values(d.categories).every((v) => {
        const n = parseCategory(v);
        return n === "default" || n === 0;
      })
    );
  });

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
      const a = fromCompanyDraft(c.realmId, next[c.realmId]);
      if (a) onChange(a);
    }
  };

  const edit = (realmId: string, patch: Partial<CompanyDraft>) => {
    setError(null);
    setNotice(null);
    const company = { ...draft[realmId], ...patch };
    setDraft({ ...draft, [realmId]: company });
    const a = fromCompanyDraft(realmId, company);
    if (a) onChange(a);
  };

  const revert = () => {
    setError(null);
    setNotice(null);
    apply(
      Object.fromEntries(companies.map((c) => [c.realmId, toCompanyDraft(saved[c.realmId])])),
    );
  };

  const resetToBaseline = () => {
    setError(null);
    setNotice(null);
    apply(
      Object.fromEntries(
        companies.map((c) => [c.realmId, { revenue: "0", expense: "0", categories: {} }]),
      ),
    );
  };

  const save = () => {
    setError(null);
    setNotice(null);
    const next: { name: string; assumption: BudgetAssumption }[] = [];
    for (const c of changed) {
      const a = fromCompanyDraft(c.realmId, draft[c.realmId]);
      if (!a) {
        setError(`${c.name}: growth must be a number between -100% and 1000%`);
        return;
      }
      next.push({ name: c.name, assumption: a });
    }
    startTransition(async () => {
      const results = await Promise.all(
        next.map(({ name, assumption: a }) =>
          saveAssumption({
            budgetYear,
            realmId: a.realm_id,
            revenueGrowthPct: a.revenue_growth_pct,
            expenseGrowthPct: a.expense_growth_pct,
            categories: (["Revenue", "Expense"] as const).flatMap((cls) =>
              Object.entries(a.category_growth[cls]).map(([category, growthPct]) => ({
                classification: cls,
                category,
                growthPct,
              })),
            ),
          }).then((result) => ({ name, a, result })),
        ),
      );
      // Companies that saved become the new saved state even if another failed.
      const nextSaved = { ...saved };
      const failures: string[] = [];
      for (const { name, a, result } of results) {
        if (result.ok) nextSaved[a.realm_id] = a;
        else failures.push(`${name}: ${result.error}`);
      }
      setSaved(nextSaved);
      if (failures.length > 0) setError(`Not saved — ${failures.join("; ")}`);
      else setNotice("Changes saved");
    });
  };

  if (companies.length === 0) return null;

  const inputCls = (invalid: boolean, isChanged: boolean) =>
    `w-24 rounded-md border py-1 pr-6 pl-2 text-right text-sm tabular-nums text-ink-900 placeholder:text-ink-400 disabled:opacity-60 ${
      invalid
        ? "border-bad-600/60 bg-white"
        : isChanged
          ? "border-warn-700/50 bg-amber-50"
          : "border-line bg-white focus:border-brand-500"
    }`;

  const pctInput = (
    label: string,
    value: string,
    placeholder: string | undefined,
    invalid: boolean,
    isChanged: boolean,
    onInput: (value: string) => void,
  ) => (
    <span className="relative inline-block">
      {/* Plain text, not type="number": no spinner arrows — type the exact
          percentage (4.75, -2, 5%). */}
      <input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        aria-label={label}
        disabled={pending}
        onChange={(e) => onInput(e.target.value)}
        className={inputCls(invalid, isChanged)}
      />
      <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-xs text-ink-400">
        %
      </span>
    </span>
  );

  const defaultCell = (realmId: string, field: "revenue" | "expense", label: string) => {
    const value = draft[realmId][field];
    const n = parse(value);
    const s = saved[realmId];
    const savedValue = field === "revenue" ? s.revenue_growth_pct : s.expense_growth_pct;
    return pctInput(label, value, undefined, n === null || !inRange(n), n !== savedValue, (v) =>
      edit(realmId, field === "revenue" ? { revenue: v } : { expense: v }),
    );
  };

  const categoryCell = (realmId: string, row: GrowthCategory, label: string) => {
    const d = draft[realmId];
    const key = cellKey(row.classification, row.category);
    const value = d.categories[key] ?? "";
    const n = parseCategory(value);
    const rates = saved[realmId].category_growth[row.classification];
    const savedValue = Object.hasOwn(rates, row.category) ? rates[row.category] : "default";
    const fallback = parse(row.classification === "Revenue" ? d.revenue : d.expense);
    return pctInput(
      label,
      value,
      fallback === null ? undefined : String(fallback),
      n === null || (n !== "default" && !inRange(n)),
      n !== savedValue,
      (v) => edit(realmId, { categories: { ...d.categories, [key]: v } }),
    );
  };

  const sections: { label: string; rows: GrowthCategory[] }[] = [
    {
      label: "Income categories",
      rows: categories.filter((r) => r.classification === "Revenue"),
    },
    { label: "Direct cost categories", rows: categories.filter((r) => r.direct) },
    {
      label: "Expense categories",
      rows: categories.filter((r) => r.classification === "Expense" && !r.direct),
    },
  ].filter((s) => s.rows.length > 0);

  const sectionRow = (label: string) => (
    <tr key={`section-${label}`} className="bg-surface/60">
      <th
        colSpan={companies.length + 1}
        scope="colgroup"
        className="px-4 pt-2.5 pb-1 text-left text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-ink-400"
      >
        {label}
      </th>
    </tr>
  );

  return (
    <div className="mb-4 rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(13,36,56,0.05)]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/70 px-4 py-2.5">
        <div>
          <h2 className="text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
            Growth assumptions
          </h2>
          <p className="mt-0.5 text-xs text-ink-400">
            Each account grows at its category&rsquo;s rate. A blank category
            uses the company default shown in grey, and so does any
            uncategorized account.
          </p>
          {note && <p className="mt-0.5 text-xs font-medium text-amber-700">{note}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={resetToBaseline}
            disabled={pending || atBaseline}
            className={buttonCls("secondary", "sm")}
            title="Set every default to 0% and clear every category rate so the budget equals the baseline actuals"
          >
            Reset to baseline
          </button>
          {action}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line/70">
              <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-ink-400">
                Category
              </th>
              {companies.map((c) => (
                <th
                  key={c.realmId}
                  scope="col"
                  className="max-w-40 truncate px-4 py-2 text-right text-xs font-medium text-ink-600"
                  title={c.name}
                >
                  {c.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line/50">
            {sectionRow("Company defaults")}
            {(
              [
                ["revenue", "All revenue", "Revenue default"],
                ["expense", "All expenses", "Expense default"],
              ] as const
            ).map(([field, label, aria]) => (
              <tr key={field}>
                <th scope="row" className="px-4 py-1.5 text-left font-medium text-ink-900">
                  {label}
                </th>
                {companies.map((c) => (
                  <td key={c.realmId} className="px-4 py-1.5 text-right">
                    {defaultCell(c.realmId, field, `${c.name} ${aria}`)}
                  </td>
                ))}
              </tr>
            ))}
            {sections.flatMap((s) => [
              sectionRow(s.label),
              ...s.rows.map((row) => (
                <tr key={cellKey(row.classification, row.category)}>
                  <th scope="row" className="px-4 py-1.5 text-left font-normal text-ink-600">
                    {row.category}
                  </th>
                  {companies.map((c) => (
                    <td key={c.realmId} className="px-4 py-1.5 text-right">
                      {row.realms.includes(c.realmId) ? (
                        categoryCell(c.realmId, row, `${c.name} ${row.category}`)
                      ) : (
                        <span
                          className="inline-block w-24 pr-6 text-right text-ink-400"
                          title={`${c.name} has no accounts in ${row.category}`}
                        >
                          —
                        </span>
                      )}
                    </td>
                  ))}
                </tr>
              )),
            ])}
          </tbody>
        </table>
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
