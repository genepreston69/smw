"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  ClipboardCheck,
  Download,
  HelpCircle,
  MessageSquareWarning,
  Plus,
  Send,
  Settings2,
  Ship,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import {
  addLineItem,
  addPhase,
  approvePlan,
  deleteLineItem,
  deletePhase,
  deletePlan,
  rejectPlan,
  requestChanges,
  submitPlan,
  updateLineItem,
  updatePlanFields,
  type LineItemInput,
} from "@/app/(app)/plans/actions";
import {
  computeLineCosts,
  sumCosts,
  type LineCosts,
  type PlanParams,
} from "@/lib/costing";
import { money, pct, hours, shortDate } from "@/lib/format";
import { StatusBadge } from "@/components/StatusBadge";
import { buttonCls } from "@/components/ui";
import type {
  Approval,
  ApprovalThreshold,
  MaterialBasis,
  PlanLineItem,
  PlanPhase,
  Profile,
  ProjectPlan,
} from "@/lib/types";

const STEPS = [
  { label: "Project", icon: Ship },
  { label: "Rates", icon: Settings2 },
  { label: "Scope", icon: Wrench },
  { label: "Review", icon: ClipboardCheck },
] as const;

const PRIORITY_NOTES: Record<number, string> = {
  1: "Base scope",
  2: "Additional work",
  3: "Additional work",
};

const inputCls =
  "mt-1 w-full rounded-md border border-line bg-white px-2.5 py-1.5 text-sm text-ink-900 placeholder:text-ink-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500/25 disabled:bg-surface disabled:text-ink-400 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";

const cardCls =
  "rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(13,36,56,0.05)]";

interface Props {
  plan: ProjectPlan;
  phases: PlanPhase[];
  items: PlanLineItem[];
  approvals: Approval[];
  thresholds: ApprovalThreshold[];
  customers: { id: string; display_name: string }[];
  jobs: { id: string; name: string; customer_id: string | null }[];
  profiles: Profile[];
  me: Profile;
  actuals?: {
    total: number;
    hours: number;
    byCategory: { name: string; amount: number }[];
  } | null;
}

type Draft = LineItemInput & { id: string; dirty?: boolean };

function toDraft(li: PlanLineItem): Draft {
  return {
    id: li.id,
    phase_id: li.phase_id,
    description: li.description,
    priority: li.priority,
    is_tbd: li.is_tbd,
    events: Number(li.events),
    hours_per_piece: Number(li.hours_per_piece),
    quantity: Number(li.quantity),
    labor_bill_rate:
      li.labor_bill_rate === null ? null : Number(li.labor_bill_rate),
    material_basis: li.material_basis,
    length_per_piece: Number(li.length_per_piece),
    weight_per_lf: Number(li.weight_per_lf),
    unit_cost: Number(li.unit_cost),
    lump_sum_cost: Number(li.lump_sum_cost),
    material_markup_pct: Number(li.material_markup_pct),
  };
}

function newDraft(phaseId: string | null): Draft {
  return {
    id: "",
    phase_id: phaseId,
    description: "",
    priority: 1,
    is_tbd: false,
    events: 1,
    hours_per_piece: 0,
    quantity: 1,
    labor_bill_rate: null,
    material_basis: "per_each",
    length_per_piece: 0,
    weight_per_lf: 0,
    unit_cost: 0,
    lump_sum_cost: 0,
    material_markup_pct: 0.3,
  };
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

export function PlanWizard(props: Props) {
  const { plan, phases, thresholds, profiles, me } = props;
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isCreator = plan.created_by === me.id;
  const isAdmin = me.role === "admin";
  const canEdit =
    (isCreator || isAdmin) &&
    (plan.status === "draft" || plan.status === "changes_requested") &&
    (me.role === "estimator" || isAdmin);
  const canApprove =
    (me.role === "approver" || isAdmin) &&
    plan.status === "submitted" &&
    !isCreator;
  // Mirrors the plans_delete RLS policy: admins any plan, creators own drafts.
  const canDelete = isAdmin || (isCreator && plan.status === "draft");

  // Editors walk the wizard; everyone else lands on the review summary.
  const [step, setStep] = useState(canEdit ? 0 : 3);

  // --- plan header/params local state -------------------------------------
  const [params, setParams] = useState<PlanParams>({
    labor_cost_rate: Number(plan.labor_cost_rate),
    default_labor_bill_rate: Number(plan.default_labor_bill_rate),
    consumables_pct: Number(plan.consumables_pct),
    overhead_pool:
      plan.overhead_pool === null ? null : Number(plan.overhead_pool),
  });
  const [info, setInfo] = useState({
    title: plan.title,
    customer_id: plan.customer_id,
    job_id: plan.job_id,
    department: plan.department ?? "",
    project_manager: plan.project_manager ?? "",
    contact_name: plan.contact_name ?? "",
    contact_phone: plan.contact_phone ?? "",
    contact_email: plan.contact_email ?? "",
    payment_terms_days:
      plan.payment_terms_days === null ? null : Number(plan.payment_terms_days),
    start_date: plan.start_date ?? "",
    end_date: plan.end_date ?? "",
    notes: plan.notes ?? "",
  });
  const [headerDirty, setHeaderDirty] = useState(false);

  // --- line items local state ----------------------------------------------
  const [rows, setRows] = useState<Draft[]>(props.items.map(toDraft));
  const [adding, setAdding] = useState<Draft | null>(null);
  const [newPhaseName, setNewPhaseName] = useState("");

  // Re-sync rows whenever the server sends fresh items (e.g. after adding or
  // deleting a line), keeping any rows with unsaved local edits.
  const [syncedItems, setSyncedItems] = useState(props.items);
  if (props.items !== syncedItems) {
    setSyncedItems(props.items);
    setRows((rs) =>
      props.items.map((li) => {
        const local = rs.find((r) => r.id === li.id);
        return local?.dirty ? local : toDraft(li);
      }),
    );
  }

  const costs = useMemo(() => computeLineCosts(rows, params), [rows, params]);
  const totals = useMemo(() => sumCosts(costs), [costs]);
  const tbdCount = rows.filter((r) => r.is_tbd).length;
  const dirtyCount = rows.filter((r) => r.dirty).length + (adding ? 1 : 0);

  const requiredApprovals = useMemo(() => {
    const t = thresholds.find(
      (t) =>
        totals.totalPrice >= Number(t.min_amount) &&
        (t.max_amount === null || totals.totalPrice < Number(t.max_amount)),
    );
    return t?.required_approvals ?? 1;
  }, [thresholds, totals.totalPrice]);

  const approvedThisVersion = props.approvals.filter(
    (a) => a.plan_version === plan.version && a.decision === "approved",
  ).length;

  const priorityTotals = useMemo(() => {
    const map = new Map<
      number,
      { cost: number; price: number; count: number }
    >();
    rows.forEach((r, i) => {
      const cur = map.get(r.priority) ?? { cost: 0, price: 0, count: 0 };
      cur.cost += costs[i].lineCost;
      cur.price += costs[i].linePrice;
      cur.count += 1;
      map.set(r.priority, cur);
    });
    return map;
  }, [rows, costs]);

  // Pre-flight checks shown on the review step — advisory except where the
  // database also enforces the rule at submit/approve time.
  const warnings = useMemo(() => {
    const w: { text: string; blocking: boolean }[] = [];
    if (!info.customer_id)
      w.push({
        text: "No customer selected — required before submitting.",
        blocking: true,
      });
    if (params.overhead_pool === null)
      w.push({
        text: "Overhead pool is not set — required before submitting.",
        blocking: true,
      });
    if (tbdCount > 0)
      w.push({
        text: `${tbdCount} TBD line${tbdCount > 1 ? "s" : ""} — approval is blocked until resolved.`,
        blocking: false,
      });
    rows.forEach((r, i) => {
      if (costs[i].linePrice > 0 && costs[i].profit < 0)
        w.push({
          text: `"${r.description || "Untitled line"}" prices below cost (${money(costs[i].profit)}).`,
          blocking: false,
        });
      if (costs[i].materialCost > 0 && r.material_markup_pct === 0)
        w.push({
          text: `"${r.description || "Untitled line"}" has material at 0% markup.`,
          blocking: false,
        });
    });
    if (params.default_labor_bill_rate < params.labor_cost_rate)
      w.push({
        text: "Default billing rate is below the labor cost rate — every labor hour loses money.",
        blocking: false,
      });
    if (totals.totalPrice > 0 && totals.profitPct < 0.1)
      w.push({
        text: `Blended margin is ${pct(totals.profitPct)} — below a 10% floor.`,
        blocking: false,
      });
    if (dirtyCount > 0)
      w.push({
        text: `${dirtyCount} line item${dirtyCount > 1 ? "s have" : " has"} unsaved edits — save them on the Scope step.`,
        blocking: true,
      });
    return w;
  }, [info.customer_id, params, tbdCount, rows, costs, totals, dirtyCount]);

  const nameOf = (id: string) => {
    const p = profiles.find((p) => p.id === id);
    return p?.full_name || p?.email || "Unknown";
  };

  // --- helpers ---------------------------------------------------------------
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

  function saveHeader(onSaved?: () => void) {
    run(() =>
      updatePlanFields(plan.id, {
        title: info.title,
        customer_id: info.customer_id,
        job_id: info.job_id,
        department: info.department || null,
        project_manager: info.project_manager || null,
        contact_name: info.contact_name || null,
        contact_phone: info.contact_phone || null,
        contact_email: info.contact_email || null,
        payment_terms_days: info.payment_terms_days,
        start_date: info.start_date || null,
        end_date: info.end_date || null,
        notes: info.notes || null,
        labor_cost_rate: params.labor_cost_rate,
        default_labor_bill_rate: params.default_labor_bill_rate,
        consumables_pct: params.consumables_pct,
        overhead_pool: params.overhead_pool,
      }).then((r) => {
        if (r.ok) {
          setHeaderDirty(false);
          onSaved?.();
        }
        return r;
      }),
    );
  }

  // Moving between steps autosaves pending header/rate edits so nothing is
  // lost — line items keep their explicit per-card save.
  function goToStep(i: number) {
    if (i === step || i < 0 || i >= STEPS.length) return;
    if (canEdit && headerDirty) saveHeader(() => setStep(i));
    else setStep(i);
  }

  function patchInfo(patch: Partial<typeof info>) {
    setInfo((v) => ({ ...v, ...patch }));
    setHeaderDirty(true);
  }

  function patchParams(patch: Partial<PlanParams>) {
    setParams((v) => ({ ...v, ...patch }));
    setHeaderDirty(true);
  }

  function patchRow(idx: number, patch: Partial<Draft>) {
    setRows((rs) =>
      rs.map((r, i) => (i === idx ? { ...r, ...patch, dirty: true } : r)),
    );
  }

  function saveRow(idx: number) {
    const row = rows[idx];
    const { id, dirty: _dirty, ...fields } = row;
    void _dirty;
    run(() =>
      updateLineItem(plan.id, id, fields).then((r) => {
        if (r.ok)
          setRows((rs) =>
            rs.map((x, i) => (i === idx ? { ...x, dirty: false } : x)),
          );
        return r;
      }),
    );
  }

  function removeRow(idx: number) {
    const row = rows[idx];
    run(() =>
      deleteLineItem(plan.id, row.id).then((r) => {
        if (r.ok) setRows((rs) => rs.filter((_, i) => i !== idx));
        return r;
      }),
    );
  }

  function addRow() {
    if (!adding) return;
    const { id: _id, dirty: _dirty, ...fields } = adding;
    void _id;
    void _dirty;
    run(() =>
      addLineItem(plan.id, fields).then((r) => {
        if (r.ok) setAdding(null);
        return r;
      }),
    );
  }

  function removePlan() {
    if (
      !window.confirm(
        `Delete "${plan.title}"? This permanently removes the plan and all its line items.`,
      )
    )
      return;
    setError(null);
    setBusy(true);
    startTransition(async () => {
      const res = await deletePlan(plan.id);
      if (!res.ok) {
        setError(res.error ?? "Failed");
        setBusy(false);
      } else {
        router.push("/plans");
      }
    });
  }

  const addingCosts: LineCosts | null = adding
    ? computeLineCosts([adding], params)[0]
    : null;

  // ---------------------------------------------------------------------------
  return (
    <div className="space-y-6 pb-24">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            {canEdit ? (
              <input
                value={info.title}
                onChange={(e) => patchInfo({ title: e.target.value })}
                className="rounded-lg border border-transparent px-1 text-[1.6rem] font-semibold tracking-tight text-ink-900 hover:border-line focus:border-brand-500 focus:outline-none"
              />
            ) : (
              <h1 className="text-[1.6rem] font-semibold tracking-tight text-ink-900">
                {plan.title}
              </h1>
            )}
            <StatusBadge status={plan.status} />
            {plan.version > 1 && (
              <span className="text-sm text-ink-400">v{plan.version}</span>
            )}
          </div>
          <p className="mt-1 text-sm text-ink-600">
            Created by {nameOf(plan.created_by)} · Updated{" "}
            {shortDate(plan.updated_at)}
            {tbdCount > 0 && (
              <span className="ml-2 rounded-full border border-warn-700/25 bg-warn-50 px-2 py-0.5 text-xs font-medium text-warn-700">
                {tbdCount} TBD line{tbdCount > 1 ? "s" : ""} — approval blocked
              </span>
            )}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <a
            href={`/api/export/plan?id=${plan.id}`}
            title="Download line items and totals as CSV"
            className={buttonCls("secondary")}
          >
            <Download size={15} strokeWidth={2} />
            Export CSV
          </a>
          {canDelete && (
            <button
              onClick={removePlan}
              disabled={busy}
              title="Delete this plan and all its line items"
              className={buttonCls("secondary")}
            >
              <Trash2 size={15} strokeWidth={2} />
              Delete
            </button>
          )}
          {canEdit && headerDirty && (
            <button
              onClick={() => saveHeader()}
              disabled={busy}
              className={buttonCls("primary")}
            >
              Save plan details
            </button>
          )}
        </div>
      </div>

      {/* Step rail */}
      <nav className="flex flex-wrap items-center gap-1.5" aria-label="Wizard steps">
        {STEPS.map((s, i) => {
          const Icon = s.icon;
          const active = i === step;
          return (
            <button
              key={s.label}
              onClick={() => goToStep(i)}
              className={`inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                active
                  ? "bg-navy-900 text-white"
                  : "border border-line bg-white text-ink-600 hover:border-brand-500/40 hover:text-ink-900"
              }`}
            >
              <span
                className={`flex h-4.5 w-4.5 items-center justify-center rounded-full text-[0.62rem] ${
                  active ? "bg-white/15 text-white" : "bg-surface text-ink-400"
                }`}
              >
                {i + 1}
              </span>
              <Icon size={13} strokeWidth={2} />
              {s.label}
            </button>
          );
        })}
      </nav>

      {error && (
        <div className="rounded-lg border border-bad-600/25 bg-bad-50 px-4 py-2.5 text-sm text-bad-600">
          {error}
        </div>
      )}

      {/* Approval banner */}
      {plan.status === "submitted" && (
        <div className="rounded-xl border border-brand-500/25 bg-brand-50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-brand-700">
              <span className="font-semibold">Awaiting approval:</span>{" "}
              {approvedThisVersion} of {requiredApprovals} required approval
              {requiredApprovals > 1 ? "s" : ""} · {money(totals.totalPrice)}{" "}
              total
              {tbdCount > 0 && (
                <span className="ml-2 font-medium text-warn-700">
                  {tbdCount} TBD line{tbdCount > 1 ? "s" : ""} must be resolved
                  before approval
                </span>
              )}
            </p>
            {canApprove && (
              <ApprovalActions
                planId={plan.id}
                run={run}
                busy={busy}
                tbdBlocked={tbdCount > 0}
              />
            )}
          </div>
        </div>
      )}

      {/* ---------- STEP 1 · PROJECT ---------- */}
      {step === 0 && (
        <section aria-label="Project details" className={`${cardCls} p-6`}>
          <StepIntro
            title="Project"
            text="Who the work is for and when it happens. Customer and job link the plan to QuickBooks actuals."
          />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <Field label="Customer">
              {canEdit ? (
                <select
                  value={info.customer_id ?? ""}
                  onChange={(e) =>
                    patchInfo({ customer_id: e.target.value || null })
                  }
                  className={inputCls}
                >
                  <option value="">— Select —</option>
                  {props.customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.display_name}
                    </option>
                  ))}
                </select>
              ) : (
                (props.customers.find((c) => c.id === plan.customer_id)
                  ?.display_name ?? "—")
              )}
            </Field>
            <Field label="QuickBooks job" hint="Optional — links actual costs.">
              {canEdit ? (
                <select
                  value={info.job_id ?? ""}
                  onChange={(e) => patchInfo({ job_id: e.target.value || null })}
                  className={inputCls}
                >
                  <option value="">— None —</option>
                  {props.jobs
                    .filter(
                      (j) =>
                        !info.customer_id || j.customer_id === info.customer_id,
                    )
                    .map((j) => (
                      <option key={j.id} value={j.id}>
                        {j.name}
                      </option>
                    ))}
                </select>
              ) : (
                (props.jobs.find((j) => j.id === plan.job_id)?.name ?? "—")
              )}
            </Field>
            <Field label="Project manager">
              <TextOrInput
                edit={canEdit}
                value={info.project_manager}
                onChange={(v) => patchInfo({ project_manager: v })}
              />
            </Field>
            <Field label="Customer contact">
              <TextOrInput
                edit={canEdit}
                value={info.contact_name}
                onChange={(v) => patchInfo({ contact_name: v })}
              />
            </Field>
            <Field label="Contact phone">
              <TextOrInput
                edit={canEdit}
                value={info.contact_phone}
                onChange={(v) => patchInfo({ contact_phone: v })}
              />
            </Field>
            <Field label="Contact email">
              <TextOrInput
                edit={canEdit}
                value={info.contact_email}
                onChange={(v) => patchInfo({ contact_email: v })}
              />
            </Field>
            <Field label="Department">
              <TextOrInput
                edit={canEdit}
                value={info.department}
                onChange={(v) => patchInfo({ department: v })}
              />
            </Field>
            <Field label="Payment terms (days)">
              {canEdit ? (
                <input
                  type="number"
                  step="1"
                  min={0}
                  value={info.payment_terms_days ?? ""}
                  placeholder="e.g. 30"
                  onChange={(e) =>
                    patchInfo({
                      payment_terms_days:
                        e.target.value === ""
                          ? null
                          : Math.max(0, Math.round(Number(e.target.value)) || 0),
                    })
                  }
                  className={inputCls}
                />
              ) : info.payment_terms_days === null ? (
                "—"
              ) : (
                `Net ${info.payment_terms_days}`
              )}
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Start date">
                {canEdit ? (
                  <input
                    type="date"
                    value={info.start_date}
                    onChange={(e) => patchInfo({ start_date: e.target.value })}
                    className={inputCls}
                  />
                ) : (
                  shortDate(plan.start_date)
                )}
              </Field>
              <Field label="End date">
                {canEdit ? (
                  <input
                    type="date"
                    value={info.end_date}
                    onChange={(e) => patchInfo({ end_date: e.target.value })}
                    className={inputCls}
                  />
                ) : (
                  shortDate(plan.end_date)
                )}
              </Field>
            </div>
            <Field label="Notes" w="md:col-span-3">
              {canEdit ? (
                <textarea
                  value={info.notes}
                  rows={2}
                  onChange={(e) => patchInfo({ notes: e.target.value })}
                  className={inputCls}
                />
              ) : (
                (plan.notes ?? "—")
              )}
            </Field>
          </div>
        </section>
      )}

      {/* ---------- STEP 2 · RATES ---------- */}
      {step === 1 && (
        <section aria-label="Rates and pools" className={`${cardCls} p-6`}>
          <StepIntro
            title="Rates & pools"
            text="The four levers that drive every line. Set them once — each line item can still override its billing rate and markup."
          />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
            <Field
              label="Labor cost rate ($/hr)"
              hint="Fully burdened internal cost — wages, benefits, taxes."
            >
              <NumOrText
                edit={canEdit}
                value={params.labor_cost_rate}
                onChange={(v) => patchParams({ labor_cost_rate: v })}
              />
            </Field>
            <Field
              label="Default billing rate ($/hr)"
              hint="Customer-facing rate. Specialty rates override per line."
            >
              <NumOrText
                edit={canEdit}
                value={params.default_labor_bill_rate}
                onChange={(v) => patchParams({ default_labor_bill_rate: v })}
              />
            </Field>
            <Field
              label="Consumables (% of labor price)"
              hint="Welding wire, gas, abrasives, PPE. Passed through at cost."
            >
              {canEdit ? (
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    step="any"
                    min={0}
                    max={100}
                    value={round2(params.consumables_pct * 100)}
                    onChange={(e) =>
                      patchParams({
                        consumables_pct: (parseFloat(e.target.value) || 0) / 100,
                      })
                    }
                    className={inputCls}
                  />
                  <span className="mt-1 text-ink-400">%</span>
                </div>
              ) : (
                pct(params.consumables_pct)
              )}
            </Field>
            <Field
              label={
                <>
                  Overhead pool ($)
                  {params.overhead_pool === null && (
                    <span className="ml-1 font-normal normal-case tracking-normal text-bad-600">
                      required
                    </span>
                  )}
                </>
              }
              hint="Allocated across lines by share of labor + material cost."
            >
              {canEdit ? (
                <input
                  type="number"
                  step="any"
                  min={0}
                  value={params.overhead_pool ?? ""}
                  placeholder="Required before submit"
                  onChange={(e) =>
                    patchParams({
                      overhead_pool:
                        e.target.value === ""
                          ? null
                          : parseFloat(e.target.value) || 0,
                    })
                  }
                  className={`${inputCls} ${params.overhead_pool === null ? "border-bad-600/40 bg-bad-50" : ""}`}
                />
              ) : params.overhead_pool === null ? (
                "—"
              ) : (
                money(params.overhead_pool)
              )}
            </Field>
          </div>
          <div className="mt-5 flex items-start gap-2 rounded-lg bg-brand-50 px-4 py-3 text-sm text-ink-900">
            <CircleDollarSign
              size={16}
              className="mt-0.5 shrink-0 text-brand-600"
              aria-hidden="true"
            />
            <span>
              Labor margin at these rates:{" "}
              <strong className="tabular-nums">
                {params.default_labor_bill_rate > 0
                  ? pct(
                      (params.default_labor_bill_rate -
                        params.labor_cost_rate) /
                        params.default_labor_bill_rate,
                    )
                  : "—"}
              </strong>{" "}
              on every billed hour ({money(params.default_labor_bill_rate)}{" "}
              billed vs {money(params.labor_cost_rate)} loaded cost).
            </span>
          </div>
        </section>
      )}

      {/* ---------- STEP 3 · SCOPE ---------- */}
      {step === 2 && (
        <section aria-label="Scope and line items">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <StepIntro
              title="Scope of work"
              text="One card per work package or material takeoff. Prices update as you type; save each card when it's ready."
              tight
            />
            {canEdit && (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={newPhaseName}
                  onChange={(e) => setNewPhaseName(e.target.value)}
                  placeholder="New phase name"
                  className="rounded-md border border-line bg-white px-2.5 py-1.5 text-sm text-ink-900 placeholder:text-ink-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500/25"
                />
                <button
                  onClick={() =>
                    run(() =>
                      addPhase(plan.id, newPhaseName).then((r) => {
                        if (r.ok) setNewPhaseName("");
                        return r;
                      }),
                    )
                  }
                  disabled={busy || !newPhaseName.trim()}
                  className={buttonCls("secondary", "sm")}
                >
                  <Plus size={13} strokeWidth={2} />
                  Add phase
                </button>
                <button
                  onClick={() => setAdding((a) => a ?? newDraft(null))}
                  disabled={busy || adding !== null}
                  className={buttonCls("dark", "sm")}
                >
                  <Plus size={13} strokeWidth={2} />
                  Add line item
                </button>
              </div>
            )}
          </div>

          {rows.length === 0 && !adding && (
            <div className="rounded-xl border border-dashed border-line bg-white/60 p-10 text-center text-sm text-ink-600">
              {canEdit
                ? "No line items yet. Add the first work package — dry docking is usually line one."
                : "No line items."}
            </div>
          )}

          <div className="space-y-3">
            {rows.map((row, i) => (
              <LineCard
                key={row.id}
                row={row}
                cost={costs[i]}
                phases={phases}
                edit={canEdit}
                busy={busy}
                onPatch={(p) => patchRow(i, p)}
                onSave={() => saveRow(i)}
                onDelete={() => removeRow(i)}
              />
            ))}
            {canEdit && adding && addingCosts && (
              <LineCard
                isNew
                row={adding}
                cost={addingCosts}
                phases={phases}
                edit
                busy={busy}
                onPatch={(p) => setAdding((a) => (a ? { ...a, ...p } : a))}
                onSave={addRow}
                onDelete={() => setAdding(null)}
              />
            )}
          </div>

          {canEdit && phases.length > 0 && (
            <div className="mt-4 text-xs text-ink-600">
              Phases:{" "}
              {phases.map((ph) => (
                <span
                  key={ph.id}
                  className="mr-2 inline-flex items-center gap-1 rounded-full border border-line bg-white px-2 py-0.5"
                >
                  {ph.name}
                  <button
                    onClick={() => run(() => deletePhase(plan.id, ph.id))}
                    className="text-ink-400 transition-colors hover:text-bad-600"
                    title="Delete phase (line items keep their data)"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </section>
      )}

      {/* ---------- STEP 4 · REVIEW ---------- */}
      {step === 3 && (
        <section aria-label="Review and submit" className="space-y-6">
          <StepIntro
            title="Review & submit"
            text="Every number below is computed from the lines you entered — nothing is typed twice."
            tight
          />

          <div className="grid gap-6 lg:grid-cols-2">
            {/* Profitability */}
            <div className={`${cardCls} p-5`}>
              <h3 className="mb-3 text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
                Profitability breakdown
              </h3>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
                    <td />
                    <td className="pb-1.5 text-right">Cost</td>
                    <td className="pb-1.5 text-right">Price</td>
                  </tr>
                </thead>
                <tbody>
                  <Trow
                    l={`Labor (${hours(totals.totalHours)})`}
                    c={totals.laborCost}
                    p={totals.laborPrice}
                  />
                  <Trow
                    l="Material"
                    c={totals.materialCost}
                    p={totals.materialPrice}
                  />
                  <Trow
                    l="Consumables"
                    c={totals.consumables}
                    p={totals.consumables}
                  />
                  <Trow l="Overhead" c={totals.overhead} p={totals.overhead} />
                  <tr className="border-t border-line font-semibold text-ink-900">
                    <td className="py-1.5">Total</td>
                    <td className="py-1.5 text-right tabular-nums">
                      {money(totals.totalCost)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {money(totals.totalPrice)}
                    </td>
                  </tr>
                  <tr
                    className={`font-medium ${totals.profit >= 0 ? "text-ok-600" : "text-bad-600"}`}
                  >
                    <td className="py-1.5">Profit / margin</td>
                    <td className="py-1.5 text-right tabular-nums" colSpan={2}>
                      {money(totals.profit)} · {pct(totals.profitPct)}
                    </td>
                  </tr>
                </tbody>
              </table>
              <p className="mt-3 text-xs text-ink-400">
                {money(totals.totalPrice)} requires {requiredApprovals} approval
                {requiredApprovals > 1 ? "s" : ""}.
              </p>
            </div>

            {/* Priority breakdown */}
            <div className={`${cardCls} p-5`}>
              <h3 className="mb-3 text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
                By priority
              </h3>
              <div className="space-y-2">
                {[1, 2, 3].map((p) => {
                  const t = priorityTotals.get(p);
                  return (
                    <div
                      key={p}
                      className={`flex items-center justify-between rounded-md border px-3 py-2 text-sm ${
                        t
                          ? "border-line bg-white text-ink-900"
                          : "border-dashed border-line text-ink-400"
                      }`}
                    >
                      <span className="font-medium">
                        Priority {p}{" "}
                        <span className="font-normal text-ink-400">
                          · {PRIORITY_NOTES[p]}
                          {t ? ` · ${t.count} line${t.count > 1 ? "s" : ""}` : ""}
                        </span>
                      </span>
                      <span className="tabular-nums">
                        {t ? money(t.price) : "—"}
                      </span>
                    </div>
                  );
                })}
              </div>

              {props.actuals && (
                <div className="mt-4 border-t border-line/70 pt-3">
                  <h4 className="mb-2 text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
                    Actuals from QuickBooks
                  </h4>
                  <div className="flex justify-between py-0.5 text-sm">
                    <span className="text-ink-600">Actual cost to date</span>
                    <span
                      className={`font-medium tabular-nums ${props.actuals.total > totals.totalCost ? "text-bad-600" : "text-ink-900"}`}
                    >
                      {money(props.actuals.total)}
                    </span>
                  </div>
                  <div className="flex justify-between py-0.5 text-sm text-ink-600">
                    <span>vs. estimated cost</span>
                    <span className="tabular-nums">
                      {money(totals.totalCost)}
                    </span>
                  </div>
                  {props.actuals.hours > 0 && (
                    <div className="flex justify-between py-0.5 text-sm text-ink-600">
                      <span>Actual labor hours</span>
                      <span className="tabular-nums">
                        {hours(props.actuals.hours)} /{" "}
                        {hours(totals.totalHours)} est.
                      </span>
                    </div>
                  )}
                  {props.actuals.byCategory.slice(0, 5).map((c) => (
                    <div
                      key={c.name}
                      className="flex justify-between py-0.5 text-xs text-ink-400"
                    >
                      <span className="truncate pr-2">{c.name}</span>
                      <span className="tabular-nums">{money(c.amount)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Pre-flight checks */}
          {warnings.length > 0 && (
            <div className="rounded-xl border border-warn-700/25 bg-warn-50 p-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-warn-700">
                <AlertTriangle size={16} aria-hidden="true" /> Pre-flight checks
              </div>
              <ul className="space-y-1 text-sm text-ink-900">
                {warnings.map((w, i) => (
                  <li key={i}>
                    • {w.text}
                    {w.blocking && (
                      <span className="ml-1.5 rounded bg-warn-700/10 px-1 text-[10px] font-bold uppercase text-warn-700">
                        blocks submit
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Submit */}
          {canEdit && (
            <div className={`${cardCls} flex flex-wrap items-center justify-between gap-3 p-5`}>
              <p className="text-sm text-ink-600">
                Submitting locks the plan for editing and routes it for{" "}
                {requiredApprovals} approval{requiredApprovals > 1 ? "s" : ""}.
              </p>
              <button
                onClick={() => run(() => submitPlan(plan.id))}
                disabled={busy || headerDirty || dirtyCount > 0}
                title={
                  headerDirty
                    ? "Save plan details first"
                    : dirtyCount > 0
                      ? "Save or discard line item edits first"
                      : "Submit for approval"
                }
                className={buttonCls("dark")}
              >
                <Send size={15} strokeWidth={2} />
                Submit for approval
              </button>
            </div>
          )}

          {/* Approval history */}
          {props.approvals.length > 0 && (
            <div className={`${cardCls} p-5`}>
              <h3 className="mb-3 text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
                Approval history
              </h3>
              <ul className="space-y-2.5 text-sm">
                {props.approvals.map((a) => (
                  <li key={a.id} className="flex items-start gap-2.5">
                    <span
                      className={`mt-1.5 h-2 w-2 flex-none rounded-full ${
                        a.decision === "approved"
                          ? "bg-ok-600"
                          : a.decision === "rejected"
                            ? "bg-bad-600"
                            : "bg-warn-700"
                      }`}
                    />
                    <div>
                      <span className="font-medium text-ink-900">
                        {nameOf(a.approver_id)}
                      </span>{" "}
                      <span className="text-ink-600">
                        {a.decision.replace("_", " ")} v{a.plan_version} ·{" "}
                        {shortDate(a.created_at)}
                      </span>
                      {a.comment && (
                        <p className="text-ink-600">
                          &ldquo;{a.comment}&rdquo;
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {/* ===== live margin ticker + step nav ===== */}
      <footer className="fixed bottom-0 left-48 right-0 z-20 border-t border-navy-800 bg-navy-950">
        <div className="mx-auto flex w-full max-w-[1480px] items-center gap-6 overflow-x-auto px-6 py-3">
          <Tick label="Lines" v={String(rows.length)} />
          <Tick
            label="Hours"
            v={totals.totalHours.toLocaleString("en-US", {
              maximumFractionDigits: 1,
            })}
          />
          <Tick label="Cost" v={money(totals.totalCost)} />
          <Tick label="Price" v={money(totals.totalPrice)} />
          <Tick
            label="Profit"
            v={money(totals.profit)}
            tone={totals.profit >= 0 ? "ok" : "bad"}
          />
          <Tick
            label="Margin"
            v={totals.totalPrice > 0 ? pct(totals.profitPct) : "—"}
            tone={
              totals.totalPrice <= 0
                ? undefined
                : totals.profitPct >= 0.3
                  ? "ok"
                  : totals.profitPct >= 0.15
                    ? "warn"
                    : "bad"
            }
          />

          <div className="ml-auto flex items-center gap-2">
            {step > 0 && (
              <button
                onClick={() => goToStep(step - 1)}
                className="flex items-center gap-1 rounded-md px-3 py-2 text-sm font-medium text-white/60 transition-colors hover:text-white"
              >
                <ChevronLeft size={15} aria-hidden="true" /> Back
              </button>
            )}
            {step < STEPS.length - 1 && (
              <button
                onClick={() => goToStep(step + 1)}
                disabled={busy}
                className="flex items-center gap-1 rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700 disabled:opacity-40"
              >
                {STEPS[step + 1].label}{" "}
                <ChevronRight size={15} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------

function StepIntro({
  title,
  text,
  tight,
}: {
  title: string;
  text: string;
  tight?: boolean;
}) {
  return (
    <div className={tight ? "" : "mb-5"}>
      <h2 className="text-lg font-semibold tracking-tight text-ink-900">
        {title}
      </h2>
      <p className="mt-0.5 text-sm text-ink-600">{text}</p>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
  w,
}: {
  label: React.ReactNode;
  hint?: string;
  children: React.ReactNode;
  w?: string;
}) {
  return (
    <div className={w ?? ""}>
      <span className="block text-[0.7rem] font-semibold uppercase tracking-[0.06em] text-ink-400">
        {label}
      </span>
      <div className="text-sm text-ink-900">{children}</div>
      {hint && <p className="mt-1 text-xs text-ink-400">{hint}</p>}
    </div>
  );
}

function TextOrInput({
  edit,
  value,
  onChange,
}: {
  edit: boolean;
  value: string;
  onChange: (v: string) => void;
}) {
  if (!edit) return <>{value || "—"}</>;
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={inputCls}
    />
  );
}

function NumOrText({
  edit,
  value,
  onChange,
}: {
  edit: boolean;
  value: number;
  onChange: (v: number) => void;
}) {
  if (!edit) return <>{money(value)}</>;
  return (
    <input
      type="number"
      step="any"
      min={0}
      value={value}
      onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
      className={inputCls}
    />
  );
}

function Trow({ l, c, p }: { l: string; c: number; p: number }) {
  return (
    <tr className="text-ink-600">
      <td className="py-1">{l}</td>
      <td className="py-1 text-right tabular-nums">{money(c)}</td>
      <td className="py-1 text-right tabular-nums">{money(p)}</td>
    </tr>
  );
}

function Tick({
  label,
  v,
  tone,
}: {
  label: string;
  v: string;
  tone?: "ok" | "warn" | "bad";
}) {
  const color =
    tone === "ok"
      ? "text-[#6fcf97]"
      : tone === "warn"
        ? "text-[#e5b567]"
        : tone === "bad"
          ? "text-[#f0857a]"
          : "text-white";
  return (
    <div className="shrink-0">
      <div className="text-[10px] uppercase tracking-widest text-white/40">
        {label}
      </div>
      <div className={`text-sm font-semibold tabular-nums ${color}`}>{v}</div>
    </div>
  );
}

function ApprovalActions({
  planId,
  run,
  busy,
  tbdBlocked,
}: {
  planId: string;
  run: (fn: () => Promise<{ ok: boolean; error?: string }>) => void;
  busy: boolean;
  tbdBlocked: boolean;
}) {
  const [comment, setComment] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Comment (required to reject / request changes)"
        className="w-72 rounded-lg border border-line bg-white px-3 py-1.5 text-sm text-ink-900 placeholder:text-ink-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
      />
      <button
        onClick={() => run(() => approvePlan(planId, comment))}
        disabled={busy || tbdBlocked}
        title={tbdBlocked ? "Resolve TBD line items first" : "Approve this plan"}
        className={buttonCls("success", "sm")}
      >
        <Check size={13} strokeWidth={2.5} />
        Approve
      </button>
      <button
        onClick={() => run(() => requestChanges(planId, comment))}
        disabled={busy || !comment.trim()}
        className={buttonCls("warn", "sm")}
      >
        <MessageSquareWarning size={13} strokeWidth={2} />
        Request changes
      </button>
      <button
        onClick={() => run(() => rejectPlan(planId, comment))}
        disabled={busy || !comment.trim()}
        className={buttonCls("danger", "sm")}
      >
        <X size={13} strokeWidth={2.5} />
        Reject
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Line item card — one work package with its material takeoff and live math.
// ---------------------------------------------------------------------------

const cellInputCls =
  "mt-1 w-full rounded-md border border-line bg-white px-2 py-1.5 text-sm tabular-nums text-ink-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500/25 disabled:bg-surface disabled:text-ink-400 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";

function CellField({
  label,
  children,
  w,
}: {
  label: string;
  children: React.ReactNode;
  w?: string;
}) {
  return (
    <label className={`block ${w ?? ""}`}>
      <span className="text-[0.65rem] font-semibold uppercase tracking-[0.06em] text-ink-400">
        {label}
      </span>
      {children}
    </label>
  );
}

function CellNum({
  value,
  onChange,
  disabled,
  step = "any",
}: {
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  step?: string;
}) {
  return (
    <input
      type="number"
      step={step}
      min={0}
      value={Number.isFinite(value) ? value : ""}
      onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
      disabled={disabled}
      className={cellInputCls}
    />
  );
}

function Mini({ label, v, strong }: { label: string; v: string; strong?: boolean }) {
  return (
    <span
      className={`text-xs tabular-nums ${strong ? "font-semibold text-ink-900" : "text-ink-600"}`}
    >
      <span className="text-[10px] font-medium uppercase tracking-wide text-ink-400">
        {label}{" "}
      </span>
      {v}
    </span>
  );
}

function LineCard({
  row,
  cost,
  phases,
  edit,
  busy,
  isNew,
  onPatch,
  onSave,
  onDelete,
}: {
  row: Draft;
  cost: LineCosts;
  phases: PlanPhase[];
  edit: boolean;
  busy: boolean;
  isNew?: boolean;
  onPatch: (p: Partial<Draft>) => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  const disabled = !edit;
  const margin = cost.linePrice > 0 ? cost.profit / cost.linePrice : 0;

  return (
    <div
      className={`rounded-xl border bg-white shadow-[0_1px_2px_rgba(13,36,56,0.05)] ${
        row.is_tbd
          ? "border-warn-700/40"
          : isNew
            ? "border-brand-500/50"
            : "border-line"
      }`}
    >
      {/* card header */}
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <select
          value={row.phase_id ?? ""}
          onChange={(e) => onPatch({ phase_id: e.target.value || null })}
          disabled={disabled}
          aria-label="Phase"
          className="rounded-md border border-line bg-white px-2 py-1 text-xs font-semibold uppercase tracking-wide text-brand-700 focus:border-brand-500 focus:outline-none disabled:bg-surface disabled:text-ink-400"
        >
          <option value="">No phase</option>
          {phases.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <input
          value={row.description}
          onChange={(e) => onPatch({ description: e.target.value })}
          placeholder="Description of work"
          disabled={disabled}
          className="min-w-40 flex-1 rounded-md border border-line bg-white px-2 py-1 text-sm text-ink-900 placeholder:text-ink-400 focus:border-brand-500 focus:outline-none disabled:border-transparent disabled:bg-transparent"
        />
        <select
          value={row.priority}
          onChange={(e) =>
            onPatch({ priority: Number(e.target.value) as 1 | 2 | 3 })
          }
          disabled={disabled}
          aria-label="Priority tier"
          className="rounded-md border border-line bg-white px-2 py-1 text-xs text-ink-900 focus:border-brand-500 focus:outline-none disabled:bg-surface disabled:text-ink-400"
        >
          {[1, 2, 3].map((p) => (
            <option key={p} value={p}>
              P{p} — {PRIORITY_NOTES[p]}
            </option>
          ))}
        </select>
        <button
          onClick={() => onPatch({ is_tbd: !row.is_tbd })}
          disabled={disabled}
          title="Flag unresolved scope — TBD lines block approval"
          className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
            row.is_tbd
              ? "bg-warn-700 text-white"
              : "bg-surface text-ink-600 hover:text-ink-900"
          } disabled:cursor-default`}
        >
          <HelpCircle size={12} aria-hidden="true" />
          {row.is_tbd ? "TBD" : "Priced"}
        </button>
        <span className="ml-auto text-sm font-semibold tabular-nums text-ink-900">
          {money(cost.linePrice)}
        </span>
        <span
          className={`text-xs tabular-nums ${cost.profit >= 0 ? "text-ok-600" : "text-bad-600"}`}
        >
          {cost.linePrice > 0 ? pct(margin) : "—"}
        </span>
        {edit && (
          <div className="flex items-center gap-1">
            {isNew ? (
              <>
                <button
                  onClick={onSave}
                  disabled={busy || !row.description.trim()}
                  className={buttonCls("primary", "sm")}
                >
                  <Plus size={12} strokeWidth={2.5} />
                  Add
                </button>
                <button
                  onClick={onDelete}
                  disabled={busy}
                  title="Discard new line"
                  className="rounded-md p-1.5 text-ink-400 transition-colors hover:text-bad-600"
                >
                  <X size={15} strokeWidth={2} />
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={onSave}
                  disabled={busy || !row.dirty}
                  title={row.dirty ? "Save line" : "No unsaved changes"}
                  className="rounded-md bg-brand-600 px-2 py-1.5 text-white transition-colors hover:bg-brand-700 disabled:opacity-30"
                >
                  <Check size={13} strokeWidth={2.5} />
                </button>
                <button
                  onClick={onDelete}
                  disabled={busy}
                  title="Delete line"
                  className="rounded-md border border-line px-2 py-1.5 text-ink-400 transition-colors hover:border-bad-600/30 hover:bg-bad-50 hover:text-bad-600"
                >
                  <Trash2 size={13} strokeWidth={2} />
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* editors */}
      <div className="grid grid-cols-2 gap-3 px-4 py-3 md:grid-cols-6">
        <CellField label="Events">
          <CellNum
            value={row.events}
            onChange={(v) => onPatch({ events: v })}
            disabled={disabled}
          />
        </CellField>
        <CellField label="Hrs / pc">
          <CellNum
            value={row.hours_per_piece}
            onChange={(v) => onPatch({ hours_per_piece: v })}
            disabled={disabled}
            step="0.5"
          />
        </CellField>
        <CellField label="Qty">
          <CellNum
            value={row.quantity}
            onChange={(v) => onPatch({ quantity: v })}
            disabled={disabled}
          />
        </CellField>
        <CellField label="Bill rate / hr">
          <input
            type="number"
            step="any"
            min={0}
            value={row.labor_bill_rate ?? ""}
            placeholder="default"
            onChange={(e) =>
              onPatch({
                labor_bill_rate:
                  e.target.value === ""
                    ? null
                    : parseFloat(e.target.value) || 0,
              })
            }
            disabled={disabled}
            className={cellInputCls}
          />
        </CellField>
        <CellField label="Material basis" w="col-span-2">
          <select
            value={row.material_basis}
            onChange={(e) =>
              onPatch({ material_basis: e.target.value as MaterialBasis })
            }
            disabled={disabled}
            className={cellInputCls}
          >
            <option value="per_each">Unit cost ($/ea)</option>
            <option value="per_lb">Steel by weight ($/lb)</option>
            <option value="per_sf">Area ($/SF)</option>
            <option value="lump_sum">Lump sum</option>
          </select>
        </CellField>

        {row.material_basis === "per_lb" && (
          <>
            <CellField label="Length / pc (ft)">
              <CellNum
                value={row.length_per_piece}
                onChange={(v) => onPatch({ length_per_piece: v })}
                disabled={disabled}
                step="0.5"
              />
            </CellField>
            <CellField label="Wt / lin ft">
              <CellNum
                value={row.weight_per_lf}
                onChange={(v) => onPatch({ weight_per_lf: v })}
                disabled={disabled}
                step="0.01"
              />
            </CellField>
            <CellField label="$ / lb">
              <CellNum
                value={row.unit_cost}
                onChange={(v) => onPatch({ unit_cost: v })}
                disabled={disabled}
                step="0.01"
              />
            </CellField>
            <MarkupField row={row} onPatch={onPatch} disabled={disabled} />
            <div className="col-span-2 flex items-end pb-2">
              <span className="text-xs tabular-nums text-ink-600">
                {cost.weightEst.toFixed(1)} lbs → {money(cost.materialCost)}{" "}
                cost / {money(cost.materialPrice)} price
              </span>
            </div>
          </>
        )}
        {row.material_basis === "per_each" && (
          <>
            <CellField label="Unit cost ($/ea)">
              <CellNum
                value={row.unit_cost}
                onChange={(v) => onPatch({ unit_cost: v })}
                disabled={disabled}
              />
            </CellField>
            <MarkupField row={row} onPatch={onPatch} disabled={disabled} />
            <div className="col-span-2 flex items-end pb-2 md:col-span-4">
              <span className="text-xs tabular-nums text-ink-600">
                {row.quantity} × {money(row.unit_cost)} ={" "}
                {money(cost.materialCost)} cost / {money(cost.materialPrice)}{" "}
                price
              </span>
            </div>
          </>
        )}
        {row.material_basis === "per_sf" && (
          <>
            <CellField label="Area / pc (SF)">
              <CellNum
                value={row.length_per_piece}
                onChange={(v) => onPatch({ length_per_piece: v })}
                disabled={disabled}
                step="0.5"
              />
            </CellField>
            <CellField label="$ / SF">
              <CellNum
                value={row.unit_cost}
                onChange={(v) => onPatch({ unit_cost: v })}
                disabled={disabled}
                step="0.01"
              />
            </CellField>
            <MarkupField row={row} onPatch={onPatch} disabled={disabled} />
            <div className="col-span-2 flex items-end pb-2 md:col-span-3">
              <span className="text-xs tabular-nums text-ink-600">
                {cost.totalLength.toFixed(1)} SF → {money(cost.materialCost)}{" "}
                cost / {money(cost.materialPrice)} price
              </span>
            </div>
          </>
        )}
        {row.material_basis === "lump_sum" && (
          <>
            <CellField label="Lump sum ($)">
              <CellNum
                value={row.lump_sum_cost}
                onChange={(v) => onPatch({ lump_sum_cost: v })}
                disabled={disabled}
              />
            </CellField>
            <MarkupField row={row} onPatch={onPatch} disabled={disabled} />
            <div className="col-span-2 flex items-end pb-2 md:col-span-4">
              <span className="text-xs tabular-nums text-ink-600">
                {money(cost.materialCost)} cost / {money(cost.materialPrice)}{" "}
                price
              </span>
            </div>
          </>
        )}

        <div className="col-span-2 flex flex-wrap gap-x-6 gap-y-1 border-t border-line/60 pt-2 md:col-span-6">
          <Mini label="Hours" v={round2(cost.totalHours).toString()} />
          <Mini label="Labor cost" v={money(cost.laborCost)} />
          <Mini label="Labor price" v={money(cost.laborPrice)} />
          <Mini label="Consumables" v={money(cost.consumables)} />
          <Mini label="OH alloc" v={money(cost.overheadAlloc)} />
          <Mini label="Line cost" v={money(cost.lineCost)} strong />
          <Mini label="Line price" v={money(cost.linePrice)} strong />
        </div>
      </div>
    </div>
  );
}

function MarkupField({
  row,
  onPatch,
  disabled,
}: {
  row: Draft;
  onPatch: (p: Partial<Draft>) => void;
  disabled: boolean;
}) {
  return (
    <CellField label="Markup %">
      <input
        type="number"
        step="any"
        min={0}
        value={round2(row.material_markup_pct * 100)}
        onChange={(e) =>
          onPatch({
            material_markup_pct: (parseFloat(e.target.value) || 0) / 100,
          })
        }
        disabled={disabled}
        className={cellInputCls}
      />
    </CellField>
  );
}
