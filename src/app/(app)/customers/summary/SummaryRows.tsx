"use client";

import { Fragment, useState, useTransition } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  Download,
  Loader2,
} from "lucide-react";
import { hours as fmtHours, money, shortDate } from "@/lib/format";
import type {
  CustomerSummary,
  CustomerSummaryJob,
  CustomerSummaryRow,
} from "@/lib/customerSummary";
import { getJobCosts, type JobCostLine } from "@/app/(app)/jobs/actions";
import { Table, Th } from "@/components/ui";

/* ---------------------------------------------------------------------------
   Client-side column sorting, shared by every drill-down level. Clicking a
   column cycles: first direction -> reverse -> back to default order.
   Numeric columns start descending, text columns ascending; blank values
   sort last either way (same behavior as the Jobs dashboard).
--------------------------------------------------------------------------- */

type SortDir = "asc" | "desc";
interface Sort<K extends string> {
  key: K;
  dir: SortDir;
}

function nextSort<K extends string>(
  current: Sort<K> | null,
  key: K,
  descFirst: boolean,
): Sort<K> | null {
  const first: SortDir = descFirst ? "desc" : "asc";
  if (!current || current.key !== key) return { key, dir: first };
  if (current.dir === first)
    return { key, dir: first === "desc" ? "asc" : "desc" };
  return null;
}

function sortRows<T, K extends string>(
  rows: T[],
  sort: Sort<K> | null,
  value: (row: T, key: K) => string | number | null,
): T[] {
  if (!sort) return rows;
  return [...rows].sort((a, b) => {
    const va = value(a, sort.key);
    const vb = value(b, sort.key);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    const cmp = va < vb ? -1 : va > vb ? 1 : 0;
    return sort.dir === "desc" ? -cmp : cmp;
  });
}

function SortButton<K extends string>({
  label,
  k,
  sort,
  onSort,
  descFirst = true,
}: {
  label: string;
  k: K;
  sort: Sort<K> | null;
  onSort: (next: Sort<K> | null) => void;
  descFirst?: boolean;
}) {
  const active = sort?.key === k;
  const Icon = !active ? ArrowUpDown : sort.dir === "desc" ? ArrowDown : ArrowUp;
  return (
    <button
      onClick={() => onSort(nextSort(sort, k, descFirst))}
      title={
        !active
          ? "Sort"
          : `Sorted ${sort.dir === "desc" ? "descending" : "ascending"} — click to ${
              nextSort(sort, k, descFirst) ? "reverse" : "clear"
            }`
      }
      className={`inline-flex items-center gap-1 uppercase transition-colors hover:text-ink-900 ${
        active ? "text-ink-900" : ""
      }`}
    >
      {label}
      <Icon size={12} strokeWidth={2} />
    </button>
  );
}

/* ---------------------------------------------------------------------------
   Customer level
--------------------------------------------------------------------------- */

type CustomerKey =
  | "name"
  | "company"
  | "intercompany"
  | "jobs"
  | "materials"
  | "labor"
  | "contract"
  | "cost"
  | "invoiced"
  | "net";

const CUSTOMER_TEXT_KEYS: ReadonlySet<CustomerKey> = new Set([
  "name",
  "company",
]);

function customerValue(
  r: CustomerSummaryRow,
  key: CustomerKey,
): string | number | null {
  switch (key) {
    case "name":
      return r.name.toLowerCase();
    case "company":
      return r.companyName?.toLowerCase() ?? null;
    case "intercompany":
      return r.intercompany ? 1 : 0;
    case "jobs":
      return r.jobs;
    case "materials":
      return r.materials;
    case "labor":
      return r.labor;
    case "contract":
      return r.other;
    case "cost":
      return r.cost;
    case "invoiced":
      return r.invoiced;
    case "net":
      return r.net;
  }
}

export function SummaryTable({
  rows,
  totals,
  showCompany,
}: {
  rows: CustomerSummaryRow[];
  totals: CustomerSummary["totals"];
  showCompany: boolean;
}) {
  const [sort, setSort] = useState<Sort<CustomerKey> | null>(null);
  const sorted = sortRows(rows, sort, customerValue);

  const th = (k: CustomerKey, label: string, right?: boolean) => (
    <Th right={right}>
      <SortButton
        label={label}
        k={k}
        sort={sort}
        onSort={setSort}
        descFirst={!CUSTOMER_TEXT_KEYS.has(k)}
      />
    </Th>
  );

  return (
    <Table
      stickyHeader
      head={
        <tr>
          {th("name", "Customer")}
          {showCompany && th("company", "QB Company")}
          {th("intercompany", "Intercompany")}
          {th("jobs", "Jobs", true)}
          {th("materials", "Materials", true)}
          {th("labor", "Direct labor", true)}
          {th("contract", "Contract services", true)}
          {th("cost", "Actual cost", true)}
          {th("invoiced", "Invoiced", true)}
          {th("net", "Net", true)}
        </tr>
      }
    >
      <SummaryRows rows={sorted} showCompany={showCompany} />
      <tr className="border-t-2 border-line bg-surface/40 font-semibold text-ink-900">
        <td className="px-4 py-3">
          Total ({rows.length} customer{rows.length === 1 ? "" : "s"})
        </td>
        {showCompany && <td className="px-4 py-3" />}
        <td className="px-4 py-3" />
        <td className="px-4 py-3 text-right tabular-nums">{totals.jobs}</td>
        <td className="px-4 py-3 text-right tabular-nums">
          {money(totals.materials)}
        </td>
        <td className="px-4 py-3 text-right tabular-nums">
          {money(totals.labor)}
        </td>
        <td className="px-4 py-3 text-right tabular-nums">
          {money(totals.other)}
        </td>
        <td className="px-4 py-3 text-right tabular-nums">
          {money(totals.cost)}
        </td>
        <td className="px-4 py-3 text-right tabular-nums">
          {money(totals.invoiced)}
        </td>
        <td
          className={`px-4 py-3 text-right tabular-nums ${
            totals.net < 0 ? "text-bad-600" : ""
          }`}
        >
          {money(totals.net)}
        </td>
      </tr>
    </Table>
  );
}

/* ---------------------------------------------------------------------------
   Vendor aggregation (built from getJobCosts lines on first job expand)
--------------------------------------------------------------------------- */

interface VendorAgg {
  vendor: string;
  materials: number;
  labor: number;
  contractServices: number;
  total: number;
  hours: number;
  /** The vendor's cost lines, newest first (getJobCosts order). */
  lines: JobCostLine[];
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
        lines: [],
      };
      byVendor.set(key, agg);
    }
    if (l.cost_type === "materials") agg.materials += l.amount;
    else if (l.cost_type === "labor") agg.labor += l.amount;
    else agg.contractServices += l.amount;
    agg.total += l.amount;
    agg.hours += l.hours ?? 0;
    agg.lines.push(l);
  }
  return [...byVendor.values()].sort(
    (a, b) => b.total - a.total || a.vendor.localeCompare(b.vendor),
  );
}

function SummaryRows({
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

/* ---------------------------------------------------------------------------
   Job level (inside an expanded customer)
--------------------------------------------------------------------------- */

type JobKey =
  | "name"
  | "materials"
  | "labor"
  | "contract"
  | "cost"
  | "invoiced"
  | "net";

function jobNet(j: CustomerSummaryJob): number | null {
  return j.cost != null || j.invoiced != null
    ? (j.invoiced ?? 0) - (j.cost ?? 0)
    : null;
}

function jobValue(j: CustomerSummaryJob, key: JobKey): string | number | null {
  switch (key) {
    case "name":
      return j.name.toLowerCase();
    case "materials":
      return j.materials;
    case "labor":
      return j.labor;
    case "contract":
      return j.contractServices;
    case "cost":
      return j.cost;
    case "invoiced":
      return j.invoiced;
    case "net":
      return jobNet(j);
  }
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
  const [sort, setSort] = useState<Sort<JobKey> | null>(null);
  const sorted = sortRows(row.jobList, sort, jobValue);

  const th = (k: JobKey, label: string, cls: string) => (
    <th className={cls}>
      <SortButton
        label={label}
        k={k}
        sort={sort}
        onSort={setSort}
        descFirst={k !== "name"}
      />
    </th>
  );

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-4">
        <h3 className="text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
          Jobs ({row.jobList.length})
        </h3>
        <a
          href={`/api/export/customer-jobs-workbook?customer=${encodeURIComponent(row.key)}`}
          className="inline-flex items-center gap-1.5 text-[0.72rem] font-medium text-brand-700 hover:underline"
          title="Excel workbook: one worksheet per job, grouped by vendor with each transaction"
        >
          <Download size={12} strokeWidth={2} />
          Download workbook (sheet per job)
        </a>
      </div>
      <table className="w-full text-[0.8rem]">
        <thead className="text-left text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
          <tr>
            {th("name", "Job", "py-1.5 pr-3 font-semibold")}
            {th(
              "materials",
              "Materials",
              "w-28 py-1.5 pr-3 text-right font-semibold",
            )}
            {th(
              "labor",
              "Direct labor",
              "w-28 py-1.5 pr-3 text-right font-semibold",
            )}
            {th(
              "contract",
              "Contract services",
              "w-32 py-1.5 pr-3 text-right font-semibold",
            )}
            {th(
              "cost",
              "Actual cost",
              "w-28 py-1.5 pr-3 text-right font-semibold",
            )}
            {th(
              "invoiced",
              "Invoiced",
              "w-28 py-1.5 pr-3 text-right font-semibold",
            )}
            {th("net", "Net", "w-28 py-1.5 text-right font-semibold")}
          </tr>
        </thead>
        <tbody className="divide-y divide-line/50">
          {sorted.map((j) => {
            const net = jobNet(j);
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

/* ---------------------------------------------------------------------------
   Vendor level (inside an expanded job)
--------------------------------------------------------------------------- */

type VendorKey =
  | "vendor"
  | "hours"
  | "materials"
  | "labor"
  | "contract"
  | "total";

function vendorValue(v: VendorAgg, key: VendorKey): string | number | null {
  switch (key) {
    case "vendor":
      return v.vendor.toLowerCase();
    case "hours":
      return v.hours > 0 ? v.hours : null;
    case "materials":
      return v.materials;
    case "labor":
      return v.labor;
    case "contract":
      return v.contractServices;
    case "total":
      return v.total;
  }
}

/* ---------------------------------------------------------------------------
   Transaction level (inside an expanded vendor)
--------------------------------------------------------------------------- */

type TxnKey = "date" | "type" | "description" | "hours" | "amount";

const TXN_TEXT_KEYS: ReadonlySet<TxnKey> = new Set(["type", "description"]);

function txnTypeLabel(t: string): string {
  return t === "TimeActivity" ? "Time" : t === "JournalEntry" ? "Journal" : t;
}

function txnValue(l: JobCostLine, key: TxnKey): string | number | null {
  switch (key) {
    case "date":
      return l.txn_date; // YYYY-MM-DD strings sort correctly
    case "type":
      return txnTypeLabel(l.qb_txn_type).toLowerCase();
    case "description":
      return (l.description ?? l.category)?.toLowerCase() ?? null;
    case "hours":
      return l.hours;
    case "amount":
      return l.amount;
  }
}

function VendorTransactions({ lines }: { lines: JobCostLine[] }) {
  const [sort, setSort] = useState<Sort<TxnKey> | null>(null);
  const sorted = sortRows(lines, sort, txnValue);

  const th = (k: TxnKey, label: string, cls: string) => (
    <th className={cls}>
      <SortButton
        label={label}
        k={k}
        sort={sort}
        onSort={setSort}
        descFirst={!TXN_TEXT_KEYS.has(k)}
      />
    </th>
  );

  return (
    <div className="border-l-2 border-line/70 pl-4">
      <table className="w-full text-[0.75rem]">
        <thead className="text-left text-[0.6rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
          <tr>
            {th("date", "Date", "w-24 py-1 pr-3 font-semibold")}
            {th("type", "Type", "w-20 py-1 pr-3 font-semibold")}
            {th("description", "Description", "py-1 pr-3 font-semibold")}
            {th("hours", "Hours", "w-20 py-1 pr-3 text-right font-semibold")}
            {th("amount", "Amount", "w-24 py-1 text-right font-semibold")}
          </tr>
        </thead>
        <tbody className="divide-y divide-line/30">
          {sorted.map((l) => (
            <tr key={l.id}>
              <td className="w-24 whitespace-nowrap py-1 pr-3 text-ink-400">
                {shortDate(l.txn_date)}
              </td>
              <td className="w-20 py-1 pr-3 text-ink-400">
                {txnTypeLabel(l.qb_txn_type)}
              </td>
              <td className="py-1 pr-3 text-ink-600">
                {l.description ?? l.category ?? "—"}
                {l.description && l.category && (
                  <span className="text-ink-400"> · {l.category}</span>
                )}
              </td>
              <td className="w-20 py-1 pr-3 text-right tabular-nums text-ink-400">
                {l.hours != null ? fmtHours(l.hours) : ""}
              </td>
              <td className="w-24 py-1 text-right tabular-nums text-ink-900">
                {money(l.amount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function VendorBreakdown({ state }: { state: VendorState | undefined }) {
  // Local per-vendor expansion; resets when the job row collapses.
  const [openVendors, setOpenVendors] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<Sort<VendorKey> | null>(null);
  const toggleVendor = (vendor: string) =>
    setOpenVendors((prev) => {
      const next = new Set(prev);
      if (next.has(vendor)) next.delete(vendor);
      else next.add(vendor);
      return next;
    });

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

  const sortedVendors = sortRows(state.vendors, sort, vendorValue);
  const total = state.vendors.reduce((s, v) => s + v.total, 0);
  const th = (k: VendorKey, label: string, cls: string) => (
    <th className={cls}>
      <SortButton
        label={label}
        k={k}
        sort={sort}
        onSort={setSort}
        descFirst={k !== "vendor"}
      />
    </th>
  );

  return (
    <div className="border-l-2 border-line pl-4">
      <h4 className="mb-1 text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
        Vendors ({state.vendors.length})
      </h4>
      <table className="w-full text-[0.78rem]">
        <thead className="text-left text-[0.62rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
          <tr>
            {th("vendor", "Vendor / Employee", "py-1 pr-3 font-semibold")}
            {th("hours", "Hours", "w-24 py-1 pr-3 text-right font-semibold")}
            {th(
              "materials",
              "Materials",
              "w-28 py-1 pr-3 text-right font-semibold",
            )}
            {th(
              "labor",
              "Direct labor",
              "w-28 py-1 pr-3 text-right font-semibold",
            )}
            {th(
              "contract",
              "Contract services",
              "w-32 py-1 pr-3 text-right font-semibold",
            )}
            {th("total", "Total", "w-28 py-1 text-right font-semibold")}
          </tr>
        </thead>
        <tbody className="divide-y divide-line/40">
          {sortedVendors.map((v) => {
            const vendorExpanded = openVendors.has(v.vendor);
            return (
              <Fragment key={v.vendor}>
                <tr>
                  <td className="py-1 pr-3 text-ink-900">
                    <button
                      onClick={() => toggleVendor(v.vendor)}
                      className="flex items-center gap-1.5 text-left text-ink-900 hover:text-brand-700"
                      title={
                        vendorExpanded
                          ? "Hide transactions"
                          : "View transactions"
                      }
                    >
                      {vendorExpanded ? (
                        <ChevronDown
                          size={12}
                          strokeWidth={2}
                          className="shrink-0 text-ink-400"
                        />
                      ) : (
                        <ChevronRight
                          size={12}
                          strokeWidth={2}
                          className="shrink-0 text-ink-400"
                        />
                      )}
                      {v.vendor}
                    </button>
                  </td>
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
                {vendorExpanded && (
                  <tr>
                    <td colSpan={6} className="py-1.5 pl-5 pr-0">
                      <VendorTransactions lines={v.lines} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
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
