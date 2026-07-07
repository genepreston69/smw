"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  addLineItem,
  addPhase,
  approvePlan,
  deleteLineItem,
  deletePhase,
  rejectPlan,
  requestChanges,
  submitPlan,
  updateLineItem,
  updatePlanFields,
  type LineItemInput,
} from "@/app/(app)/plans/actions";
import { computeLineCosts, sumCosts, type PlanParams } from "@/lib/costing";
import { money, pct, hours, shortDate } from "@/lib/format";
import { StatusBadge } from "@/components/StatusBadge";
import type {
  Approval,
  ApprovalThreshold,
  MaterialBasis,
  PlanLineItem,
  PlanPhase,
  Profile,
  ProjectPlan,
} from "@/lib/types";

const BASIS_LABELS: Record<MaterialBasis, string> = {
  per_lb: "$/lb (steel)",
  per_each: "$/each",
  per_sf: "$/SF",
  lump_sum: "Lump sum",
};

const inputCls =
  "rounded border border-zinc-300 px-1.5 py-1 text-xs tabular-nums focus:border-blue-500 focus:outline-none disabled:bg-zinc-50 disabled:text-zinc-400";

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
    labor_bill_rate: li.labor_bill_rate === null ? null : Number(li.labor_bill_rate),
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
    events: 0,
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

export function PlanWorkspace(props: Props) {
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
    start_date: plan.start_date ?? "",
    end_date: plan.end_date ?? "",
    notes: plan.notes ?? "",
  });
  const [headerDirty, setHeaderDirty] = useState(false);

  // --- line items local state ----------------------------------------------
  const [rows, setRows] = useState<Draft[]>(props.items.map(toDraft));
  const [adding, setAdding] = useState<Draft>(newDraft(null));
  const [newPhaseName, setNewPhaseName] = useState("");

  const costs = useMemo(() => computeLineCosts(rows, params), [rows, params]);
  const totals = useMemo(() => sumCosts(costs), [costs]);
  const tbdCount = rows.filter((r) => r.is_tbd).length;

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
    const map = new Map<number, { cost: number; price: number; count: number }>();
    rows.forEach((r, i) => {
      const cur = map.get(r.priority) ?? { cost: 0, price: 0, count: 0 };
      cur.cost += costs[i].lineCost;
      cur.price += costs[i].linePrice;
      cur.count += 1;
      map.set(r.priority, cur);
    });
    return map;
  }, [rows, costs]);

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

  function saveHeader() {
    run(() =>
      updatePlanFields(plan.id, {
        title: info.title,
        customer_id: info.customer_id,
        job_id: info.job_id,
        department: info.department || null,
        project_manager: info.project_manager || null,
        contact_name: info.contact_name || null,
        start_date: info.start_date || null,
        end_date: info.end_date || null,
        notes: info.notes || null,
        labor_cost_rate: params.labor_cost_rate,
        default_labor_bill_rate: params.default_labor_bill_rate,
        consumables_pct: params.consumables_pct,
        overhead_pool: params.overhead_pool,
      }).then((r) => {
        if (r.ok) setHeaderDirty(false);
        return r;
      }),
    );
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
    const { id: _id, dirty: _dirty, ...fields } = adding;
    void _id;
    void _dirty;
    run(() =>
      addLineItem(plan.id, fields).then((r) => {
        if (r.ok) setAdding(newDraft(adding.phase_id));
        return r;
      }),
    );
  }

  // ---------------------------------------------------------------------------
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            {canEdit ? (
              <input
                value={info.title}
                onChange={(e) => {
                  setInfo({ ...info, title: e.target.value });
                  setHeaderDirty(true);
                }}
                className="rounded-md border border-transparent px-1 text-2xl font-semibold hover:border-zinc-300 focus:border-blue-500 focus:outline-none"
              />
            ) : (
              <h1 className="text-2xl font-semibold">{plan.title}</h1>
            )}
            <StatusBadge status={plan.status} />
            {plan.version > 1 && (
              <span className="text-sm text-zinc-400">v{plan.version}</span>
            )}
          </div>
          <p className="mt-1 text-sm text-zinc-500">
            Created by {nameOf(plan.created_by)} · Updated{" "}
            {shortDate(plan.updated_at)}
            {tbdCount > 0 && (
              <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                {tbdCount} TBD line{tbdCount > 1 ? "s" : ""} — approval blocked
              </span>
            )}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {canEdit && headerDirty && (
            <button
              onClick={saveHeader}
              disabled={busy}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
            >
              Save plan details
            </button>
          )}
          {canEdit && (
            <button
              onClick={() => run(() => submitPlan(plan.id))}
              disabled={busy || headerDirty}
              title={
                headerDirty ? "Save plan details first" : "Submit for approval"
              }
              className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50"
            >
              Submit for approval
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Approval banner */}
      {plan.status === "submitted" && (
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-blue-800">
              <span className="font-medium">Awaiting approval:</span>{" "}
              {approvedThisVersion} of {requiredApprovals} required approval
              {requiredApprovals > 1 ? "s" : ""} ·{" "}
              {money(totals.totalPrice)} total
              {tbdCount > 0 && (
                <span className="ml-2 font-medium text-amber-700">
                  {tbdCount} TBD line{tbdCount > 1 ? "s" : ""} must be resolved
                  before approval
                </span>
              )}
            </p>
            {canApprove && <ApprovalActions planId={plan.id} run={run} busy={busy} />}
          </div>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Plan info */}
        <section className="rounded-xl border border-zinc-200 bg-white p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">
            Plan details
          </h2>
          <div className="space-y-3 text-sm">
            <Field label="Customer">
              {canEdit ? (
                <select
                  value={info.customer_id ?? ""}
                  onChange={(e) => {
                    setInfo({ ...info, customer_id: e.target.value || null });
                    setHeaderDirty(true);
                  }}
                  className={`${inputCls} w-full text-sm`}
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
            <Field label="QuickBooks job">
              {canEdit ? (
                <select
                  value={info.job_id ?? ""}
                  onChange={(e) => {
                    setInfo({ ...info, job_id: e.target.value || null });
                    setHeaderDirty(true);
                  }}
                  className={`${inputCls} w-full text-sm`}
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
                onChange={(v) => {
                  setInfo({ ...info, project_manager: v });
                  setHeaderDirty(true);
                }}
              />
            </Field>
            <Field label="Department">
              <TextOrInput
                edit={canEdit}
                value={info.department}
                onChange={(v) => {
                  setInfo({ ...info, department: v });
                  setHeaderDirty(true);
                }}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Start date">
                {canEdit ? (
                  <input
                    type="date"
                    value={info.start_date}
                    onChange={(e) => {
                      setInfo({ ...info, start_date: e.target.value });
                      setHeaderDirty(true);
                    }}
                    className={`${inputCls} w-full text-sm`}
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
                    onChange={(e) => {
                      setInfo({ ...info, end_date: e.target.value });
                      setHeaderDirty(true);
                    }}
                    className={`${inputCls} w-full text-sm`}
                  />
                ) : (
                  shortDate(plan.end_date)
                )}
              </Field>
            </div>
            <Field label="Notes">
              {canEdit ? (
                <textarea
                  value={info.notes}
                  rows={2}
                  onChange={(e) => {
                    setInfo({ ...info, notes: e.target.value });
                    setHeaderDirty(true);
                  }}
                  className={`${inputCls} w-full text-sm`}
                />
              ) : (
                (plan.notes ?? "—")
              )}
            </Field>
          </div>
        </section>

        {/* Rate parameters */}
        <section className="rounded-xl border border-zinc-200 bg-white p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">
            Rates & pools
          </h2>
          <div className="space-y-3 text-sm">
            <Field label="Labor cost rate ($/hr)">
              <NumOrText
                edit={canEdit}
                value={params.labor_cost_rate}
                onChange={(v) => {
                  setParams({ ...params, labor_cost_rate: v });
                  setHeaderDirty(true);
                }}
              />
            </Field>
            <Field label="Default labor billing rate ($/hr)">
              <NumOrText
                edit={canEdit}
                value={params.default_labor_bill_rate}
                onChange={(v) => {
                  setParams({ ...params, default_labor_bill_rate: v });
                  setHeaderDirty(true);
                }}
              />
            </Field>
            <Field label="Consumables (% of labor price)">
              {canEdit ? (
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    step="any"
                    min={0}
                    max={100}
                    value={round2(params.consumables_pct * 100)}
                    onChange={(e) => {
                      setParams({
                        ...params,
                        consumables_pct: (parseFloat(e.target.value) || 0) / 100,
                      });
                      setHeaderDirty(true);
                    }}
                    className={`${inputCls} w-24 text-sm`}
                  />
                  <span className="text-zinc-500">%</span>
                </div>
              ) : (
                pct(params.consumables_pct)
              )}
            </Field>
            <Field
              label={
                <>
                  Overhead pool ($){" "}
                  <span className="font-normal text-red-500">required</span>
                </>
              }
            >
              {canEdit ? (
                <input
                  type="number"
                  step="any"
                  min={0}
                  value={params.overhead_pool ?? ""}
                  placeholder="Required before submit"
                  onChange={(e) => {
                    setParams({
                      ...params,
                      overhead_pool:
                        e.target.value === ""
                          ? null
                          : parseFloat(e.target.value) || 0,
                    });
                    setHeaderDirty(true);
                  }}
                  className={`${inputCls} w-full text-sm ${params.overhead_pool === null ? "border-red-300 bg-red-50" : ""}`}
                />
              ) : params.overhead_pool === null ? (
                "—"
              ) : (
                money(params.overhead_pool)
              )}
            </Field>
            <p className="text-xs text-zinc-400">
              Overhead is allocated across line items in proportion to each
              line&apos;s labor + material cost.
            </p>
          </div>
        </section>

        {/* Totals */}
        <section className="rounded-xl border border-zinc-200 bg-white p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">
            Profitability
          </h2>
          <table className="w-full text-sm">
            <tbody>
              <Trow l="Labor" c={totals.laborCost} p={totals.laborPrice} />
              <Trow l="Material" c={totals.materialCost} p={totals.materialPrice} />
              <Trow l="Consumables" c={totals.consumables} p={totals.consumables} />
              <Trow l="Overhead" c={totals.overhead} p={totals.overhead} />
              <tr className="border-t border-zinc-200 font-semibold">
                <td className="py-1.5">Total</td>
                <td className="py-1.5 text-right tabular-nums">
                  {money(totals.totalCost)}
                </td>
                <td className="py-1.5 text-right tabular-nums">
                  {money(totals.totalPrice)}
                </td>
              </tr>
              <tr className="text-emerald-700">
                <td className="py-1.5">Profit</td>
                <td className="py-1.5 text-right tabular-nums" colSpan={2}>
                  {money(totals.profit)} ({pct(totals.profitPct)})
                </td>
              </tr>
              <tr className="text-zinc-500">
                <td className="py-1.5">Labor hours</td>
                <td className="py-1.5 text-right tabular-nums" colSpan={2}>
                  {hours(totals.totalHours)}
                </td>
              </tr>
            </tbody>
          </table>
          {priorityTotals.size > 1 && (
            <div className="mt-4 border-t border-zinc-100 pt-3">
              <h3 className="mb-2 text-xs font-semibold uppercase text-zinc-400">
                By priority
              </h3>
              {[1, 2, 3].map((p) => {
                const t = priorityTotals.get(p);
                if (!t) return null;
                return (
                  <div
                    key={p}
                    className="flex justify-between py-0.5 text-sm text-zinc-600"
                  >
                    <span>
                      Priority {p}{" "}
                      <span className="text-zinc-400">({t.count})</span>
                    </span>
                    <span className="tabular-nums">{money(t.price)}</span>
                  </div>
                );
              })}
            </div>
          )}
          <p className="mt-3 text-xs text-zinc-400">
            {money(totals.totalPrice)} requires {requiredApprovals} approval
            {requiredApprovals > 1 ? "s" : ""}.
          </p>
        </section>
      </div>

      {/* Line items */}
      <section className="rounded-xl border border-zinc-200 bg-white">
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
            Line items
          </h2>
          {canEdit && (
            <div className="flex items-center gap-2">
              <input
                value={newPhaseName}
                onChange={(e) => setNewPhaseName(e.target.value)}
                placeholder="New phase name"
                className={`${inputCls} w-40 text-sm`}
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
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-50 disabled:opacity-50"
              >
                Add phase
              </button>
            </div>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] text-xs">
            <thead className="bg-zinc-50 text-left uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-3 py-2">Description</th>
                <th className="px-2 py-2">Phase</th>
                <th className="px-2 py-2">Pri</th>
                <th className="px-2 py-2">TBD</th>
                <th className="px-2 py-2 text-right">Events</th>
                <th className="px-2 py-2 text-right">Hrs/Pc</th>
                <th className="px-2 py-2 text-right">Qty</th>
                <th className="px-2 py-2 text-right">Bill $/hr</th>
                <th className="px-2 py-2">Basis</th>
                <th className="px-2 py-2 text-right">Len/SF</th>
                <th className="px-2 py-2 text-right">Wt/LF</th>
                <th className="px-2 py-2 text-right">Unit $</th>
                <th className="px-2 py-2 text-right">Lump $</th>
                <th className="px-2 py-2 text-right">Mkup %</th>
                <th className="px-2 py-2 text-right">Hours</th>
                <th className="px-2 py-2 text-right">Mat $</th>
                <th className="px-2 py-2 text-right">Price</th>
                {canEdit && <th className="px-2 py-2" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {rows.map((row, i) => (
                <LineRow
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
              {canEdit && (
                <LineRow
                  isNew
                  row={adding}
                  cost={computeLineCosts([adding], params)[0]}
                  phases={phases}
                  edit
                  busy={busy}
                  onPatch={(p) => setAdding({ ...adding, ...p })}
                  onSave={addRow}
                  onDelete={() => setAdding(newDraft(null))}
                />
              )}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && !canEdit && (
          <p className="p-5 text-sm text-zinc-500">No line items.</p>
        )}

        {canEdit && phases.length > 0 && (
          <div className="border-t border-zinc-100 px-5 py-3 text-xs text-zinc-500">
            Phases:{" "}
            {phases.map((ph) => (
              <span
                key={ph.id}
                className="mr-2 inline-flex items-center gap-1 rounded-full border border-zinc-200 px-2 py-0.5"
              >
                {ph.name}
                <button
                  onClick={() => run(() => deletePhase(plan.id, ph.id))}
                  className="text-zinc-400 hover:text-red-600"
                  title="Delete phase (line items keep their data)"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </section>

      {/* Approval history */}
      {props.approvals.length > 0 && (
        <section className="rounded-xl border border-zinc-200 bg-white p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">
            Approval history
          </h2>
          <ul className="space-y-2 text-sm">
            {props.approvals.map((a) => (
              <li key={a.id} className="flex items-start gap-2">
                <span
                  className={
                    a.decision === "approved"
                      ? "text-emerald-600"
                      : a.decision === "rejected"
                        ? "text-red-600"
                        : "text-amber-600"
                  }
                >
                  ●
                </span>
                <div>
                  <span className="font-medium">{nameOf(a.approver_id)}</span>{" "}
                  <span className="text-zinc-500">
                    {a.decision.replace("_", " ")} v{a.plan_version} ·{" "}
                    {shortDate(a.created_at)}
                  </span>
                  {a.comment && (
                    <p className="text-zinc-600">&ldquo;{a.comment}&rdquo;</p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function Field({
  label,
  children,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <span className="mb-0.5 block text-xs font-medium text-zinc-500">
        {label}
      </span>
      <div className="text-zinc-800">{children}</div>
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
      className={`${inputCls} w-full text-sm`}
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
      className={`${inputCls} w-full text-sm`}
    />
  );
}

function Trow({ l, c, p }: { l: string; c: number; p: number }) {
  return (
    <tr className="text-zinc-600">
      <td className="py-1">{l}</td>
      <td className="py-1 text-right tabular-nums">{money(c)}</td>
      <td className="py-1 text-right tabular-nums">{money(p)}</td>
    </tr>
  );
}

function ApprovalActions({
  planId,
  run,
  busy,
}: {
  planId: string;
  run: (fn: () => Promise<{ ok: boolean; error?: string }>) => void;
  busy: boolean;
}) {
  const [comment, setComment] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Comment (required to reject / request changes)"
        className="w-72 rounded-md border border-zinc-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
      />
      <button
        onClick={() => run(() => approvePlan(planId, comment))}
        disabled={busy}
        className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
      >
        Approve
      </button>
      <button
        onClick={() => run(() => requestChanges(planId, comment))}
        disabled={busy || !comment.trim()}
        className="rounded-md bg-amber-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-400 disabled:opacity-50"
      >
        Request changes
      </button>
      <button
        onClick={() => run(() => rejectPlan(planId, comment))}
        disabled={busy || !comment.trim()}
        className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50"
      >
        Reject
      </button>
    </div>
  );
}

function LineRow({
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
  cost: ReturnType<typeof computeLineCosts>[number];
  phases: PlanPhase[];
  edit: boolean;
  busy: boolean;
  isNew?: boolean;
  onPatch: (p: Partial<Draft>) => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  const num = (v: string) => parseFloat(v) || 0;
  const weightBased = row.material_basis === "per_lb";
  const lump = row.material_basis === "lump_sum";

  if (!edit) {
    const phase = phases.find((p) => p.id === row.phase_id);
    return (
      <tr className={row.is_tbd ? "bg-amber-50/50" : undefined}>
        <td className="px-3 py-1.5">
          {row.description || <span className="text-zinc-400">—</span>}
          {row.is_tbd && (
            <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] font-semibold text-amber-700">
              TBD
            </span>
          )}
        </td>
        <td className="px-2 py-1.5 text-zinc-500">{phase?.name ?? "—"}</td>
        <td className="px-2 py-1.5">{row.priority}</td>
        <td className="px-2 py-1.5">{row.is_tbd ? "Yes" : ""}</td>
        <td className="px-2 py-1.5 text-right tabular-nums">{row.events}</td>
        <td className="px-2 py-1.5 text-right tabular-nums">
          {row.hours_per_piece}
        </td>
        <td className="px-2 py-1.5 text-right tabular-nums">{row.quantity}</td>
        <td className="px-2 py-1.5 text-right tabular-nums">
          {row.labor_bill_rate ?? "—"}
        </td>
        <td className="px-2 py-1.5">{BASIS_LABELS[row.material_basis]}</td>
        <td className="px-2 py-1.5 text-right tabular-nums">
          {row.length_per_piece}
        </td>
        <td className="px-2 py-1.5 text-right tabular-nums">
          {row.weight_per_lf}
        </td>
        <td className="px-2 py-1.5 text-right tabular-nums">{row.unit_cost}</td>
        <td className="px-2 py-1.5 text-right tabular-nums">
          {row.lump_sum_cost}
        </td>
        <td className="px-2 py-1.5 text-right tabular-nums">
          {round2(row.material_markup_pct * 100)}
        </td>
        <td className="px-2 py-1.5 text-right tabular-nums">
          {round2(cost.totalHours)}
        </td>
        <td className="px-2 py-1.5 text-right tabular-nums">
          {money(cost.materialPrice)}
        </td>
        <td className="px-2 py-1.5 text-right font-medium tabular-nums">
          {money(cost.linePrice)}
        </td>
      </tr>
    );
  }

  return (
    <tr
      className={
        isNew ? "bg-blue-50/40" : row.dirty ? "bg-yellow-50/60" : undefined
      }
    >
      <td className="px-3 py-1">
        <input
          value={row.description}
          placeholder={isNew ? "New line item…" : ""}
          onChange={(e) => onPatch({ description: e.target.value })}
          className={`${inputCls} w-44`}
        />
      </td>
      <td className="px-2 py-1">
        <select
          value={row.phase_id ?? ""}
          onChange={(e) => onPatch({ phase_id: e.target.value || null })}
          className={`${inputCls} w-24`}
        >
          <option value="">—</option>
          {phases.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </td>
      <td className="px-2 py-1">
        <select
          value={row.priority}
          onChange={(e) =>
            onPatch({ priority: Number(e.target.value) as 1 | 2 | 3 })
          }
          className={inputCls}
        >
          <option value={1}>1</option>
          <option value={2}>2</option>
          <option value={3}>3</option>
        </select>
      </td>
      <td className="px-2 py-1 text-center">
        <input
          type="checkbox"
          checked={row.is_tbd}
          onChange={(e) => onPatch({ is_tbd: e.target.checked })}
        />
      </td>
      <td className="px-2 py-1">
        <input
          type="number"
          step="any"
          min={0}
          value={row.events}
          onChange={(e) => onPatch({ events: num(e.target.value) })}
          className={`${inputCls} w-14 text-right`}
        />
      </td>
      <td className="px-2 py-1">
        <input
          type="number"
          step="any"
          min={0}
          value={row.hours_per_piece}
          onChange={(e) => onPatch({ hours_per_piece: num(e.target.value) })}
          className={`${inputCls} w-14 text-right`}
        />
      </td>
      <td className="px-2 py-1">
        <input
          type="number"
          step="any"
          min={0}
          value={row.quantity}
          onChange={(e) => onPatch({ quantity: num(e.target.value) })}
          className={`${inputCls} w-14 text-right`}
        />
      </td>
      <td className="px-2 py-1">
        <input
          type="number"
          step="any"
          min={0}
          value={row.labor_bill_rate ?? ""}
          placeholder="dflt"
          onChange={(e) =>
            onPatch({
              labor_bill_rate:
                e.target.value === "" ? null : num(e.target.value),
            })
          }
          className={`${inputCls} w-16 text-right`}
        />
      </td>
      <td className="px-2 py-1">
        <select
          value={row.material_basis}
          onChange={(e) =>
            onPatch({ material_basis: e.target.value as MaterialBasis })
          }
          className={inputCls}
        >
          {Object.entries(BASIS_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </td>
      <td className="px-2 py-1">
        <input
          type="number"
          step="any"
          min={0}
          value={row.length_per_piece}
          disabled={lump}
          onChange={(e) => onPatch({ length_per_piece: num(e.target.value) })}
          className={`${inputCls} w-14 text-right`}
        />
      </td>
      <td className="px-2 py-1">
        <input
          type="number"
          step="any"
          min={0}
          value={row.weight_per_lf}
          disabled={!weightBased}
          onChange={(e) => onPatch({ weight_per_lf: num(e.target.value) })}
          className={`${inputCls} w-14 text-right`}
        />
      </td>
      <td className="px-2 py-1">
        <input
          type="number"
          step="any"
          min={0}
          value={row.unit_cost}
          disabled={lump}
          onChange={(e) => onPatch({ unit_cost: num(e.target.value) })}
          className={`${inputCls} w-16 text-right`}
        />
      </td>
      <td className="px-2 py-1">
        <input
          type="number"
          step="any"
          min={0}
          value={row.lump_sum_cost}
          disabled={!lump}
          onChange={(e) => onPatch({ lump_sum_cost: num(e.target.value) })}
          className={`${inputCls} w-20 text-right`}
        />
      </td>
      <td className="px-2 py-1">
        <input
          type="number"
          step="any"
          min={0}
          value={round2(row.material_markup_pct * 100)}
          onChange={(e) =>
            onPatch({ material_markup_pct: num(e.target.value) / 100 })
          }
          className={`${inputCls} w-14 text-right`}
        />
      </td>
      <td className="px-2 py-1 text-right tabular-nums text-zinc-500">
        {round2(cost.totalHours)}
      </td>
      <td className="px-2 py-1 text-right tabular-nums text-zinc-500">
        {money(cost.materialPrice)}
      </td>
      <td className="px-2 py-1 text-right font-medium tabular-nums">
        {money(cost.linePrice)}
      </td>
      <td className="px-2 py-1 whitespace-nowrap">
        {isNew ? (
          <button
            onClick={onSave}
            disabled={busy || !row.description.trim()}
            className="rounded bg-zinc-900 px-2 py-1 text-[11px] font-medium text-white hover:bg-zinc-700 disabled:opacity-40"
          >
            Add
          </button>
        ) : (
          <>
            <button
              onClick={onSave}
              disabled={busy || !row.dirty}
              className="rounded bg-blue-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-blue-500 disabled:opacity-30"
            >
              Save
            </button>
            <button
              onClick={onDelete}
              disabled={busy}
              className="ml-1 rounded border border-zinc-200 px-2 py-1 text-[11px] text-zinc-500 hover:bg-red-50 hover:text-red-600"
            >
              ✕
            </button>
          </>
        )}
      </td>
    </tr>
  );
}
