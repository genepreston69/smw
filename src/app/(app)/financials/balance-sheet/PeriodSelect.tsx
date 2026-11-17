"use client";

import { useRouter } from "next/navigation";

/** The Balance Sheet's month-end dropdown; each option is its own page URL. */
export function PeriodSelect({
  value,
  options,
}: {
  value: string;
  options: { value: string; label: string; href: string }[];
}) {
  const router = useRouter();
  return (
    <select
      aria-label="As of"
      value={value}
      onChange={(e) => {
        const opt = options.find((o) => o.value === e.target.value);
        if (opt) router.push(opt.href);
      }}
      className="min-w-56 rounded-md border border-line bg-white px-3 py-1 text-sm text-ink-900"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
