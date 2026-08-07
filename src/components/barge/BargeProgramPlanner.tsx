"use client";

import { useMemo, useState } from "react";
import { Card, CardTitle } from "@/components/ui";
import { moneyWhole, pct } from "@/lib/format";
import {
  DEFAULT_DIRECT_FTES,
  PRODUCTIVE_HOURS_PER_FTE,
} from "@/lib/barge";

interface PlannerQuote {
  id: string;
  name: string;
  status: string;
  hours: number;
  price: number;
  directMargin: number;
  netTons: number;
}

/**
 * Annual program builder: units per quote per year against the direct-trade
 * labor pool. Planning scratchpad only — the mix is session state, not saved.
 */
export function BargeProgramPlanner({ quotes }: { quotes: PlannerQuote[] }) {
  const [units, setUnits] = useState<Record<string, number>>({});
  const [ftes, setFtes] = useState(DEFAULT_DIRECT_FTES);

  const poolHours = ftes * PRODUCTIVE_HOURS_PER_FTE;
  const program = useMemo(() => {
    let revenue = 0;
    let hours = 0;
    let margin = 0;
    const lines: { name: string; units: number; revenue: number; margin: number; hours: number }[] = [];
    for (const q of quotes) {
      const u = units[q.id] ?? 0;
      if (!u) continue;
      revenue += u * q.price;
      hours += u * q.hours;
      margin += u * q.directMargin;
      lines.push({
        name: q.name,
        units: u,
        revenue: u * q.price,
        margin: u * q.directMargin,
        hours: u * q.hours,
      });
    }
    return { revenue, hours, margin, lines };
  }, [quotes, units]);

  const used = poolHours > 0 ? program.hours / poolHours : 0;
  const over = used > 1;

  if (quotes.length === 0) {
    return (
      <Card>
        <CardTitle>Annual program</CardTitle>
        <p className="text-sm text-ink-600">
          Once quotes exist, set units per year here to see how a build program
          consumes the direct-trade labor pool.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <CardTitle>Annual program</CardTitle>
      <div className="space-y-2">
        {quotes.map((q) => (
          <label key={q.id} className="flex items-center justify-between gap-3">
            <span className="min-w-0 flex-1 truncate text-sm text-ink-600">
              {q.name}
              <span className="ml-2 text-xs text-ink-400 tabular-nums">
                {q.netTons.toFixed(0)} t · {q.hours.toLocaleString("en-US")} hrs/unit
              </span>
            </span>
            <input
              type="number"
              min={0}
              step={1}
              value={units[q.id] ?? 0}
              onChange={(e) =>
                setUnits((u) => ({
                  ...u,
                  [q.id]: Math.max(0, parseInt(e.target.value) || 0),
                }))
              }
              className="w-20 rounded-lg border border-line bg-white px-2 py-1 text-right text-sm tabular-nums focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
            />
          </label>
        ))}
      </div>

      <label className="mt-4 flex items-center justify-between gap-3">
        <span className="text-sm text-ink-600">
          Labor pool
          <span className="ml-2 text-xs text-ink-400">
            direct FTEs × {PRODUCTIVE_HOURS_PER_FTE.toLocaleString("en-US")} productive hrs
          </span>
        </span>
        <input
          type="number"
          min={1}
          step={1}
          value={ftes}
          onChange={(e) => setFtes(Math.max(1, parseInt(e.target.value) || 1))}
          className="w-20 rounded-lg border border-line bg-white px-2 py-1 text-right text-sm tabular-nums focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
        />
      </label>

      <div className="relative mt-3 h-6 overflow-hidden rounded-md bg-surface">
        <div
          className={`h-full transition-all ${over ? "bg-bad-600" : "bg-brand-600"}`}
          style={{ width: `${Math.min(100, used * 100)}%` }}
        />
        <span className="absolute inset-0 flex items-center justify-center text-xs font-medium tabular-nums text-white [text-shadow:0_0_4px_rgba(0,0,0,0.55)]">
          {Math.round(program.hours).toLocaleString("en-US")} /{" "}
          {poolHours.toLocaleString("en-US")} hrs ({(used * 100).toFixed(0)}%
          {over ? " — OVER CAPACITY" : ""})
        </span>
      </div>

      {program.lines.length > 0 && (
        <dl className="mt-4 space-y-1 text-sm">
          <div className="flex justify-between">
            <dt className="text-ink-600">Program revenue</dt>
            <dd className="tabular-nums text-ink-900">
              {moneyWhole(program.revenue)}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink-600">Direct contribution</dt>
            <dd className="tabular-nums text-ink-900">
              {moneyWhole(program.margin)}
              {program.revenue > 0 && (
                <span className="ml-1 text-xs text-ink-400">
                  ({pct(program.margin / program.revenue)})
                </span>
              )}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink-600">Implied FTEs</dt>
            <dd className="tabular-nums text-ink-900">
              {(program.hours / PRODUCTIVE_HOURS_PER_FTE).toFixed(1)}
            </dd>
          </div>
        </dl>
      )}
      <p className="mt-3 text-xs text-ink-400">
        Hours committed here are hours pulled from repair work unless the yard
        hires. The mix is a planning scratchpad and is not saved.
      </p>
    </Card>
  );
}
