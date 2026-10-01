"use client";

import { Fragment, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, Plus, X } from "lucide-react";
import { moneyWhole } from "@/lib/format";
import {
  MONTH_NAMES,
  initiativeTotals,
  type BudgetInitiative,
  type InitiativeStatus,
} from "@/lib/budget";
import { Table, Th, buttonCls } from "@/components/ui";
import {
  deleteInitiative,
  saveInitiative,
  setInitiativeStatus,
} from "./actions";

export interface InitiativeAccount {
  /** gl_pivot account row key (fully qualified name). */
  name: string;
  classification: "Revenue" | "Expense";
  category: string | null;
}

const STATUS_STYLE: Record<InitiativeStatus, string> = {
  proposed: "bg-amber-50 text-amber-700 border-amber-200",
  approved: "bg-emerald-50 text-emerald-700 border-emerald-200",
  rejected: "bg-red-50 text-red-700 border-red-200",
};
const STATUS_LABEL: Record<InitiativeStatus, string> = {
  proposed: "Proposed — not in budget",
  approved: "Approved — in budget",
  rejected: "Rejected",
};

/**
 * New initiatives per company. Proposed initiatives are listed here but
 * excluded from the budget; approving one folds its account amounts into the
 * budget statement above. Approved amounts are locked (migration 0026's guard
 * trigger) — return the initiative to proposed to edit it.
 */
export function InitiativesPanel({
  budgetYear,
  initiatives,
  companies,
  accountsByRealm,
}: {
  budgetYear: number;
  initiatives: BudgetInitiative[];
  companies: { realmId: string; name: string }[];
  accountsByRealm: Record<string, InitiativeAccount[]>;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<BudgetInitiative | "new" | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const companyName = new Map(companies.map((c) => [c.realmId, c.name]));

  const run = (fn: () => Promise<{ ok: true } | { ok: false; error: string }>) => {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (result.ok) router.refresh();
      else setError(result.error);
    });
  };

  const order: InitiativeStatus[] = ["proposed", "approved", "rejected"];
  const sorted = [...initiatives].sort(
    (a, b) => order.indexOf(a.status) - order.indexOf(b.status),
  );

  return (
    <div className="mt-4 rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(13,36,56,0.05)]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/70 px-4 py-2.5">
        <h2 className="text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
          New initiatives
        </h2>
        <button
          type="button"
          onClick={() => setEditing("new")}
          disabled={companies.length === 0}
          className={buttonCls("primary", "sm")}
        >
          <Plus size={14} strokeWidth={2} />
          New Initiative
        </button>
      </div>
      {error && <p className="px-4 pt-2 text-sm text-bad-600">{error}</p>}
      {sorted.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-ink-600">
          No initiatives yet. Use New Initiative to add expected revenue and
          expenses for a company; it joins the budget once approved.
        </p>
      ) : (
        <Table
          head={
            <tr>
              <Th>Initiative</Th>
              <Th>Company</Th>
              <Th>Starts</Th>
              <Th>Status</Th>
              <Th right>Revenue</Th>
              <Th right>Expense</Th>
              <Th right>Net</Th>
              <Th right>Actions</Th>
            </tr>
          }
        >
          {sorted.map((i) => {
            const t = initiativeTotals(i);
            const isOpen = open.has(i.id);
            return (
              <Fragment key={i.id}>
                <tr className="hover:bg-surface/50">
                  <td
                    className="cursor-pointer px-4 py-2 font-medium text-ink-900"
                    onClick={() =>
                      setOpen((prev) => {
                        const next = new Set(prev);
                        if (next.has(i.id)) next.delete(i.id);
                        else next.add(i.id);
                        return next;
                      })
                    }
                  >
                    <span className="flex items-center gap-1.5">
                      <ChevronRight
                        size={14}
                        strokeWidth={2}
                        className={`shrink-0 text-ink-400 transition-transform ${isOpen ? "rotate-90" : ""}`}
                      />
                      {i.name}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-ink-600">
                    {companyName.get(i.realm_id) ?? i.realm_id}
                  </td>
                  <td className="px-4 py-2 text-ink-600">
                    {MONTH_NAMES[i.start_month - 1]} {budgetYear}
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${STATUS_STYLE[i.status]}`}
                    >
                      {STATUS_LABEL[i.status]}
                    </span>
                    {i.status === "approved" && i.approved_by_name && (
                      <span className="mt-0.5 block text-xs text-ink-400">
                        by {i.approved_by_name}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{moneyWhole(t.revenue)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{moneyWhole(t.expense)}</td>
                  <td
                    className={`px-4 py-2 text-right font-medium tabular-nums ${t.net < 0 ? "text-bad-600" : "text-ink-900"}`}
                  >
                    {moneyWhole(t.net)}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex justify-end gap-1.5 whitespace-nowrap">
                      {i.status === "proposed" && (
                        <>
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() => setEditing(i)}
                            className={buttonCls("secondary", "sm")}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() => run(() => setInitiativeStatus(i.id, "approved"))}
                            className={buttonCls("success", "sm")}
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() => run(() => setInitiativeStatus(i.id, "rejected"))}
                            className={buttonCls("secondary", "sm")}
                          >
                            Reject
                          </button>
                        </>
                      )}
                      {i.status !== "proposed" && (
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => run(() => setInitiativeStatus(i.id, "proposed"))}
                          className={buttonCls("secondary", "sm")}
                        >
                          Return to proposed
                        </button>
                      )}
                      {i.status !== "approved" && (
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => {
                            if (confirm(`Delete initiative "${i.name}"?`))
                              run(() => deleteInitiative(i.id));
                          }}
                          className={buttonCls("danger", "sm")}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
                {isOpen && (
                  <tr className="bg-surface/30">
                    <td colSpan={8} className="px-4 py-2 pl-10">
                      {i.description && (
                        <p className="mb-2 text-sm text-ink-600">{i.description}</p>
                      )}
                      <ul className="space-y-0.5 text-[0.8rem] text-ink-600">
                        {i.lines.map((l) => (
                          <li key={l.account_name} className="flex justify-between gap-4">
                            <span>
                              {l.account_name}{" "}
                              <span className="text-ink-400">({l.classification})</span>
                            </span>
                            <span className="tabular-nums">{moneyWhole(l.annual_amount)}</span>
                          </li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </Table>
      )}

      {editing && (
        <InitiativeDialog
          budgetYear={budgetYear}
          initial={editing === "new" ? null : editing}
          companies={companies}
          accountsByRealm={accountsByRealm}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function InitiativeDialog({
  budgetYear,
  initial,
  companies,
  accountsByRealm,
  onClose,
  onSaved,
}: {
  budgetYear: number;
  initial: BudgetInitiative | null;
  companies: { realmId: string; name: string }[];
  accountsByRealm: Record<string, InitiativeAccount[]>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [realmId, setRealmId] = useState(initial?.realm_id ?? companies[0]?.realmId ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [startMonth, setStartMonth] = useState(initial?.start_month ?? 1);
  const [amounts, setAmounts] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (initial?.lines ?? []).map((l) => [l.account_name, String(l.annual_amount)]),
    ),
  );
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const accounts = useMemo(() => {
    const list = accountsByRealm[realmId] ?? [];
    // Keep any account already on the initiative even if it was deactivated.
    const known = new Set(list.map((a) => a.name));
    const extra: InitiativeAccount[] = (initial?.realm_id === realmId ? initial.lines : [])
      .filter((l) => !known.has(l.account_name))
      .map((l) => ({ name: l.account_name, classification: l.classification, category: null }));
    return [...list, ...extra];
  }, [accountsByRealm, realmId, initial]);

  const q = filter.trim().toLowerCase();
  const visible = accounts.filter(
    (a) =>
      !q ||
      a.name.toLowerCase().includes(q) ||
      (a.category ?? "").toLowerCase().includes(q) ||
      (amounts[a.name] ?? "") !== "",
  );

  let revenue = 0;
  let expense = 0;
  for (const a of accounts) {
    const v = Number(amounts[a.name] ?? 0) || 0;
    if (a.classification === "Revenue") revenue += v;
    else expense += v;
  }

  const save = () => {
    setError(null);
    const lines = accounts
      .map((a) => ({
        accountName: a.name,
        classification: a.classification,
        annualAmount: Number(amounts[a.name] ?? 0) || 0,
      }))
      .filter((l) => l.annualAmount !== 0);
    startTransition(async () => {
      const result = await saveInitiative({
        id: initial?.id ?? null,
        budgetYear,
        realmId,
        name,
        description,
        startMonth,
        lines,
      });
      if (result.ok) onSaved();
      else setError(result.error);
    });
  };

  const fieldCls =
    "w-full rounded-md border border-line bg-white px-3 py-1.5 text-sm text-ink-900 focus:border-brand-500";
  const label = (text: string) => (
    <span className="mb-1 block text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
      {text}
    </span>
  );

  const section = (classification: "Revenue" | "Expense") => {
    const rows = visible.filter((a) => a.classification === classification);
    if (rows.length === 0) return null;
    return (
      <Fragment key={classification}>
        <tr className="bg-surface/50">
          <td
            colSpan={2}
            className="px-4 py-1.5 text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-ink-400"
          >
            {classification === "Revenue" ? "Expected revenue" : "Expected expense"}
          </td>
        </tr>
        {rows.map((a) => (
          <tr key={a.name}>
            <td className="px-4 py-1.5 text-[0.8rem] text-ink-900">
              {a.name}
              {a.category && (
                <span className="ml-2 text-xs text-ink-400">{a.category}</span>
              )}
            </td>
            <td className="px-4 py-1.5 text-right">
              <input
                type="number"
                step="1"
                inputMode="decimal"
                placeholder="0"
                value={amounts[a.name] ?? ""}
                onChange={(e) =>
                  setAmounts((prev) => ({ ...prev, [a.name]: e.target.value }))
                }
                className="w-36 rounded-md border border-line bg-white px-2 py-1 text-right text-sm tabular-nums text-ink-900 focus:border-brand-500"
              />
            </td>
          </tr>
        ))}
      </Fragment>
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-navy-900/40 p-4 sm:p-8"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !pending) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={initial ? "Edit initiative" : "New initiative"}
        className="flex max-h-[calc(100vh-4rem)] w-full max-w-3xl flex-col rounded-xl border border-line bg-white shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="text-base font-semibold text-ink-900">
            {initial ? "Edit initiative" : "New initiative"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="rounded-md p-1 text-ink-400 hover:bg-surface hover:text-ink-900"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="grid gap-3 border-b border-line px-5 py-4 sm:grid-cols-2">
          <label className="block sm:col-span-2">
            {label("Name")}
            <input
              type="text"
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
              className={fieldCls}
              autoFocus
            />
          </label>
          <label className="block">
            {label("Company")}
            <select
              value={realmId}
              onChange={(e) => {
                setRealmId(e.target.value);
                setAmounts({});
              }}
              className={fieldCls}
            >
              {companies.map((c) => (
                <option key={c.realmId} value={c.realmId}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            {label("Starts")}
            <select
              value={startMonth}
              onChange={(e) => setStartMonth(Number(e.target.value))}
              className={fieldCls}
            >
              {MONTH_NAMES.map((m, idx) => (
                <option key={m} value={idx + 1}>
                  {m} {budgetYear}
                </option>
              ))}
            </select>
          </label>
          <label className="block sm:col-span-2">
            {label("Description (optional)")}
            <textarea
              value={description}
              rows={2}
              maxLength={2000}
              onChange={(e) => setDescription(e.target.value)}
              className={fieldCls}
            />
          </label>
        </div>

        <div className="border-b border-line/70 px-5 py-2">
          <input
            type="search"
            placeholder="Filter accounts or categories…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className={fieldCls}
          />
          <p className="mt-1.5 text-xs text-ink-400">
            Enter the expected amount for {budgetYear} in each account; it is
            spread evenly from the start month through December.
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {accounts.length === 0 ? (
            <p className="px-5 py-6 text-center text-sm text-ink-600">
              No revenue or expense accounts imported for this company yet.
            </p>
          ) : (
            <Table
              head={
                <tr>
                  <Th>Account</Th>
                  <Th right>{budgetYear} amount</Th>
                </tr>
              }
            >
              {section("Revenue")}
              {section("Expense")}
            </Table>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3">
          <div className="text-sm text-ink-600">
            Revenue <span className="font-medium tabular-nums text-ink-900">{moneyWhole(revenue)}</span>
            {" · "}Expense <span className="font-medium tabular-nums text-ink-900">{moneyWhole(expense)}</span>
            {" · "}Net{" "}
            <span
              className={`font-semibold tabular-nums ${revenue - expense < 0 ? "text-bad-600" : "text-ink-900"}`}
            >
              {moneyWhole(revenue - expense)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {error && <span className="text-sm text-bad-600">{error}</span>}
            <button
              type="button"
              onClick={onClose}
              disabled={pending}
              className={buttonCls("secondary")}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={pending}
              className={buttonCls("primary")}
            >
              {pending ? "Saving…" : initial ? "Save changes" : "Save as proposed"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
