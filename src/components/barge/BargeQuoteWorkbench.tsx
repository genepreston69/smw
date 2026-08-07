"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Check,
  Copy,
  MessageSquareWarning,
  Plus,
  Send,
  Trash2,
  X,
} from "lucide-react";
import {
  approveBargeQuote,
  deleteBargeQuote,
  duplicateBargeQuote,
  rejectBargeQuote,
  requestBargeQuoteChanges,
  saveBargeQuote,
  submitBargeQuote,
  type BargeQuotePayload,
} from "@/app/(app)/barge/actions";
import {
  Alert,
  Card,
  CardTitle,
  StatTile,
  buttonCls,
} from "@/components/ui";
import { StatusBadge } from "@/components/StatusBadge";
import { moneyWhole, pct, shortDate } from "@/lib/format";
import {
  BARGE_LINE_UNITS,
  BARGE_SECTIONS,
  BARGE_SECTION_LABELS,
  computeQuote,
  computeSteelLine,
  type BargeApproval,
  type BargeLaborPhase,
  type BargeQuote,
  type BargeSection,
  type BargeSteelLine,
  type QuoteInputs,
} from "@/lib/barge";
import type { ApprovalThreshold, Customer, Profile } from "@/lib/types";

/* ---------------------------------------------------------------------------
   Draft state: editable fields kept as strings so partially typed numbers
   ("0.", "12.") survive keystrokes; parsed for live compute and on save.
--------------------------------------------------------------------------- */

interface DraftLine {
  section: BargeSection;
  item: string;
  unit: string;
  qty: string;
  unit_lb: string;
  yield_pct: string;
  price_per_lb: string;
}

interface DraftState {
  name: string;
  customer_id: string | null;
  notes: string;
  labor_rate: string;
  blast_cost: string;
  spuds_cost: string;
  hatches_cost: string;
  overhead_pct: string;
  contingency_pct: string;
  target_pct: string;
  sales_price: string;
  lines: DraftLine[];
  labor: { name: string; hours: string }[];
}

function toDraft(
  quote: BargeQuote,
  lines: BargeSteelLine[],
  labor: BargeLaborPhase[],
): DraftState {
  return {
    name: quote.name,
    customer_id: quote.customer_id,
    notes: quote.notes ?? "",
    labor_rate: String(Number(quote.labor_rate)),
    blast_cost: String(Number(quote.blast_cost)),
    spuds_cost: String(Number(quote.spuds_cost)),
    hatches_cost: String(Number(quote.hatches_cost)),
    overhead_pct: String(Number(quote.overhead_pct)),
    contingency_pct: String(Number(quote.contingency_pct)),
    target_pct: String(Number(quote.target_pct)),
    sales_price: String(Number(quote.sales_price)),
    lines: lines.map((l) => ({
      section: l.section,
      item: l.item,
      unit: l.unit,
      qty: String(Number(l.qty)),
      unit_lb: String(Number(l.unit_lb)),
      yield_pct: String(Number(l.yield_pct)),
      price_per_lb: String(Number(l.price_per_lb)),
    })),
    labor: labor.map((p) => ({ name: p.name, hours: String(Number(p.hours)) })),
  };
}

const num = (s: string) => {
  const n = parseFloat(s);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

function toInputs(d: DraftState): QuoteInputs {
  return {
    labor_rate: num(d.labor_rate),
    blast_cost: num(d.blast_cost),
    spuds_cost: num(d.spuds_cost),
    hatches_cost: num(d.hatches_cost),
    overhead_pct: num(d.overhead_pct),
    contingency_pct: num(d.contingency_pct),
    target_pct: Math.min(99, num(d.target_pct)),
    sales_price: num(d.sales_price),
    lines: d.lines.map((l) => ({
      section: l.section,
      item: l.item,
      unit: l.unit as QuoteInputs["lines"][number]["unit"],
      qty: num(l.qty),
      unit_lb: num(l.unit_lb),
      yield_pct: Math.min(100, Math.max(0.01, num(l.yield_pct) || 100)),
      price_per_lb: num(l.price_per_lb),
    })),
    labor: d.labor.map((p) => ({ name: p.name, hours: num(p.hours) })),
  };
}

const fmtLbs = (n: number) => Math.round(n).toLocaleString("en-US");
const marginColor = (m: number) =>
  m < 0 ? "#c94f35" : m < 0.1 ? "#e0a13f" : m < 0.2 ? "#8fb573" : "#3f7d55";

const inputCls =
  "rounded-lg border border-line bg-white px-2 py-1 text-sm tabular-nums focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 disabled:bg-surface disabled:text-ink-600";

interface Props {
  quote: BargeQuote;
  lines: BargeSteelLine[];
  labor: BargeLaborPhase[];
  approvals: BargeApproval[];
  thresholds: ApprovalThreshold[];
  customers: Pick<Customer, "id" | "display_name">[];
  profiles: Profile[];
  me: Profile;
}

export function BargeQuoteWorkbench(props: Props) {
  const { quote, thresholds, profiles, me } = props;
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"direct" | "full">("direct");
  const [comment, setComment] = useState("");

  const isCreator = quote.created_by === me.id;
  const isAdmin = me.role === "admin";
  const editableStatus =
    quote.status === "draft" || quote.status === "changes_requested";
  const canEdit =
    (isCreator || isAdmin) &&
    editableStatus &&
    (me.role === "estimator" || isAdmin);
  const canApprove =
    (me.role === "approver" || isAdmin) &&
    quote.status === "submitted" &&
    !isCreator;
  // Mirrors the barge_quotes_delete RLS policy.
  const canDelete = isAdmin || (isCreator && quote.status === "draft");

  // --- draft state, re-synced whenever the server sends fresh data ---------
  const serverDraft = useMemo(
    () => toDraft(props.quote, props.lines, props.labor),
    [props.quote, props.lines, props.labor],
  );
  const serverKey = JSON.stringify(serverDraft);
  const [syncedKey, setSyncedKey] = useState(serverKey);
  const [draft, setDraft] = useState(serverDraft);
  if (serverKey !== syncedKey) {
    setSyncedKey(serverKey);
    setDraft(serverDraft);
  }
  const dirty = JSON.stringify(draft) !== serverKey;

  const inputs = useMemo(() => toInputs(draft), [draft]);
  const r = useMemo(() => computeQuote(inputs), [inputs]);

  const cost = mode === "direct" ? r.direct_cost : r.absorbed_cost;
  const margin = inputs.sales_price - cost;
  const marginPct = inputs.sales_price > 0 ? margin / inputs.sales_price : 0;
  const marginLabel = mode === "direct" ? "Direct contribution" : "Margin";
  const priceAtTarget = cost / (1 - inputs.target_pct / 100);
  const crossVariance = cost - r.crosscheck;

  const requiredApprovals = useMemo(() => {
    const t = thresholds.find(
      (t) =>
        inputs.sales_price >= Number(t.min_amount) &&
        (t.max_amount === null || inputs.sales_price < Number(t.max_amount)),
    );
    return t?.required_approvals ?? 1;
  }, [thresholds, inputs.sales_price]);

  const approvedThisVersion = props.approvals.filter(
    (a) => a.quote_version === quote.version && a.decision === "approved",
  ).length;

  const nameOf = (id: string) => {
    const p = profiles.find((p) => p.id === id);
    return p?.full_name || p?.email || "Unknown";
  };

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

  function save() {
    const payload: BargeQuotePayload = {
      name: draft.name.trim() || "Untitled quote",
      customer_id: draft.customer_id,
      notes: draft.notes.trim() || null,
      labor_rate: inputs.labor_rate,
      blast_cost: inputs.blast_cost,
      spuds_cost: inputs.spuds_cost,
      hatches_cost: inputs.hatches_cost,
      overhead_pct: inputs.overhead_pct,
      contingency_pct: inputs.contingency_pct,
      target_pct: inputs.target_pct,
      sales_price: inputs.sales_price,
      lines: inputs.lines,
      labor: inputs.labor,
    };
    run(() => saveBargeQuote(quote.id, payload));
  }

  const setField = <K extends keyof DraftState>(key: K, value: DraftState[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const setLine = (i: number, key: keyof DraftLine, value: string) =>
    setDraft((d) => ({
      ...d,
      lines: d.lines.map((l, j) => (j === i ? { ...l, [key]: value } : l)),
    }));
  const setLabor = (i: number, key: "name" | "hours", value: string) =>
    setDraft((d) => ({
      ...d,
      labor: d.labor.map((p, j) => (j === i ? { ...p, [key]: value } : p)),
    }));

  // --- sensitivity grid: steel $/lb multiplier × labor-hours multiplier ----
  const blendedRate = r.ordered_lbs > 0 ? r.steel_cost / r.ordered_lbs : 0;
  const steelMults = [0.85, 0.925, 1.0, 1.075, 1.15];
  const hourMults = [0.7, 0.85, 1.0, 1.15, 1.3];
  const sensitivity = hourMults.map((hm) =>
    steelMults.map((sm) => {
      const steel = r.steel_cost * sm;
      const laborCost = r.labor_cost * hm;
      const overhead = mode === "direct" ? 0 : r.overhead_cost * hm;
      const total =
        (steel + laborCost + r.fitout_cost + overhead) *
        (1 + inputs.contingency_pct / 100);
      return inputs.sales_price > 0
        ? (inputs.sales_price - total) / inputs.sales_price
        : 0;
    }),
  );

  // --- P&L rows -------------------------------------------------------------
  const plRows: { label: string; amount: number }[] = [];
  for (const sec of BARGE_SECTIONS) {
    if (r.bySection[sec].steelCost > 0)
      plRows.push({
        label: `Steel — ${BARGE_SECTION_LABELS[sec]}`,
        amount: r.bySection[sec].steelCost,
      });
  }
  for (const p of inputs.labor) {
    if (p.hours > 0)
      plRows.push({
        label: `Labor — ${p.name} (${p.hours.toLocaleString("en-US")} hrs)`,
        amount: p.hours * inputs.labor_rate,
      });
  }
  plRows.push(
    { label: "Blast & paint ext.", amount: inputs.blast_cost },
    { label: "Spud wells & spuds", amount: inputs.spuds_cost },
    { label: "Hatches & deck fittings", amount: inputs.hatches_cost },
  );
  if (mode === "full")
    plRows.push({
      label: `Overhead on labor (${inputs.overhead_pct}%)`,
      amount: r.overhead_cost,
    });
  if (inputs.contingency_pct > 0)
    plRows.push({
      label: `Contingency (${inputs.contingency_pct}%)`,
      amount: cost - cost / (1 + inputs.contingency_pct / 100),
    });

  return (
    <div>
      {/* ---- header ---- */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href="/barge"
              className="flex items-center gap-1 text-sm text-ink-400 hover:text-ink-900"
            >
              <ArrowLeft size={15} strokeWidth={2} />
              Barge Program
            </Link>
            <StatusBadge status={quote.status} />
            {quote.version > 1 && (
              <span className="text-xs text-ink-400">v{quote.version}</span>
            )}
          </div>
          {canEdit ? (
            <input
              type="text"
              value={draft.name}
              maxLength={80}
              onChange={(e) => setField("name", e.target.value)}
              className="mt-2 w-[28rem] max-w-full rounded-lg border border-line bg-white px-3 py-1.5 text-lg font-semibold tracking-tight text-ink-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
            />
          ) : (
            <h1 className="mt-2 text-[1.6rem] font-semibold tracking-tight text-ink-900">
              {quote.name}
            </h1>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex overflow-hidden rounded-lg border border-line">
            {(["direct", "full"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  mode === m
                    ? "bg-navy-900 text-white"
                    : "bg-white text-ink-600 hover:bg-surface"
                }`}
              >
                {m === "direct" ? "Direct contribution" : "Fully absorbed"}
              </button>
            ))}
          </div>
          <button
            onClick={() => run(() => duplicateBargeQuote(quote.id))}
            disabled={busy}
            className={buttonCls("secondary", "sm")}
          >
            <Copy size={13} strokeWidth={2} />
            Duplicate
          </button>
          {canDelete && (
            <button
              onClick={() => {
                if (!window.confirm(`Delete "${quote.name}"? This permanently removes the quote.`)) return;
                run(async () => {
                  const res = await deleteBargeQuote(quote.id);
                  if (res.ok) router.push("/barge");
                  return res;
                });
              }}
              disabled={busy}
              className={buttonCls("danger", "sm")}
            >
              <Trash2 size={13} strokeWidth={2} />
              Delete
            </button>
          )}
        </div>
      </div>

      <p className="-mt-3 mb-5 text-xs text-ink-400">
        {mode === "direct"
          ? "Overhead excluded — fixed yard costs already absorbed by repair operations. Margin = price − direct costs."
          : "Overhead applied on labor — the fully-costed view for pricing floors and long-run capacity decisions."}
      </p>

      {error && (
        <div className="mb-4">
          <Alert tone="bad">{error}</Alert>
        </div>
      )}

      {canEdit && dirty && (
        <div className="mb-4 flex items-center justify-between rounded-lg border border-warn-700/25 bg-warn-50 px-4 py-2.5">
          <p className="text-sm text-warn-700">Unsaved changes</p>
          <div className="flex gap-2">
            <button
              onClick={() => setDraft(serverDraft)}
              disabled={busy}
              className={buttonCls("secondary", "sm")}
            >
              Discard
            </button>
            <button onClick={save} disabled={busy} className={buttonCls("primary", "sm")}>
              Save quote
            </button>
          </div>
        </div>
      )}

      {/* ---- KPIs ---- */}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <StatTile
          label="Cost to build"
          value={moneyWhole(cost)}
          hint={`${r.net_tons.toFixed(0)} net t · ${fmtLbs(r.ordered_lbs)} lbs ordered`}
        />
        <StatTile
          label="Sales price"
          value={moneyWhole(inputs.sales_price)}
          hint="no market comp — negotiated"
        />
        <StatTile
          label={`${marginLabel} / unit`}
          value={moneyWhole(margin)}
          hint={`${pct(marginPct)} of price`}
        />
        <StatTile
          label="Margin / labor hr"
          value={r.total_hours > 0 ? moneyWhole(margin / r.total_hours) : "—"}
          hint={`${r.hours_per_ton.toFixed(1)} hrs/net ton`}
        />
        <StatTile
          label={`Price @ ${inputs.target_pct}% target`}
          value={moneyWhole(priceAtTarget)}
          hint={`breakeven ${moneyWhole(cost)}`}
        />
      </div>

      <div className="grid items-start gap-6 xl:grid-cols-[360px_1fr]">
        {/* ---- left: labor & commercials ---- */}
        <div className="space-y-6">
          <Card>
            <CardTitle>Customer &amp; notes</CardTitle>
            <select
              value={draft.customer_id ?? ""}
              onChange={(e) => setField("customer_id", e.target.value || null)}
              disabled={!canEdit}
              className={`${inputCls} w-full`}
            >
              <option value="">— No customer (speculative) —</option>
              {props.customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.display_name}
                </option>
              ))}
            </select>
            <textarea
              value={draft.notes}
              onChange={(e) => setField("notes", e.target.value)}
              disabled={!canEdit}
              rows={3}
              placeholder="Notes — basis, open items, negotiation context"
              className={`${inputCls} mt-2 w-full resize-y placeholder:text-ink-400`}
            />
          </Card>

          <Card>
            <CardTitle>Labor by build phase</CardTitle>
            <div className="space-y-2">
              {draft.labor.map((p, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={p.name}
                    onChange={(e) => setLabor(i, "name", e.target.value)}
                    disabled={!canEdit}
                    placeholder="Phase"
                    className={`${inputCls} min-w-0 flex-1`}
                  />
                  <input
                    type="number"
                    step={25}
                    value={p.hours}
                    onChange={(e) => setLabor(i, "hours", e.target.value)}
                    disabled={!canEdit}
                    className={`${inputCls} w-24 text-right`}
                  />
                  {canEdit && (
                    <button
                      onClick={() =>
                        setDraft((d) => ({
                          ...d,
                          labor: d.labor.filter((_, j) => j !== i),
                        }))
                      }
                      title="Remove phase"
                      className="text-ink-400 hover:text-bad-600"
                    >
                      <X size={14} strokeWidth={2} />
                    </button>
                  )}
                </div>
              ))}
            </div>
            {canEdit && (
              <button
                onClick={() =>
                  setDraft((d) => ({
                    ...d,
                    labor: [...d.labor, { name: "New phase", hours: "0" }],
                  }))
                }
                className="mt-2 rounded-md border border-dashed border-line px-2.5 py-1 text-xs text-brand-600 transition-colors hover:bg-brand-50"
              >
                <Plus size={12} strokeWidth={2} className="mr-1 inline" />
                Add phase
              </button>
            )}
            <label className="mt-4 flex items-center justify-between gap-3 border-t border-line pt-3">
              <span className="text-sm text-ink-600">
                Labor rate
                <span className="block text-[0.68rem] text-ink-400">
                  $/hr — quote $45; payroll burdened $33.86; billing $88
                </span>
              </span>
              <input
                type="number"
                step={1}
                value={draft.labor_rate}
                onChange={(e) => setField("labor_rate", e.target.value)}
                disabled={!canEdit}
                className={`${inputCls} w-24 text-right`}
              />
            </label>
            <dl className="mt-3 space-y-1 rounded-lg bg-surface px-3 py-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-ink-600">Total hours</dt>
                <dd className="tabular-nums text-ink-900">
                  {r.total_hours.toLocaleString("en-US")} × $
                  {inputs.labor_rate} = {moneyWhole(r.labor_cost)}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-600">Hours per net ton</dt>
                <dd className="tabular-nums text-ink-900">
                  {r.hours_per_ton.toFixed(1)}
                  <span className="ml-1 text-xs text-ink-400">
                    (bench 27–35; serial 10–15)
                  </span>
                </dd>
              </div>
            </dl>
          </Card>

          <Card>
            <CardTitle>Fit-out, indirects &amp; pricing</CardTitle>
            <div className="space-y-2">
              {(
                [
                  ["blast_cost", "Blast & paint ext.", "lump sum $", 1000],
                  ["spuds_cost", "Spud wells & spuds", "lump sum $", 1000],
                  ["hatches_cost", "Hatches & deck fittings", "lump sum $ — manholes, rub rail, kevels", 250],
                  ["overhead_pct", "Overhead on labor", "% — fully-absorbed view only", 1],
                  ["contingency_pct", "Contingency", "% — the yard quote carries none", 0.5],
                  ["sales_price", "Sales price", "$ — set from negotiation", 5000],
                  ["target_pct", "Target contribution", "% — drives suggested price", 1],
                ] as const
              ).map(([key, label, hint, step]) => (
                <label key={key} className="flex items-center justify-between gap-3">
                  <span className="text-sm text-ink-600">
                    {label}
                    <span className="block text-[0.68rem] text-ink-400">{hint}</span>
                  </span>
                  <input
                    type="number"
                    step={step}
                    value={draft[key]}
                    onChange={(e) => setField(key, e.target.value)}
                    disabled={!canEdit}
                    className={`${inputCls} w-28 text-right`}
                  />
                </label>
              ))}
            </div>
            <dl className="mt-3 space-y-1.5 text-sm">
              <div className="flex justify-between rounded-lg bg-ok-50 px-3 py-2 text-ok-600">
                <dt>Price for {inputs.target_pct}% target</dt>
                <dd className="font-medium tabular-nums">
                  {moneyWhole(priceAtTarget)}
                </dd>
              </div>
              <div className="flex justify-between rounded-lg bg-warn-50 px-3 py-2 text-warn-700">
                <dt>Crosscheck $1.50/lb net</dt>
                <dd className="tabular-nums">
                  {moneyWhole(r.crosscheck)} ({crossVariance >= 0 ? "+" : "−"}
                  {moneyWhole(Math.abs(crossVariance))})
                </dd>
              </div>
            </dl>
          </Card>

          {/* ---- workflow ---- */}
          {canEdit && (
            <Card>
              <CardTitle>Submit for approval</CardTitle>
              <p className="text-sm text-ink-600">
                Submitting locks the takeoff and routes the quote for{" "}
                {requiredApprovals} approval{requiredApprovals > 1 ? "s" : ""}{" "}
                (thresholds are evaluated against the sales price).
              </p>
              <button
                onClick={() => run(() => submitBargeQuote(quote.id))}
                disabled={busy || dirty}
                title={dirty ? "Save your changes first" : undefined}
                className={`${buttonCls("dark")} mt-3`}
              >
                <Send size={14} strokeWidth={2} />
                Submit quote
              </button>
            </Card>
          )}

          {canApprove && (
            <Card>
              <CardTitle>Approval decision</CardTitle>
              <p className="mb-2 text-sm text-ink-600">
                {approvedThisVersion} / {requiredApprovals} approvals granted for
                v{quote.version}.
              </p>
              <input
                type="text"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Comment (required to reject / request changes)"
                className={`${inputCls} w-full`}
              />
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  onClick={() => run(() => approveBargeQuote(quote.id, comment))}
                  disabled={busy}
                  className={buttonCls("success", "sm")}
                >
                  <Check size={13} strokeWidth={2.5} />
                  Approve
                </button>
                <button
                  onClick={() => run(() => requestBargeQuoteChanges(quote.id, comment))}
                  disabled={busy || !comment.trim()}
                  className={buttonCls("warn", "sm")}
                >
                  <MessageSquareWarning size={13} strokeWidth={2} />
                  Request changes
                </button>
                <button
                  onClick={() => run(() => rejectBargeQuote(quote.id, comment))}
                  disabled={busy || !comment.trim()}
                  className={buttonCls("danger", "sm")}
                >
                  <X size={13} strokeWidth={2.5} />
                  Reject
                </button>
              </div>
            </Card>
          )}

          {(props.approvals.length > 0 || quote.status === "submitted") && (
            <Card>
              <CardTitle>Approval history</CardTitle>
              {quote.status === "submitted" && (
                <p className="mb-3 text-sm text-ink-600">
                  Waiting on {Math.max(0, requiredApprovals - approvedThisVersion)}{" "}
                  more approval
                  {requiredApprovals - approvedThisVersion !== 1 ? "s" : ""} for v
                  {quote.version}.
                </p>
              )}
              {props.approvals.length === 0 ? (
                <p className="text-sm text-ink-400">No decisions yet.</p>
              ) : (
                <ul className="space-y-3">
                  {props.approvals.map((a) => (
                    <li key={a.id} className="text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-ink-900">
                          {nameOf(a.approver_id)}
                          <span className="ml-2 text-xs font-normal text-ink-400">
                            v{a.quote_version}
                          </span>
                        </span>
                        <span className="text-xs text-ink-400">
                          {shortDate(a.created_at)}
                        </span>
                      </div>
                      <p
                        className={
                          a.decision === "approved"
                            ? "text-ok-600"
                            : a.decision === "rejected"
                              ? "text-bad-600"
                              : "text-warn-700"
                        }
                      >
                        {a.decision === "approved"
                          ? "Approved"
                          : a.decision === "rejected"
                            ? "Rejected"
                            : "Requested changes"}
                        {a.comment && (
                          <span className="text-ink-600"> — {a.comment}</span>
                        )}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </div>

        {/* ---- right: takeoff, P&L, sensitivity ---- */}
        <div className="space-y-6">
          <Card pad={false}>
            <div className="flex items-baseline justify-between border-b border-line px-6 py-4">
              <CardTitle>Steel takeoff by component</CardTitle>
              <span className="text-xs text-ink-400">
                qty · lb/unit · yield · $/lb editable per line
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-sm">
                <thead className="border-b border-line bg-surface/70 text-left text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
                  <tr>
                    <th className="px-4 py-2.5">Item</th>
                    <th className="px-2 py-2.5 text-right">Qty</th>
                    <th className="px-2 py-2.5">Unit</th>
                    <th className="px-2 py-2.5 text-right">Lb/unit</th>
                    <th className="px-2 py-2.5 text-right">Yield %</th>
                    <th className="px-2 py-2.5 text-right">$/lb</th>
                    <th className="px-2 py-2.5 text-right">Net lbs</th>
                    <th className="px-2 py-2.5 text-right">Ordered</th>
                    <th className="px-2 py-2.5 text-right">Cost</th>
                    <th className="px-2 py-2.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/70">
                  {BARGE_SECTIONS.map((sec) => {
                    const secTotals = r.bySection[sec];
                    return (
                      <SectionRows
                        key={sec}
                        section={sec}
                        draft={draft}
                        canEdit={canEdit}
                        secTotals={secTotals}
                        setLine={setLine}
                        onAdd={() =>
                          setDraft((d) => ({
                            ...d,
                            lines: [
                              ...d.lines,
                              {
                                section: sec,
                                item: "New item",
                                unit: "ft",
                                qty: "0",
                                unit_lb: "0",
                                yield_pct: "90",
                                price_per_lb: "0.85",
                              },
                            ],
                          }))
                        }
                        onDelete={(i) =>
                          setDraft((d) => ({
                            ...d,
                            lines: d.lines.filter((_, j) => j !== i),
                          }))
                        }
                      />
                    );
                  })}
                  <tr className="border-t-2 border-ink-900/80 bg-surface/60 font-semibold">
                    <td className="px-4 py-2.5" colSpan={6}>
                      Total steel
                    </td>
                    <td className="px-2 py-2.5 text-right tabular-nums">
                      {fmtLbs(r.net_lbs)}
                    </td>
                    <td className="px-2 py-2.5 text-right tabular-nums">
                      {fmtLbs(r.ordered_lbs)}
                    </td>
                    <td className="px-2 py-2.5 text-right tabular-nums">
                      {moneyWhole(r.steel_cost)}
                    </td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>

          <Card pad={false}>
            <div className="flex items-baseline justify-between border-b border-line px-6 py-4">
              <CardTitle>Per-unit P&amp;L — component detail</CardTitle>
              <span className="text-xs tabular-nums text-ink-400">
                {pct(marginPct)} {marginLabel.toLowerCase()}
              </span>
            </div>
            <table className="w-full text-sm">
              <tbody className="divide-y divide-line/70">
                {plRows.map((row) => (
                  <tr key={row.label}>
                    <td className="px-6 py-2 text-ink-600">{row.label}</td>
                    <td className="px-6 py-2 text-right tabular-nums">
                      {moneyWhole(row.amount)}
                    </td>
                    <td className="px-6 py-2 text-right tabular-nums text-ink-400">
                      {inputs.sales_price > 0
                        ? pct(row.amount / inputs.sales_price)
                        : "—"}
                    </td>
                  </tr>
                ))}
                <tr className="border-t-2 border-ink-900/80 bg-surface/60 font-semibold">
                  <td className="px-6 py-2">
                    {mode === "direct" ? "Total direct cost" : "Total cost"}
                  </td>
                  <td className="px-6 py-2 text-right tabular-nums">
                    {moneyWhole(cost)}
                  </td>
                  <td className="px-6 py-2 text-right tabular-nums text-ink-400">
                    {inputs.sales_price > 0 ? pct(cost / inputs.sales_price) : "—"}
                  </td>
                </tr>
                <tr className="text-xs text-ink-400">
                  <td className="px-6 py-2">
                    Crosscheck — yard heuristic {fmtLbs(r.net_lbs)} net lbs × $1.50
                  </td>
                  <td className="px-6 py-2 text-right tabular-nums">
                    {moneyWhole(r.crosscheck)}
                  </td>
                  <td className="px-6 py-2 text-right tabular-nums">
                    {crossVariance >= 0 ? "+" : "−"}
                    {moneyWhole(Math.abs(crossVariance))}
                  </td>
                </tr>
                <tr>
                  <td className="px-6 py-2">Sales price</td>
                  <td className="px-6 py-2 text-right tabular-nums">
                    {moneyWhole(inputs.sales_price)}
                  </td>
                  <td className="px-6 py-2 text-right tabular-nums text-ink-400">
                    100.0%
                  </td>
                </tr>
                <tr
                  className={`font-semibold ${margin >= 0 ? "text-ok-600" : "text-bad-600"}`}
                >
                  <td className="px-6 py-2">{marginLabel}</td>
                  <td className="px-6 py-2 text-right tabular-nums">
                    {moneyWhole(margin)}
                  </td>
                  <td className="px-6 py-2 text-right tabular-nums">
                    {pct(marginPct)}
                  </td>
                </tr>
              </tbody>
            </table>
          </Card>

          <Card pad={false}>
            <div className="flex items-baseline justify-between border-b border-line px-6 py-4">
              <CardTitle>Margin sensitivity</CardTitle>
              <span className="text-xs text-ink-400">
                blended steel $/lb × total labor hours — boxed = current
              </span>
            </div>
            <div className="overflow-x-auto p-4">
              <table className="w-full text-center text-xs tabular-nums">
                <thead>
                  <tr className="text-ink-400">
                    <th className="px-2 py-1.5 text-left font-medium">hrs \ $/lb</th>
                    {steelMults.map((sm) => (
                      <th key={sm} className="px-2 py-1.5 font-medium">
                        ${(blendedRate * sm).toFixed(2)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {hourMults.map((hm, i) => (
                    <tr key={hm}>
                      <th className="px-2 py-1 text-left font-medium text-ink-600">
                        {Math.round(r.total_hours * hm).toLocaleString("en-US")}
                      </th>
                      {steelMults.map((sm, j) => {
                        const m = sensitivity[i][j];
                        const current = sm === 1 && hm === 1;
                        return (
                          <td
                            key={sm}
                            className={`px-2 py-1.5 font-medium text-white ${
                              current ? "outline outline-2 -outline-offset-2 outline-navy-900" : ""
                            }`}
                            style={{ background: marginColor(m) }}
                          >
                            {(m * 100).toFixed(0)}%
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 px-1 text-[0.68rem] text-ink-400">
                &lt; 0% red · 0–10% amber · 10–20% light green · &gt; 20% green
              </p>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   One takeoff section: its lines, an add button, and a subtotal row.
--------------------------------------------------------------------------- */
function SectionRows({
  section,
  draft,
  canEdit,
  secTotals,
  setLine,
  onAdd,
  onDelete,
}: {
  section: BargeSection;
  draft: { lines: DraftLine[] };
  canEdit: boolean;
  secTotals: { netLbs: number; orderedLbs: number; steelCost: number };
  setLine: (i: number, key: keyof DraftLine, value: string) => void;
  onAdd: () => void;
  onDelete: (i: number) => void;
}) {
  return (
    <>
      <tr className="bg-brand-50/60">
        <td
          colSpan={10}
          className="px-4 py-1.5 text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-brand-700"
        >
          {BARGE_SECTION_LABELS[section]}
        </td>
      </tr>
      {draft.lines.map((l, i) => {
        if (l.section !== section) return null;
        const c = computeSteelLine({
          section: l.section,
          item: l.item,
          unit: l.unit as QuoteInputs["lines"][number]["unit"],
          qty: num(l.qty),
          unit_lb: num(l.unit_lb),
          yield_pct: Math.min(100, Math.max(0.01, num(l.yield_pct) || 100)),
          price_per_lb: num(l.price_per_lb),
        });
        return (
          <tr key={i}>
            <td className="px-4 py-1.5">
              <input
                type="text"
                value={l.item}
                onChange={(e) => setLine(i, "item", e.target.value)}
                disabled={!canEdit}
                className={`${inputCls} w-full min-w-56`}
              />
            </td>
            <td className="px-2 py-1.5 text-right">
              <input
                type="number"
                step="any"
                value={l.qty}
                onChange={(e) => setLine(i, "qty", e.target.value)}
                disabled={!canEdit}
                className={`${inputCls} w-20 text-right`}
              />
            </td>
            <td className="px-2 py-1.5">
              <select
                value={l.unit}
                onChange={(e) => setLine(i, "unit", e.target.value)}
                disabled={!canEdit}
                className={`${inputCls} w-20`}
              >
                {BARGE_LINE_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </td>
            <td className="px-2 py-1.5 text-right">
              <input
                type="number"
                step="any"
                value={l.unit_lb}
                onChange={(e) => setLine(i, "unit_lb", e.target.value)}
                disabled={!canEdit}
                className={`${inputCls} w-24 text-right`}
              />
            </td>
            <td className="px-2 py-1.5 text-right">
              <input
                type="number"
                step="any"
                value={l.yield_pct}
                onChange={(e) => setLine(i, "yield_pct", e.target.value)}
                disabled={!canEdit}
                className={`${inputCls} w-20 text-right`}
              />
            </td>
            <td className="px-2 py-1.5 text-right">
              <input
                type="number"
                step={0.01}
                value={l.price_per_lb}
                onChange={(e) => setLine(i, "price_per_lb", e.target.value)}
                disabled={!canEdit}
                className={`${inputCls} w-20 text-right`}
              />
            </td>
            <td className="px-2 py-1.5 text-right tabular-nums text-ink-600">
              {fmtLbs(c.netLbs)}
            </td>
            <td className="px-2 py-1.5 text-right tabular-nums text-ink-600">
              {fmtLbs(c.orderedLbs)}
            </td>
            <td className="px-2 py-1.5 text-right tabular-nums">
              {moneyWhole(c.steelCost)}
            </td>
            <td className="px-2 py-1.5 text-right">
              {canEdit && (
                <button
                  onClick={() => onDelete(i)}
                  title="Remove line"
                  className="text-ink-400 hover:text-bad-600"
                >
                  <X size={14} strokeWidth={2} />
                </button>
              )}
            </td>
          </tr>
        );
      })}
      <tr className="bg-surface/40 text-xs">
        <td colSpan={6} className="px-4 py-1.5 text-right text-ink-400">
          Subtotal — {BARGE_SECTION_LABELS[section]}
        </td>
        <td className="px-2 py-1.5 text-right tabular-nums text-ink-600">
          {fmtLbs(secTotals.netLbs)}
        </td>
        <td className="px-2 py-1.5 text-right tabular-nums text-ink-600">
          {fmtLbs(secTotals.orderedLbs)}
        </td>
        <td className="px-2 py-1.5 text-right tabular-nums text-ink-600">
          {moneyWhole(secTotals.steelCost)}
        </td>
        <td className="px-2 py-1.5 text-right">
          {canEdit && (
            <button
              onClick={onAdd}
              title={`Add line to ${BARGE_SECTION_LABELS[section]}`}
              className="rounded-md border border-dashed border-line px-1.5 py-0.5 text-brand-600 transition-colors hover:bg-brand-50"
            >
              <Plus size={12} strokeWidth={2} />
            </button>
          )}
        </td>
      </tr>
    </>
  );
}
