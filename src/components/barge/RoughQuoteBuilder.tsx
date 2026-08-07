"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Save } from "lucide-react";
import {
  createBargeQuoteFromConfig,
  saveBargeConfig,
} from "@/app/(app)/barge/actions";
import { Alert, Card, CardTitle, PageHeader, StatTile, buttonCls } from "@/components/ui";
import { moneyWhole } from "@/lib/format";
import {
  DEFAULT_CONFIG,
  computeRoughQuote,
  type BargeConfig,
  type BargeConfigValues,
} from "@/lib/barge";

type NumericKey = Exclude<keyof BargeConfigValues, "name">;

const FIELD_GROUPS: {
  title: string;
  fields: { key: NumericKey; label: string; hint?: string; step?: number }[];
}[] = [
  {
    title: "Principal dimensions",
    fields: [
      { key: "length_ft", label: "Length", hint: "ft", step: 5 },
      { key: "beam_ft", label: "Beam", hint: "ft", step: 2 },
      { key: "depth_ft", label: "Depth", hint: "ft", step: 0.5 },
      { key: "spud_wells", label: "Spud wells", hint: "count — crane-ready", step: 1 },
    ],
  },
  {
    title: "Structure — TSG-calibrated defaults",
    fields: [
      { key: "deck_plate_in", label: "Deck / bottom plate", hint: "inches", step: 0.0625 },
      { key: "side_plate_in", label: "Side shell plate", hint: "inches", step: 0.0625 },
      { key: "bhd_plate_in", label: "Bulkhead plate", hint: "inches", step: 0.0625 },
      { key: "long_bhd_spacing_ft", label: "Long. BHD spacing", hint: "ft — TSG: 11'", step: 0.5 },
      { key: "wt_bhd_spacing_ft", label: "WT BHD spacing", hint: "ft — TSG: ~30'", step: 1 },
      { key: "plate_allowance_pct", label: "Plate allowance", hint: "% — rakes, spud wells, laps (TSG-calib. 22%)", step: 1 },
      { key: "framing_pct", label: "Framing & trusses", hint: "% of plate wt (TSG-calib. 39%)", step: 1 },
      { key: "yield_pct", label: "Purchase yield", hint: "% — engineer's list runs 80–100", step: 1 },
    ],
  },
  {
    title: "Market rates — challenge these",
    fields: [
      { key: "steel_per_lb", label: "Steel price", hint: "$/lb blended — industry ≈$0.55", step: 0.01 },
      { key: "hours_per_ton", label: "Hours per net ton", hint: "first-article 25–35; serial 10–15; yard claim 8.7", step: 1 },
      { key: "labor_rate", label: "Labor rate", hint: "$/hr — industry burdened ≈$45; payroll $33.86", step: 1 },
      { key: "blast_per_sqft", label: "Blast & paint", hint: "$/sqft exterior (TSG-calib. $4.00)", step: 0.25 },
      { key: "spud_well_cost", label: "Spud well package", hint: "$ per well incl. spud (calib. $18K)", step: 500 },
      { key: "fittings_per_sqft", label: "Fittings & hatches", hint: "$/sqft of deck (calib. $4.50)", step: 0.25 },
      { key: "target_pct", label: "Target contribution", hint: "% — sets suggested price", step: 1 },
    ],
  },
];

const QUICK_SETS: Partial<Record<NumericKey, { label: string; value: number }[]>> = {
  steel_per_lb: [
    { label: "industry $0.55", value: 0.55 },
    { label: "yard-quote $0.78", value: 0.78 },
  ],
  hours_per_ton: [
    { label: "industry 30", value: 30 },
    { label: "serial 12", value: 12 },
    { label: "yard 8.7", value: 8.7 },
  ],
};

const fmtLbs = (n: number) => Math.round(n).toLocaleString("en-US");

function toFields(v: BargeConfigValues): Record<NumericKey, string> {
  const out = {} as Record<NumericKey, string>;
  for (const g of FIELD_GROUPS)
    for (const f of g.fields) out[f.key] = String(v[f.key]);
  return out;
}

export function RoughQuoteBuilder({
  configs,
  initialConfigId,
  canEdit,
}: {
  configs: BargeConfig[];
  initialConfigId: string | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const initial = configs.find((c) => c.id === initialConfigId) ?? null;
  const [configId, setConfigId] = useState<string | null>(initial?.id ?? null);
  const [name, setName] = useState(initial?.name ?? "");
  const [fields, setFields] = useState<Record<NumericKey, string>>(
    toFields(initial ? toValues(initial) : DEFAULT_CONFIG),
  );

  function toValues(c: BargeConfig): BargeConfigValues {
    const out = { ...DEFAULT_CONFIG, name: c.name };
    for (const g of FIELD_GROUPS)
      for (const f of g.fields) out[f.key] = Number(c[f.key]);
    return out;
  }

  const values: BargeConfigValues = useMemo(() => {
    const out = { ...DEFAULT_CONFIG, name };
    for (const g of FIELD_GROUPS)
      for (const f of g.fields) {
        const n = parseFloat(fields[f.key]);
        out[f.key] = Number.isFinite(n) && n >= 0 ? n : DEFAULT_CONFIG[f.key];
      }
    return out;
  }, [fields, name]);

  const r = useMemo(() => computeRoughQuote(values), [values]);
  const contribution = r.suggestedPrice - r.directCost;

  function loadConfig(id: string) {
    const c = configs.find((c) => c.id === id);
    if (!c) {
      setConfigId(null);
      return;
    }
    setConfigId(c.id);
    setName(c.name);
    setFields(toFields(toValues(c)));
  }

  function run(fn: () => Promise<{ ok: boolean; error?: string } | void>) {
    setError(null);
    setBusy(true);
    startTransition(async () => {
      try {
        const res = await fn();
        if (res && "ok" in res && !res.ok) setError(res.error ?? "Failed");
        else router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed");
      } finally {
        setBusy(false);
      }
    });
  }

  const buildUp: { label: string; lbs: number }[] = [
    { label: `Deck plate — ${values.deck_plate_in}" × ${fmtLbs(r.deckArea)} sqft`, lbs: r.wDeck },
    { label: `Bottom plate — ${values.deck_plate_in}"`, lbs: r.wBottom },
    { label: `Side shell — ${values.side_plate_in}" × ${fmtLbs(r.sideArea)} sqft`, lbs: r.wSide },
    { label: `Ends & headlog — ${values.deck_plate_in}" basis`, lbs: r.wEnds },
    { label: `Long. bulkheads × ${r.longBhds} — ${values.bhd_plate_in}"`, lbs: r.wLongBhd },
    { label: `WT bulkheads × ${r.wtBhds} — ${values.bhd_plate_in}"`, lbs: r.wWtBhd },
    { label: `Plate allowance (${values.plate_allowance_pct}%) — rakes, spud wells, laps`, lbs: r.wAllowance },
    { label: `Framing & trusses (${values.framing_pct}% of plate)`, lbs: r.wFraming },
  ];

  return (
    <div>
      <PageHeader
        title="Rough Quote Builder"
        subtitle="Dimensions to a priced estimate in seconds. Defaults are deliberately conservative — industry-benchmark steel and first-article hours — so every number states the case that must be beaten."
        action={
          <Link href="/barge" className={buttonCls("secondary")}>
            <ArrowLeft size={16} strokeWidth={2} />
            Barge Program
          </Link>
        }
      />

      {error && (
        <div className="mb-4">
          <Alert tone="bad">{error}</Alert>
        </div>
      )}

      <div className="grid items-start gap-6 lg:grid-cols-[380px_1fr]">
        <Card>
          {configs.length > 0 && (
            <div className="mb-5">
              <label className="mb-1 block text-xs font-medium text-ink-600">
                Load saved configuration
              </label>
              <select
                value={configId ?? ""}
                onChange={(e) => loadConfig(e.target.value)}
                className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
              >
                <option value="">— New configuration —</option>
                {configs.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {FIELD_GROUPS.map((g) => (
            <div key={g.title} className="mb-5">
              <p className="mb-2 text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-brand-600">
                {g.title}
              </p>
              <div className="space-y-2">
                {g.fields.map((f) => (
                  <div key={f.key}>
                    <label className="flex items-center justify-between gap-3">
                      <span className="text-sm text-ink-600">
                        {f.label}
                        {f.hint && (
                          <span className="block text-[0.68rem] text-ink-400">
                            {f.hint}
                          </span>
                        )}
                      </span>
                      <input
                        type="number"
                        step={f.step ?? 1}
                        value={fields[f.key]}
                        onChange={(e) =>
                          setFields((prev) => ({ ...prev, [f.key]: e.target.value }))
                        }
                        className="w-28 rounded-lg border border-line bg-white px-2 py-1.5 text-right text-sm tabular-nums focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                      />
                    </label>
                    {QUICK_SETS[f.key] && (
                      <div className="mt-1 flex gap-1.5">
                        {QUICK_SETS[f.key]!.map((qs) => (
                          <button
                            key={qs.label}
                            type="button"
                            onClick={() =>
                              setFields((prev) => ({
                                ...prev,
                                [f.key]: String(qs.value),
                              }))
                            }
                            className="rounded-md border border-dashed border-line px-2 py-0.5 text-[0.68rem] text-brand-600 transition-colors hover:bg-brand-50"
                          >
                            {qs.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}

          {canEdit && (
            <div className="space-y-2 border-t border-line pt-4">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Configuration name"
                className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm placeholder:text-ink-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
              />
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => run(() => saveBargeConfig(configId, values))}
                  disabled={busy || !name.trim()}
                  title={!name.trim() ? "Give the configuration a name first" : undefined}
                  className={buttonCls("secondary", "sm")}
                >
                  <Save size={13} strokeWidth={2} />
                  {configId ? "Update configuration" : "Save configuration"}
                </button>
                <button
                  onClick={() => run(() => createBargeQuoteFromConfig(values, configId))}
                  disabled={busy}
                  className={buttonCls("primary", "sm")}
                >
                  Create editable quote
                  <ArrowRight size={13} strokeWidth={2} />
                </button>
              </div>
            </div>
          )}
        </Card>

        <div>
          <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile
              label="Net steel"
              value={`${r.netTons.toFixed(0)} t`}
              hint={`${fmtLbs(r.netLbs)} lbs · ${fmtLbs(r.orderedLbs)} ordered`}
            />
            <StatTile
              label="Labor hours"
              value={r.hours.toLocaleString("en-US")}
              hint={`${values.hours_per_ton} hrs/ton × $${values.labor_rate}/hr`}
            />
            <StatTile
              label="Rough direct cost"
              value={moneyWhole(r.directCost)}
              hint={r.netTons > 0 ? `${moneyWhole(r.directCost / r.netTons)} per ton` : undefined}
            />
            <StatTile
              label={`Price @ ${values.target_pct}%`}
              value={moneyWhole(Math.round(r.suggestedPrice / 5000) * 5000)}
              hint={`${moneyWhole(contribution)} contribution`}
            />
          </div>

          <Card pad={false}>
            <div className="border-b border-line px-6 py-4">
              <CardTitle>
                Rough quote build-up — {values.length_ft}&prime; ×{" "}
                {values.beam_ft}&prime; × {values.depth_ft}&prime; ·{" "}
                {values.spud_wells} spud wells
              </CardTitle>
            </div>
            <table className="w-full text-sm">
              <tbody className="divide-y divide-line/70">
                {buildUp.map((row) => (
                  <tr key={row.label}>
                    <td className="px-6 py-2 text-ink-600">{row.label}</td>
                    <td className="px-6 py-2 text-right tabular-nums">
                      {fmtLbs(row.lbs)} lbs
                    </td>
                    <td className="px-6 py-2 text-right tabular-nums text-ink-400">
                      {moneyWhole((row.lbs / (values.yield_pct / 100)) * values.steel_per_lb)}
                    </td>
                  </tr>
                ))}
                <tr className="bg-surface/60 font-medium">
                  <td className="px-6 py-2">
                    Steel — {fmtLbs(r.netLbs)} net lbs ÷ {values.yield_pct}% yield × $
                    {values.steel_per_lb.toFixed(2)}/lb
                  </td>
                  <td className="px-6 py-2 text-right tabular-nums">
                    {fmtLbs(r.orderedLbs)} lbs
                  </td>
                  <td className="px-6 py-2 text-right tabular-nums">
                    {moneyWhole(r.steelCost)}
                  </td>
                </tr>
                <tr>
                  <td className="px-6 py-2 text-ink-600">
                    Direct labor — {r.hours.toLocaleString("en-US")} hrs × $
                    {values.labor_rate}
                  </td>
                  <td />
                  <td className="px-6 py-2 text-right tabular-nums">
                    {moneyWhole(r.laborCost)}
                  </td>
                </tr>
                <tr>
                  <td className="px-6 py-2 text-ink-600">
                    Blast &amp; paint — {fmtLbs(r.extArea)} sqft × $
                    {values.blast_per_sqft.toFixed(2)}
                  </td>
                  <td />
                  <td className="px-6 py-2 text-right tabular-nums">
                    {moneyWhole(r.blastCost)}
                  </td>
                </tr>
                <tr>
                  <td className="px-6 py-2 text-ink-600">
                    Spud well package — {values.spud_wells} × {moneyWhole(values.spud_well_cost)}
                  </td>
                  <td />
                  <td className="px-6 py-2 text-right tabular-nums">
                    {moneyWhole(r.spudsCost)}
                  </td>
                </tr>
                <tr>
                  <td className="px-6 py-2 text-ink-600">
                    Fittings &amp; hatches — {fmtLbs(r.deckArea)} sqft × $
                    {values.fittings_per_sqft.toFixed(2)}
                  </td>
                  <td />
                  <td className="px-6 py-2 text-right tabular-nums">
                    {moneyWhole(r.fittingsCost)}
                  </td>
                </tr>
                <tr className="border-t-2 border-ink-900/80 bg-surface/60 font-semibold">
                  <td className="px-6 py-2">Rough direct cost</td>
                  <td />
                  <td className="px-6 py-2 text-right tabular-nums">
                    {moneyWhole(r.directCost)}
                  </td>
                </tr>
                <tr className="font-medium text-ok-600">
                  <td className="px-6 py-2">
                    Suggested price @ {values.target_pct}% contribution
                  </td>
                  <td />
                  <td className="px-6 py-2 text-right tabular-nums">
                    {moneyWhole(Math.round(r.suggestedPrice / 5000) * 5000)}
                  </td>
                </tr>
              </tbody>
            </table>
          </Card>

          <Card className="mt-6">
            <CardTitle>How this estimate is built</CardTitle>
            <p className="text-sm leading-relaxed text-ink-600">
              Shell and bulkhead plate is computed from geometry at the
              thicknesses entered (steel = 40.8 lb/sqft per inch). The plate
              allowance covers rakes, spud-well structure, laps and brackets,
              and the framing-and-trusses factor converts plate weight to total
              net steel — both calibrated so that at 150&prime; × 54&prime; ×
              8&prime; this model reproduces the naval architect&apos;s
              engineered takeoff (≈807,000 lbs net) within 0.5%. Hours default
              to the industry first-article benchmark — deliberately
              conservative against the yard&apos;s 8.7 hrs/ton claim. Create
              the editable quote, then challenge any line in the takeoff.
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}
