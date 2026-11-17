"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { buttonCls } from "@/components/ui";
import type { AppSettings } from "@/lib/appSettings";
import { saveBusinessRules } from "./actions";

// Admin editor for the business rules that used to be constants in the code
// (public.app_settings, migration 0041). Lists are edited one entry per line.

const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

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
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  function save() {
    setMessage(null);
    // Each account line starts with its number: "710 Labor Cost".
    const parsedAccounts: { number: string; label: string }[] = [];
    for (const label of lines(accounts)) {
      const number = /^\d+/.exec(label)?.[0];
      if (!number) {
        setMessage({
          ok: false,
          text: `"${label}" must start with the account number, like "710 Labor Cost".`,
        });
        return;
      }
      parsedAccounts.push({ number, label });
    }
    startTransition(async () => {
      const result = await saveBusinessRules({
        budgetYear: Number(budgetYear),
        benefitBaseAccounts: parsedAccounts,
        intercompany: { phrases: lines(phrases), acronyms: lines(acronyms) },
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
