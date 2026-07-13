"use client";

import { Fragment, useState, useTransition } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { hours as fmtHours, money } from "@/lib/format";
import type { CustomerSummaryRow } from "@/lib/customerSummary";
import { getJobCosts, type JobCostLine } from "@/app/(app)/jobs/actions";

interface VendorAgg {
  vendor: string;
  materials: number;
  labor: number;
  contractServices: number;
  total: number;
  hours: number;
}

type VendorState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "loaded"; vendors: VendorAgg[] };

// Cost lines grouped by vendor (time entries carry the employee as the
// vendor; journal lines have none), largest total first.
function aggregateVendors(lines: JobCostLine[]): VendorAgg[] {
  const byVendor = new Map<string, VendorAgg>();
  for (const l of lines) {
    const key = l.vendor_name ?? "(No vendor)";
    let agg = byVendor.get(key);
    if (!agg) {
      agg = {
        vendor: key,
        materials: 0,
        labor: 0,
        contractServices: 0,
        total: 0,
        hours: 0,
      };
      byVendor.set(key, agg);
    }
    if (l.cost_type === "materials") agg.materials += l.amount;
    else if (l.cost_type === "labor") agg.labor += l.amount;
    else agg.contractServices += l.amount;
    agg.total += l.amount;
    agg.hours += l.hours ?? 0;
  }
  return [...byVendor.values()].sort(
    (a, b) => b.total - a.total || a.vendor.localeCompare(b.vendor),
  );
}

export function SummaryRows({
  rows,
  showCompany,
}: {
  rows: CustomerSummaryRow[];
  showCompany: boolean;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [openJobs, setOpenJobs] = useState<Set<string>>(new Set());
  // Keyed by job id, cached across expand/collapse (like the Jobs dashboard).
  const [vendors, setVendors] = useState<Record<string, VendorState>>({});
  const [, startTransition] = useTransition();

  // Customer + Intercompany + Jobs + Materials + Direct labor + Contract
  // services + Actual cost + Invoiced + Net, plus the optional QB Company
  // column.
  const colSpan = 9 + (showCompany ? 1 : 0);

  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const toggleJob = (jobId: string) => {
    setOpenJobs((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
    if (vendors[jobId]) return; // already loaded (or loading)
    setVendors((prev) => ({ ...prev, [jobId]: { status: "loading" } }));
    startTransition(async () => {
      const res = await getJobCosts(jobId);
      setVendors((prev) => ({
        ...prev,
        [jobId]: res.ok
          ? { status: "loaded", vendors: aggregateVendors(res.lines) }
          : { status: "error", error: res.error },
      }));
    });
  };

  return (
    <>
      {rows.map((r) => {
        const expanded = open.has(r.key);
        return (
          <Fragment key={r.key}>
            <tr className="transition-colors hover:bg-surface/60">
              <td className="px-4 py-3 font-medium text-ink-900">
                <button
                  onClick={() => toggle(r.key)}
                  className="flex items-center gap-1.5 text-left font-medium text-ink-900 hover:text-brand-700"
                  title={expanded ? "Hide jobs" : "List jobs"}
                >
                  {expanded ? (
                    <ChevronDown
                      size={14}
                      strokeWidth={2}
                      className="shrink-0 text-ink-400"
                    />
                  ) : (
                    <ChevronRight
                      size={14}
                      strokeWidth={2}
                      className="shrink-0 text-ink-400"
                    />
                  )}
                  {r.name}
                </button>
              </td>
              {showCompany && (
                <td className="px-4 py-3 text-ink-600">
                  {r.companyName ?? "—"}
                </td>
              )}
              <td className="px-4 py-3 text-ink-600">
                {r.intercompany ? "Yes" : "No"}
              </td>
              <td className="px-4 py-3 text-right tabular-nums">{r.jobs}</td>
              <td className="px-4 py-3 text-right tabular-nums">
                {money(r.materials)}
              </td>
              <td className="px-4 py-3 text-right tabular-nums">
                {money(r.labor)}
              </td>
              <td className="px-4 py-3 text-right tabular-nums">
                {money(r.other)}
              </td>
              <td className="px-4 py-3 text-right tabular-nums">
                {money(r.cost)}
              </td>
              <td className="px-4 py-3 text-right tabular-nums">
                {money(r.invoiced)}
              </td>
              <td
                className={`px-4 py-3 text-right tabular-nums ${
                  r.net < 0 ? "text-bad-600" : ""
                }`}
              >
                {money(r.net)}
              </td>
            </tr>
            {expanded && (
              <tr>
                <td colSpan={colSpan} className="bg-surface/40 px-6 py-4">
                  <JobList
                    row={r}
                    openJobs={openJobs}
                    vendors={vendors}
                    onToggleJob={toggleJob}
                  />
                </td>
              </tr>
            )}
          </Fragment>
        );
      })}
    </>
  );
}

function JobList({
  row,
  openJobs,
  vendors,
  onToggleJob,
}: {
  row: CustomerSummaryRow;
  openJobs: Set<string>;
  vendors: Record<string, VendorState>;
  onToggleJob: (jobId: string) => void;
}) {
  return (
    <div>
      <h3 className="mb-1 text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
        Jobs ({row.jobList.length})
      </h3>
      <table className="w-full text-[0.8rem]">
        <thead className="text-left text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
          <tr>
            <th className="py-1.5 pr-3 font-semibold">Job</th>
            <th className="w-28 py-1.5 pr-3 text-right font-semibold">
              Materials
            </th>
            <th className="w-28 py-1.5 pr-3 text-right font-semibold">
              Direct labor
            </th>
            <th className="w-32 py-1.5 pr-3 text-right font-semibold">
              Contract services
            </th>
            <th className="w-28 py-1.5 pr-3 text-right font-semibold">
              Actual cost
            </th>
            <th className="w-28 py-1.5 pr-3 text-right font-semibold">
              Invoiced
            </th>
            <th className="w-28 py-1.5 text-right font-semibold">Net</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line/50">
          {row.jobList.map((j) => {
            const net =
              j.cost != null || j.invoiced != null
                ? (j.invoiced ?? 0) - (j.cost ?? 0)
                : null;
            const jobExpanded = openJobs.has(j.id);
            return (
              <Fragment key={j.id}>
                <tr>
                  <td className="py-1.5 pr-3 text-ink-900">
                    <button
                      onClick={() => onToggleJob(j.id)}
                      className="flex items-center gap-1.5 text-left text-ink-900 hover:text-brand-700"
                      title={
                        jobExpanded ? "Hide vendors" : "View vendor breakdown"
                      }
                    >
                      {jobExpanded ? (
                        <ChevronDown
                          size={13}
                          strokeWidth={2}
                          className="shrink-0 text-ink-400"
                        />
                      ) : (
                        <ChevronRight
                          size={13}
                          strokeWidth={2}
                          className="shrink-0 text-ink-400"
                        />
                      )}
                      {j.name}
                    </button>
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-ink-600">
                    {j.materials != null ? money(j.materials) : "—"}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-ink-600">
                    {j.labor != null ? money(j.labor) : "—"}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-ink-600">
                    {j.contractServices != null
                      ? money(j.contractServices)
                      : "—"}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-ink-600">
                    {j.cost != null ? money(j.cost) : "—"}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-ink-600">
                    {j.invoiced != null ? money(j.invoiced) : "—"}
                  </td>
                  <td
                    className={`py-1.5 text-right tabular-nums ${
                      net != null && net < 0 ? "text-bad-600" : "text-ink-900"
                    }`}
                  >
                    {net != null ? money(net) : "—"}
                  </td>
                </tr>
                {jobExpanded && (
                  <tr>
                    <td colSpan={7} className="py-2 pl-5 pr-0">
                      <VendorBreakdown state={vendors[j.id]} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t border-line font-semibold text-ink-900">
            <td className="py-1.5 pr-3">Total</td>
            <td className="py-1.5 pr-3 text-right tabular-nums">
              {money(row.materials)}
            </td>
            <td className="py-1.5 pr-3 text-right tabular-nums">
              {money(row.labor)}
            </td>
            <td className="py-1.5 pr-3 text-right tabular-nums">
              {money(row.other)}
            </td>
            <td className="py-1.5 pr-3 text-right tabular-nums">
              {money(row.cost)}
            </td>
            <td className="py-1.5 pr-3 text-right tabular-nums">
              {money(row.invoiced)}
            </td>
            <td
              className={`py-1.5 text-right tabular-nums ${
                row.net < 0 ? "text-bad-600" : ""
              }`}
            >
              {money(row.net)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function VendorBreakdown({ state }: { state: VendorState | undefined }) {
  if (!state || state.status === "loading") {
    return (
      <p className="flex items-center gap-2 py-1 text-[0.8rem] text-ink-400">
        <Loader2 size={13} className="animate-spin" />
        Loading vendors…
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <p className="py-1 text-[0.8rem] text-bad-600">
        Couldn&apos;t load vendors: {state.error}
      </p>
    );
  }
  if (state.vendors.length === 0) {
    return (
      <p className="py-1 text-[0.8rem] text-ink-600">
        No cost transactions since Jan 1, 2023 for this job.
      </p>
    );
  }

  const total = state.vendors.reduce((s, v) => s + v.total, 0);
  return (
    <div className="border-l-2 border-line pl-4">
      <h4 className="mb-1 text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
        Vendors ({state.vendors.length})
      </h4>
      <table className="w-full text-[0.78rem]">
        <thead className="text-left text-[0.62rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
          <tr>
            <th className="py-1 pr-3 font-semibold">Vendor / Employee</th>
            <th className="w-24 py-1 pr-3 text-right font-semibold">Hours</th>
            <th className="w-28 py-1 pr-3 text-right font-semibold">
              Materials
            </th>
            <th className="w-28 py-1 pr-3 text-right font-semibold">
              Direct labor
            </th>
            <th className="w-32 py-1 pr-3 text-right font-semibold">
              Contract services
            </th>
            <th className="w-28 py-1 text-right font-semibold">Total</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line/40">
          {state.vendors.map((v) => (
            <tr key={v.vendor}>
              <td className="py-1 pr-3 text-ink-900">{v.vendor}</td>
              <td className="py-1 pr-3 text-right tabular-nums text-ink-400">
                {v.hours > 0 ? fmtHours(v.hours) : ""}
              </td>
              <td className="py-1 pr-3 text-right tabular-nums text-ink-600">
                {v.materials !== 0 ? money(v.materials) : "—"}
              </td>
              <td className="py-1 pr-3 text-right tabular-nums text-ink-600">
                {v.labor !== 0 ? money(v.labor) : "—"}
              </td>
              <td className="py-1 pr-3 text-right tabular-nums text-ink-600">
                {v.contractServices !== 0 ? money(v.contractServices) : "—"}
              </td>
              <td className="py-1 text-right tabular-nums text-ink-900">
                {money(v.total)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-line/70 font-semibold text-ink-900">
            <td className="py-1 pr-3">Total</td>
            <td className="py-1 pr-3 text-right tabular-nums text-ink-400">
              {(() => {
                const h = state.vendors.reduce((s, v) => s + v.hours, 0);
                return h > 0 ? fmtHours(h) : "";
              })()}
            </td>
            <td className="py-1 pr-3 text-right tabular-nums">
              {money(state.vendors.reduce((s, v) => s + v.materials, 0))}
            </td>
            <td className="py-1 pr-3 text-right tabular-nums">
              {money(state.vendors.reduce((s, v) => s + v.labor, 0))}
            </td>
            <td className="py-1 pr-3 text-right tabular-nums">
              {money(state.vendors.reduce((s, v) => s + v.contractServices, 0))}
            </td>
            <td className="py-1 text-right tabular-nums">{money(total)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
