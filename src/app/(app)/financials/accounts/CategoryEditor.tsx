"use client";

import { useState, useTransition } from "react";
import { setAccountCategory } from "./actions";

/**
 * Inline Category editor for one chart-of-accounts row. Free text with a
 * shared <datalist> of categories already in use (rendered once by the page,
 * id passed in), saving on blur or Enter when the value changed.
 */
export function CategoryEditor({
  accountId,
  category,
  listId,
}: {
  accountId: string;
  category: string | null;
  listId: string;
}) {
  const [saved, setSaved] = useState(category ?? "");
  const [value, setValue] = useState(category ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const save = () => {
    const next = value.trim();
    if (next === saved) return;
    setError(null);
    startTransition(async () => {
      const result = await setAccountCategory(accountId, next);
      if (result.ok) {
        setSaved(next);
        setValue(next);
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <div>
      <input
        type="text"
        list={listId}
        value={value}
        placeholder="—"
        maxLength={80}
        disabled={pending}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setValue(saved);
        }}
        className={`w-44 rounded-md border bg-white px-2 py-1 text-sm text-ink-900 transition-colors placeholder:text-ink-400 disabled:opacity-60 ${
          error ? "border-bad-600/60" : "border-line focus:border-brand-500"
        }`}
      />
      {error && <p className="mt-0.5 text-xs text-bad-600">{error}</p>}
    </div>
  );
}
