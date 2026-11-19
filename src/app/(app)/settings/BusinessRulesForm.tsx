"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { buttonCls } from "@/components/ui";
import type { AppSettings, NumberedAccount } from "@/lib/appSettings";
import { saveBusinessRules } from "./actions";

// Admin editor for the business rules that used to be constants in the code
// (public.app_settings, migration 0041). Lists are edited one entry per line.

const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** "710 Labor Cost" lines → numbered accounts, or the first line that
    doesn't start with an account number. */
const parseNumbered = (
  text: string,
): { accounts: NumberedAccount[] } | { bad: string } => {
  const accounts: NumberedAccount[] = [];
  for (const label of lines(text)) {
    const number = /^\d+/.exec(label)?.[0];
    if (!number) return { bad: label };
    accounts.push({ number, label });
  }
  return { accounts };
};

// The EBITDA lists, in the order they appear on the Income Statement, then
// the exclusions.
const EBITDA_FIELDS = [
  { key: "interest", label: "Interest" },
  { key: "taxes", label: "Income taxes" },
  { key: "depreciation", label: "Depreciation" },
  { key: "amortization", label: "Amortization" },
  { key: "exclude", label: "Never add back" },
] as const;
type EbitdaListKey = (typeof EBITDA_FIELDS)[number]["key"];

const fieldCls =
  "w-full rounded-md border border-line bg-white px-3 py-1.5 text-sm text-ink-900";
const labelCls = "mb-1 block text-sm font-medium text-ink-900";
const hintCls = "mt-1 text-xs text-ink-600";

export function BusinessRulesForm({ settings }: { settings: AppSettings }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [budgetYear, setBudgetYear] = useState(String(settings.budgetYear));
  const [accounts, setAccounts] = useState(
    settings.benefitBaseAccounts.map((a) => a.label).join("\n"),
  );
  const [phrases, setPhrases] = useState(settings.intercompany.phrases.join("\n"));
  const [acronyms, setAcronyms] = useState(settings.intercompany.acronyms.join("\n"));
  const [ebitdaAuto, setEbitdaAuto] = useState(settings.ebitdaAddBacks.automatic);
  const [ebitdaLists, setEbitdaLists] = useState(
    () =>
      Object.fromEntries(
        EBITDA_FIELDS.map((f) => [
          f.key,
          settings.ebitdaAddBacks[f.key].map((a) => a.label).join("\n"),
        ]),
      ) as Record<EbitdaListKey, string>,
  );
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  function save() {
    setMessage(null);
    // Each account line starts with its number: "710 Labor Cost".
    const benefit = parseNumbered(accounts);
    if ("bad" in benefit) {
      setMessage({
        ok: false,
        text: `"${benefit.bad}" must start with the account number, like "710 Labor Cost".`,
      });
      return;
    }
    const ebitda = {} as Record<EbitdaListKey, NumberedAccount[]>;
    const listOf = new Map<string, string>();
    for (const f of EBITDA_FIELDS) {
      const parsed = parseNumbered(ebitdaLists[f.key]);
      if ("bad" in parsed) {
        setMessage({
          ok: false,
          text: `EBITDA ${f.label}: "${parsed.bad}" must start with the account number, like "960 Interest Expense".`,
        });
        return;
      }
      for (const a of parsed.accounts) {
        const other = listOf.get(a.number);
        if (other) {
          setMessage({
            ok: false,
            text: `Account ${a.number} is under both ${other} and ${f.label}. An account can be in only one EBITDA list.`,
          });
          return;
        }
        listOf.set(a.number, f.label);
      }
      ebitda[f.key] = parsed.accounts;
    }
    startTransition(async () => {
      const result = await saveBusinessRules({
        budgetYear: Number(budgetYear),
        benefitBaseAccounts: benefit.accounts,
        intercompany: { phrases: lines(phrases), acronyms: lines(acronyms) },
        ebitdaAddBacks: { automatic: ebitdaAuto, ...ebitda },
      });
      if (result.ok) {
        setMessage({ ok: true, text: "Saved. Every page now uses these rules." });
        router.refresh();
      } else {
        setMessage({ ok: false, text: result.error });
      }
    });
  }

  return (
    <div className="space-y-5">
      <div>
        <label htmlFor="rule-budget-year" className={labelCls}>
          Budget year
        </label>
        <input
          id="rule-budget-year"
          inputMode="numeric"
          value={budgetYear}
          onChange={(e) => setBudgetYear(e.target.value)}
          className={`${fieldCls} max-w-32`}
        />
        <p className={hintCls}>
          The calendar year the Budget page builds. Its baseline is the twelve
          months ending June 30 of the year before. Growth rates, typed figures
          and initiatives are kept per year, so switching years doesn&rsquo;t
          lose the other year&rsquo;s work.
        </p>
      </div>

      <div>
        <label htmlFor="rule-benefit-accounts" className={labelCls}>
          Cost of Benefits: accounts in the denominator
        </label>
        <textarea
          id="rule-benefit-accounts"
          rows={4}
          value={accounts}
          onChange={(e) => setAccounts(e.target.value)}
          className={fieldCls}
        />
        <p className={hintCls}>
          One per line, starting with the account number (for example
          &ldquo;710 Labor Cost&rdquo;). Benefit rate = Employee Benefits ÷ the
          sum of these accounts and their sub-accounts.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="rule-sister-names" className={labelCls}>
            Sister companies: names
          </label>
          <textarea
            id="rule-sister-names"
            rows={4}
            value={phrases}
            onChange={(e) => setPhrases(e.target.value)}
            className={fieldCls}
          />
          <p className={hintCls}>
            One per line. A customer whose name contains one of these is
            intercompany work.
          </p>
        </div>
        <div>
          <label htmlFor="rule-sister-acronyms" className={labelCls}>
            Sister companies: abbreviations
          </label>
          <textarea
            id="rule-sister-acronyms"
            rows={4}
            value={acronyms}
            onChange={(e) => setAcronyms(e.target.value)}
            className={fieldCls}
          />
          <p className={hintCls}>
            One per line, letters and digits only. Matched as a whole word, so
            &ldquo;smw&rdquo; matches &ldquo;SMW LLC&rdquo; but not a longer word.
          </p>
        </div>
      </div>

      <fieldset>
        <legend className={labelCls}>Income Statement: EBITDA add-backs</legend>
        <label className="flex items-start gap-2 text-sm text-ink-900">
          <input
            type="checkbox"
            checked={ebitdaAuto}
            onChange={(e) => setEbitdaAuto(e.target.checked)}
            className="mt-1"
          />
          <span>
            Find add-backs automatically
            <span className="block text-xs text-ink-600">
              An expense account counts when its QuickBooks detail type is
              Interest Paid, Income Tax Expense, Depreciation or Amortization,
              or, when the detail type is a generic one, when its name says
              interest, income tax, depreciation or amortization. Payroll,
              property and sales taxes (detail type Taxes Paid) are never
              picked.
            </span>
          </span>
        </label>
        <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {EBITDA_FIELDS.map((f) => (
            <div key={f.key}>
              <label
                htmlFor={`rule-ebitda-${f.key}`}
                className="mb-1 block text-xs font-medium text-ink-900"
              >
                {f.label}
              </label>
              <textarea
                id={`rule-ebitda-${f.key}`}
                rows={3}
                value={ebitdaLists[f.key]}
                onChange={(e) =>
                  setEbitdaLists((prev) => ({ ...prev, [f.key]: e.target.value }))
                }
                className={fieldCls}
              />
            </div>
          ))}
        </div>
        <p className={hintCls}>
          One per line, starting with the account number (for example
          &ldquo;960 Interest Expense&rdquo;); sub-accounts count with their
          parent. A listed account is always added back under its line, with
          or without the automatic search, and &ldquo;Never add back&rdquo;
          keeps an account the automatic search picked inside EBITDA. Expand
          each add-back on the Income Statement to check its accounts.
        </p>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <button onClick={save} disabled={pending} className={buttonCls("primary")}>
          {pending ? "Saving…" : "Save business rules"}
        </button>
        {message && (
          <span
            role="status"
            className={`text-sm ${message.ok ? "text-ok-600" : "text-bad-600"}`}
          >
            {message.text}
          </span>
        )}
      </div>
    </div>
  );
}
