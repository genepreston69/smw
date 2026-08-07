"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";

/**
 * Search box + QB company dropdown for the jobs dashboard. Both write URL
 * search params (`q`, `company`) so the server component filters the rows —
 * the search input is debounced so the URL isn't replaced on every keystroke.
 */
export function JobsFilters({
  q,
  company,
  companies,
}: {
  q: string;
  company: string;
  companies: { realmId: string; name: string }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [value, setValue] = useState(q);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Last q this component itself pushed into the URL, so an external change
  // (e.g. the "Clear filters" link) resyncs the input without a stale prop
  // clobbering text the user is still typing.
  const lastApplied = useRef(q);

  useEffect(() => {
    if (q !== lastApplied.current) {
      lastApplied.current = q;
      setValue(q);
    }
  }, [q]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const apply = (next: { q?: string; company?: string }) => {
    const params = new URLSearchParams(searchParams);
    for (const [key, val] of Object.entries(next)) {
      if (val) params.set(key, val);
      else params.delete(key);
    }
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const onSearch = (text: string) => {
    setValue(text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      lastApplied.current = text.trim();
      apply({ q: text.trim() });
    }, 300);
  };

  const clearSearch = () => {
    if (timer.current) clearTimeout(timer.current);
    setValue("");
    lastApplied.current = "";
    apply({ q: "" });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative">
        <Search
          size={14}
          strokeWidth={2}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400"
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && value) clearSearch();
          }}
          placeholder="Search jobs…"
          aria-label="Search jobs"
          className="w-64 rounded-lg border border-line bg-white py-2 pl-8 pr-8 text-sm text-ink-900 placeholder:text-ink-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
        />
        {value && (
          <button
            onClick={clearSearch}
            title="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-ink-400 transition-colors hover:text-ink-900"
          >
            <X size={14} strokeWidth={2} />
          </button>
        )}
      </div>
      {companies.length > 1 && (
        <select
          value={company}
          onChange={(e) => apply({ company: e.target.value })}
          aria-label="Filter by QB company"
          className="rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
        >
          <option value="">All companies</option>
          {companies.map((c) => (
            <option key={c.realmId} value={c.realmId}>
              {c.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
