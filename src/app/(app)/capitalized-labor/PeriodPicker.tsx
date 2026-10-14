import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { buttonCls } from "@/components/ui";
import { monthLabel } from "@/lib/financials";
import {
  capLaborHref,
  capLaborMonthBounds,
  capLaborYears,
  shiftMonth,
  type CapLaborPeriodParams,
  type CapLaborWindow,
} from "@/lib/capitalizedLabor";

/**
 * Period filter shared by both Capitalized Labor pages: a pill per calendar
 * year, one month (stepping back and forth), or a from/to month range. Plain
 * links and GET forms — the URL is the state and capLaborPeriod parses it,
 * so the page, its drill-down, and its exports all see the same window.
 * `keep` carries the page's other params (the dashboard's tab) through.
 */
export function PeriodPicker({
  path,
  period,
  keep = {},
}: {
  path: string;
  period: CapLaborWindow;
  keep?: Record<string, string | null | undefined>;
}) {
  const years = capLaborYears();
  const { min, max } = capLaborMonthBounds();
  const href = (params: CapLaborPeriodParams) => capLaborHref(path, params, keep);
  const hidden = Object.entries(keep).map(([k, v]) =>
    v ? <input key={k} type="hidden" name={k} value={v} /> : null,
  );

  const pill = (active: boolean) =>
    `rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
      active
        ? "bg-navy-900 text-white"
        : "text-ink-600 hover:bg-surface hover:text-ink-900"
    }`;
  const rowCls = "grid grid-cols-[5rem_1fr] items-center gap-x-3 px-4 py-2";
  const label = (text: string, active: boolean) => (
    <span
      className={`text-[0.7rem] font-semibold uppercase tracking-[0.08em] ${
        active ? "text-navy-900" : "text-ink-400"
      }`}
    >
      {text}
    </span>
  );
  const inputCls =
    "rounded-md border border-line bg-white px-3 py-1 text-sm text-ink-900";
  const stepCls =
    "inline-flex h-7 w-7 items-center justify-center rounded-md border border-line text-ink-600 hover:bg-surface hover:text-ink-900";

  const month = period.kind === "month" ? period.fromMonth : null;
  const prev = month && shiftMonth(month, -1) >= min ? shiftMonth(month, -1) : null;
  const next = month && shiftMonth(month, 1) <= max ? shiftMonth(month, 1) : null;

  return (
    <div className="mb-6 divide-y divide-line/70 rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(13,36,56,0.05)]">
      <div className={rowCls}>
        {label("Year", period.kind === "year")}
        <div className="flex flex-wrap items-center gap-1 py-0.5">
          {years.map((y, i) => (
            <Link
              key={y}
              // The current year is the default period, so its link is bare.
              href={href(i === 0 ? {} : { year: String(y) })}
              className={pill(
                period.kind === "year" && period.fromMonth === `${y}-01`,
              )}
            >
              {i === 0 ? `${y} YTD` : y}
            </Link>
          ))}
        </div>
      </div>

      <form method="get" action={path} className={rowCls}>
        {label("Month", period.kind === "month")}
        <div className="flex flex-wrap items-center gap-2 py-0.5">
          {hidden}
          {month &&
            (prev ? (
              <Link
                href={href({ month: prev })}
                className={stepCls}
                title={monthLabel(prev)}
              >
                <ChevronLeft size={15} strokeWidth={2} />
              </Link>
            ) : (
              <span className={`${stepCls} opacity-40`}>
                <ChevronLeft size={15} strokeWidth={2} />
              </span>
            ))}
          <input
            type="month"
            name="month"
            required
            // Re-key so a soft navigation resets the uncontrolled value.
            key={period.fileTag}
            defaultValue={month ?? period.toMonth}
            min={min}
            max={max}
            className={inputCls}
          />
          {month &&
            (next ? (
              <Link
                href={href({ month: next })}
                className={stepCls}
                title={monthLabel(next)}
              >
                <ChevronRight size={15} strokeWidth={2} />
              </Link>
            ) : (
              <span className={`${stepCls} opacity-40`}>
                <ChevronRight size={15} strokeWidth={2} />
              </span>
            ))}
          <button type="submit" className={buttonCls("secondary", "sm")}>
            View month
          </button>
        </div>
      </form>

      <form method="get" action={path} className={rowCls}>
        {label("Range", period.kind === "range")}
        <div className="flex flex-wrap items-center gap-2 py-0.5">
          {hidden}
          <input
            type="month"
            name="from"
            key={`from-${period.fileTag}`}
            defaultValue={period.fromMonth}
            min={min}
            max={max}
            className={inputCls}
          />
          <span className="text-sm text-ink-400">to</span>
          <input
            type="month"
            name="to"
            key={`to-${period.fileTag}`}
            defaultValue={period.toMonth}
            min={min}
            max={max}
            className={inputCls}
          />
          <button type="submit" className={buttonCls("secondary", "sm")}>
            Apply range
          </button>
        </div>
      </form>
    </div>
  );
}
