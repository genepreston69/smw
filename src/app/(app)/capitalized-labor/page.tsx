import Link from "next/link";
import {
  Building2,
  CheckCircle2,
  Download,
  HandCoins,
  HardHat,
  Layers,
  ScrollText,
  Wrench,
} from "lucide-react";
import { requireUser } from "@/lib/auth";
import { fetchAllRows } from "@/lib/supabase/fetchAll";
import { money } from "@/lib/format";
import {
  capLaborBucket,
  capLaborYears,
  CAP_LABOR_FIRST_YEAR,
  CAP_LABOR_BUCKET_LABELS,
  yearOf,
  type CapLaborBucket,
} from "@/lib/capitalizedLabor";
import { lastDayOfMonth, monthLabel } from "@/lib/financials";
import {
  Card,
  CardTitle,
  EmptyState,
  PageHeader,
  StatTile,
  Table,
  Th,
  buttonCls,
} from "@/components/ui";
import { CapLaborRows, type CapLaborRowData } from "./CapLaborRows";

interface JobRow {
  id: string;
  name: string;
  realm_id: string | null;
  customer: { display_name: string; company_name: string | null } | null;
}

// Time filter for the amounts. Switching periods never changes which jobs
// are listed or how they bucket — only the amounts shown, matching the Jobs
// dashboard. Besides the preset periods and the calendar-year pills, a
// from/to month range (the same picker as the Financials pages) sums an
// arbitrary window.
type Period = "all" | "ytd" | "mtd" | "custom" | "year";

const PERIODS: { key: "all" | "ytd" | "mtd"; label: string }[] = [
  { key: "all", label: "All time" },
  { key: "ytd", label: "Year to date" },
  { key: "mtd", label: "Month to date" },
];

const MONTH_PARAM = /^\d{4}-\d{2}$/;
const YEAR_PARAM = /^\d{4}$/;

export default async function CapitalizedLaborPage({
  searchParams,
}: {
  searchParams: Promise<{
    tab?: string;
    period?: string;
    from?: string;
    to?: string;
  }>;
}) {
  const { tab, period: periodParam, from: fromParam, to: toParam } =
    await searchParams;
  const activeTab: CapLaborBucket | "all" =
    tab === "nonbillable" || tab === "intercompany" ? tab : "all";

  // The month picker floors at the start of the imported history; the year
  // pills below can reach further back if older rows turn up in the data.
  const minMonth = `${CAP_LABOR_FIRST_YEAR}-01`;

  // Unlike Financials, the in-progress month is selectable here — the page
  // has a month-to-date preset, so the range picker allows it too.
  const nowMonth = new Date().toISOString().slice(0, 7);
  const clamp = (m: string) => (m < minMonth ? minMonth : m > nowMonth ? nowMonth : m);
  // A valid from/to pair overrides the preset pills; a lone bound fills the
  // other end with the data's edge.
  let customFrom = MONTH_PARAM.test(fromParam ?? "") ? clamp(fromParam!) : null;
  let customTo = MONTH_PARAM.test(toParam ?? "") ? clamp(toParam!) : null;
  if (customFrom || customTo) {
    customFrom ??= minMonth;
    customTo ??= nowMonth;
    if (customFrom > customTo) [customFrom, customTo] = [customTo, customFrom];
  }
  // A calendar year is selected as period=2023 — one of the year pills, or a
  // row of the by-year breakdown. Anything past the current year, or older
  // than bookkeeping itself, falls back to all time.
  const currentYear = new Date().getUTCFullYear();
  const yearParam =
    !customFrom && YEAR_PARAM.test(periodParam ?? "") ? Number(periodParam) : null;
  const activeYear =
    yearParam != null && yearParam >= 2000 && yearParam <= currentYear
      ? yearParam
      : null;
  const period: Period = customFrom
    ? "custom"
    : activeYear != null
      ? "year"
      : periodParam === "ytd" || periodParam === "mtd"
        ? periodParam
        : "all";

  // Preset/year pills drop any custom range; tab links keep the whole time
  // filter. A year is passed through as period=<year>.
  const href = (opts?: { tab?: string; period?: Period; year?: number }) => {
    const params = new URLSearchParams();
    const t = opts && "tab" in opts ? opts.tab : activeTab;
    if (t && t !== "all") params.set("tab", t);
    const y = opts && "year" in opts ? opts.year : period === "year" ? activeYear : null;
    const p = opts && "period" in opts ? opts.period : y != null ? "year" : period;
    if (p === "year" && y != null) {
      params.set("period", String(y));
    } else if (p === "custom" && customFrom && customTo) {
      params.set("from", customFrom);
      params.set("to", customTo);
    } else if (p && p !== "all" && p !== "custom" && p !== "year") {
      params.set("period", p);
    }
    const q = params.toString();
    return q ? `/capitalized-labor?${q}` : "/capitalized-labor";
  };

  // Period boundaries in UTC, matching the database rollup views
  // (current_date is UTC on Supabase). Dates are YYYY-MM-DD strings, so
  // string compare works.
  const today = new Date();
  const ytdStart = `${today.getUTCFullYear()}-01-01`;
  const mtdStart = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-01`;
  const periodStart =
    period === "custom"
      ? `${customFrom}-01`
      : period === "year"
        ? `${activeYear}-01-01`
        : period === "ytd"
          ? ytdStart
          : period === "mtd"
            ? mtdStart
            : null;
  // A custom range and a selected year are the only bounded periods — the
  // presets all run to today.
  const periodEnd =
    period === "custom"
      ? lastDayOfMonth(customTo!)
      : period === "year"
        ? `${activeYear}-12-31`
        : null;

  const { supabase } = await requireUser();
  // Paged reads (fetchAllRows) so nothing is cut off at Supabase's 1000-row
  // cap; .order("id") tie-breaks for stable pages.
  const [jobData, { data: connRows }, lineRows, { data: benefitData, error: benefitError }] =
    await Promise.all([
      fetchAllRows((from, to) =>
        supabase
          .from("jobs")
          .select(
            "id, name, realm_id, customer:customers(display_name, company_name)",
          )
          .order("name")
          .order("id")
          .range(from, to),
      ),
      supabase.from("qb_connection_status").select("realm_id, company_name"),
      fetchAllRows((from, to) =>
        supabase
          .from("job_costs")
          .select("id, job_id, qb_txn_id, txn_date, amount")
          .eq("qb_txn_type", "JournalEntry")
          .eq("cost_type", "labor")
          .order("id")
          .range(from, to),
      ),
      // Employee-benefit allocation per job — the same figure as the Jobs
      // dashboard's column — summed over the selected window and split by
      // calendar year, both from one statement (migration 0024). Reading the
      // month-grain view row by row instead re-ran the whole allocation once
      // per page of results, which blew the statement timeout.
      supabase.rpc("job_benefit_allocation_summary", {
        p_from: periodStart,
        p_to: periodEnd,
      }),
    ]);

  const companyByRealm = new Map(
    (connRows ?? []).map((c) => [c.realm_id as string, c.company_name as string | null]),
  );
  const showCompany = companyByRealm.size > 1;

  // The summary comes back as compact tuples: [job, year, amount] for every
  // year of history, and [job, amount] for the selected window.
  const summary = (benefitData ?? {}) as {
    years?: [string, number, number][];
    period?: [string, number][];
  };
  const benefitByJob = new Map<string, number>();
  for (const [jobId, amount] of summary.period ?? []) {
    benefitByJob.set(jobId, (benefitByJob.get(jobId) ?? 0) + Number(amount ?? 0));
  }
  const benefitByJobYear = new Map<string, Map<number, number>>();
  let earliestBenefitYear: number | null = null;
  for (const [jobId, year, amount] of summary.years ?? []) {
    let perYear = benefitByJobYear.get(jobId);
    if (!perYear) benefitByJobYear.set(jobId, (perYear = new Map()));
    perYear.set(year, (perYear.get(year) ?? 0) + Number(amount ?? 0));
    if (earliestBenefitYear == null || year < earliestBenefitYear) {
      earliestBenefitYear = year;
    }
  }

  // Calendar years the page breaks out: the start of the imported history
  // (2023) through the current year, reaching further back if anything older
  // turns up in the data.
  let earliestDate: string | null =
    earliestBenefitYear != null ? `${earliestBenefitYear}-01-01` : null;
  for (const l of lineRows) {
    const d = (l.txn_date as string | null) ?? null;
    if (d && (!earliestDate || d < earliestDate)) earliestDate = d;
  }
  const years = capLaborYears(earliestDate);

  // Debits (positive amounts) are payroll allocations posted to the job;
  // credits (negative amounts) are labor moved back off the labor accounts —
  // the signature a capitalization entry leaves when its credit line is
  // tagged to the job. Tracking them separately is what lets the page show
  // what may have already been capitalized vs. what still awaits review.
  interface Sums {
    debits: number;
    credits: number; // stored positive
    entryIds: Set<string>;
  }
  const newSums = (): Sums => ({ debits: 0, credits: 0, entryIds: new Set() });
  const addLine = (s: Sums, amount: number, txnId: string) => {
    if (amount >= 0) s.debits += amount;
    else s.credits += -amount;
    s.entryIds.add(txnId);
  };

  interface JobAgg {
    /** Sums over the selected period — what the table and stat tiles show. */
    period: Sums;
    inPeriod: boolean;
    /** The same sums split by calendar year, for the by-year breakdown. */
    byYear: Map<number, Sums>;
    /** Latest entry date within the selected period. */
    latestDate: string | null;
  }
  const aggByJob = new Map<string, JobAgg>();
  for (const l of lineRows) {
    const jobId = l.job_id as string;
    let agg = aggByJob.get(jobId);
    if (!agg) {
      agg = {
        period: newSums(),
        inPeriod: false,
        byYear: new Map(),
        latestDate: null,
      };
      aggByJob.set(jobId, agg);
    }
    const amount = Number(l.amount ?? 0);
    const txnId = l.qb_txn_id as string;
    const date = (l.txn_date as string | null) ?? null;
    const year = yearOf(date);
    if (year != null) {
      let yearSums = agg.byYear.get(year);
      if (!yearSums) agg.byYear.set(year, (yearSums = newSums()));
      addLine(yearSums, amount, txnId);
    }
    const inPeriod =
      (!periodStart || (date && date >= periodStart)) &&
      (!periodEnd || (date && date <= periodEnd));
    if (inPeriod) {
      addLine(agg.period, amount, txnId);
      agg.inPeriod = true;
      if (date && (!agg.latestDate || date > agg.latestDate)) {
        agg.latestDate = date;
      }
    }
  }

  // Candidate jobs: journal-entry labor posted to a non-billable or
  // intercompany job.
  const candidates: (CapLaborRowData & {
    periodDebits: number;
    periodCredits: number;
    periodNet: number;
    byYear: Map<number, Sums>;
    benefitByYear: Map<number, number> | null;
  })[] = [];
  for (const j of (jobData ?? []) as unknown as JobRow[]) {
    const agg = aggByJob.get(j.id);
    if (!agg) continue;
    const bucket = capLaborBucket({
      name: j.name,
      customerDisplayName: j.customer?.display_name,
      customerCompanyName: j.customer?.company_name,
      qbCompanyName: j.realm_id ? companyByRealm.get(j.realm_id) : null,
    });
    if (!bucket) continue;
    const net = agg.period.debits - agg.period.credits;
    candidates.push({
      id: j.id,
      name: j.name,
      companyName: (j.realm_id && companyByRealm.get(j.realm_id)) || null,
      customerName: j.customer?.display_name ?? null,
      bucket,
      grossAmount: agg.inPeriod ? agg.period.debits : null,
      capitalizedAmount: agg.inPeriod ? agg.period.credits : null,
      amount: agg.inPeriod ? net : null,
      benefitAllocation: benefitByJob.get(j.id) ?? null,
      periodDebits: agg.inPeriod ? agg.period.debits : 0,
      periodCredits: agg.inPeriod ? agg.period.credits : 0,
      periodNet: agg.inPeriod ? net : 0,
      // Entries and the latest entry date follow the period like the amounts
      // do, so a year selection reads as that year alone.
      entryCount: agg.period.entryIds.size,
      latestDate: agg.latestDate,
      byYear: agg.byYear,
      benefitByYear: benefitByJobYear.get(j.id) ?? null,
    });
  }

  // Biggest dollars first; jobs quiet in the selected period sort last.
  candidates.sort((a, b) => {
    if (a.amount == null && b.amount == null)
      return a.name.localeCompare(b.name);
    if (a.amount == null) return 1;
    if (b.amount == null) return -1;
    return b.amount - a.amount || a.name.localeCompare(b.name);
  });

  const nonBillable = candidates.filter((c) => c.bucket === "nonbillable");
  const intercompany = candidates.filter((c) => c.bucket === "intercompany");
  const rows = activeTab === "all" ? candidates : activeTab === "nonbillable" ? nonBillable : intercompany;

  // By-year breakdown of the visible (tab-filtered) candidates. Unlike the
  // table, it always spans the whole history — it's what the period pills
  // pick from, so it can't be filtered by the period itself.
  interface YearRow {
    year: number;
    jobs: number;
    entries: number;
    debits: number;
    credits: number;
    net: number;
    benefits: number;
  }
  const yearRows: YearRow[] = years.map((year) => {
    const row: YearRow = {
      year,
      jobs: 0,
      entries: 0,
      debits: 0,
      credits: 0,
      net: 0,
      benefits: 0,
    };
    for (const c of rows) {
      const sums = c.byYear.get(year);
      const benefits = c.benefitByYear?.get(year) ?? 0;
      if (sums) {
        row.jobs += 1;
        row.entries += sums.entryIds.size;
        row.debits += sums.debits;
        row.credits += sums.credits;
      }
      row.benefits += benefits;
    }
    row.net = row.debits - row.credits;
    return row;
  });
  const yearTotals = yearRows.reduce<YearRow>(
    (t, r) => ({
      year: 0,
      // A job active in several years counts once per year above, so the
      // total counts distinct jobs instead of summing the year rows.
      jobs: t.jobs,
      entries: t.entries + r.entries,
      debits: t.debits + r.debits,
      credits: t.credits + r.credits,
      net: t.net + r.net,
      benefits: t.benefits + r.benefits,
    }),
    {
      year: 0,
      jobs: rows.filter((c) => c.byYear.size > 0).length,
      entries: 0,
      debits: 0,
      credits: 0,
      net: 0,
      benefits: 0,
    },
  );

  const sumNet = (list: { periodNet: number }[]) =>
    list.reduce((s, c) => s + c.periodNet, 0);
  const grossTotal = candidates.reduce((s, c) => s + c.periodDebits, 0);
  const capitalizedTotal = candidates.reduce((s, c) => s + c.periodCredits, 0);
  const benefitTotal = candidates.reduce(
    (s, c) => s + (c.benefitAllocation ?? 0),
    0,
  );
  const entryCount = (list: { entryCount: number }[]) =>
    list.reduce((s, c) => s + c.entryCount, 0);
  const periodLabel =
    period === "custom"
      ? customFrom === customTo
        ? monthLabel(customFrom!)
        : `${monthLabel(customFrom!)} – ${monthLabel(customTo!)}`
      : period === "year"
        ? String(activeYear)
        : PERIODS.find((p) => p.key === period)!.label.toLowerCase();

  const tabCls = (active: boolean) =>
    `rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
      active
        ? "bg-navy-900 text-white"
        : "text-ink-600 hover:bg-surface hover:text-ink-900"
    }`;

  return (
    <div>
      <div className="mb-4 flex w-fit flex-wrap items-center gap-1 rounded-lg border border-line bg-white p-1">
        {PERIODS.map(({ key, label }) => (
          <Link key={key} href={href({ period: key })} className={tabCls(period === key)}>
            {label}
          </Link>
        ))}
        <span className="mx-1 h-5 w-px bg-line" />
        {/* Calendar years, back to the start of the imported history. */}
        {years.map((year) => (
          <Link
            key={year}
            href={href({ year })}
            className={tabCls(period === "year" && activeYear === year)}
          >
            {year}
          </Link>
        ))}
        <span className="mx-1 h-5 w-px bg-line" />
        {/* Custom month range; submitting drops the preset and filters the
            amounts to from..to. */}
        <form
          method="get"
          action="/capitalized-labor"
          className="flex items-center gap-2 px-1"
        >
          {activeTab !== "all" && (
            <input type="hidden" name="tab" value={activeTab} />
          )}
          <input
            type="month"
            name="from"
            defaultValue={customFrom ?? ""}
            min={minMonth}
            max={nowMonth}
            className="rounded-md border border-line bg-white px-2 py-1 text-sm text-ink-900"
          />
          <span className="text-sm text-ink-400">to</span>
          <input
            type="month"
            name="to"
            defaultValue={customTo ?? ""}
            min={minMonth}
            max={nowMonth}
            className="rounded-md border border-line bg-white px-2 py-1 text-sm text-ink-900"
          />
          <button type="submit" className={buttonCls("secondary", "sm")}>
            Apply
          </button>
        </form>
      </div>

      <PageHeader
        title="Capitalized Labor"
        subtitle={`Labor posted by journal entry to non-billable (EQP) or intercompany jobs — payroll allocations that may belong in a capital account rather than job cost, covering imported history back to Jan 1, ${years[0]}. Credits already posted against those labor accounts count as capitalized; the net is what still awaits review. Pick a year to see it on its own, click a job to see the entries, and see the methodology summary at the bottom of the page.`}
        action={
          <div className="flex gap-2">
            <a
              href="/api/export/capitalized-labor-workbook"
              className={buttonCls("secondary")}
            >
              <Download size={15} strokeWidth={2} />
              Download Excel
            </a>
            <a
              href="/api/export/capitalized-labor"
              className={buttonCls("secondary")}
            >
              <Download size={15} strokeWidth={2} />
              Download CSV
            </a>
          </div>
        }
      />

      {benefitError && (
        // Never let a failed allocation read read as "no benefits allocated".
        <p className="mb-6 rounded-lg border border-warn-700/25 bg-warn-50 px-4 py-3 text-sm text-warn-700">
          Benefit allocation couldn&rsquo;t be loaded, so those columns are
          blank: {benefitError.message}
        </p>
      )}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatTile
          label={`Labor posted (${periodLabel})`}
          value={money(grossTotal)}
          hint="journal-entry debits to labor accounts"
          icon={Layers}
        />
        <StatTile
          label={`Already capitalized (${periodLabel})`}
          value={money(capitalizedTotal)}
          hint="credits — labor moved off these jobs"
          icon={CheckCircle2}
        />
        <StatTile
          label={`Awaiting review (${periodLabel})`}
          value={money(sumNet(candidates))}
          hint={`net across ${candidates.length} job${candidates.length === 1 ? "" : "s"}`}
          icon={HardHat}
        />
        <StatTile
          label="Non-billable (EQP)"
          value={money(sumNet(nonBillable))}
          hint={`net, ${nonBillable.length} job${nonBillable.length === 1 ? "" : "s"}`}
          icon={Wrench}
        />
        <StatTile
          label="Intercompany"
          value={money(sumNet(intercompany))}
          hint={`net, ${intercompany.length} job${intercompany.length === 1 ? "" : "s"}`}
          icon={Building2}
        />
        <StatTile
          label={`Journal entries (${periodLabel})`}
          value={entryCount(candidates)}
          hint="distinct entries across candidate jobs"
          icon={ScrollText}
        />
        <StatTile
          label={`Benefit allocation (${periodLabel})`}
          value={money(benefitTotal)}
          hint="direct-labor share of employee benefits, candidate jobs"
          icon={HandCoins}
        />
      </div>

      <div className="mb-4 flex w-fit gap-1 rounded-lg border border-line bg-white p-1">
        <Link href={href({ tab: "all" })} className={tabCls(activeTab === "all")}>
          All ({candidates.length})
        </Link>
        <Link
          href={href({ tab: "nonbillable" })}
          className={tabCls(activeTab === "nonbillable")}
        >
          {CAP_LABOR_BUCKET_LABELS.nonbillable} ({nonBillable.length})
        </Link>
        <Link
          href={href({ tab: "intercompany" })}
          className={tabCls(activeTab === "intercompany")}
        >
          {CAP_LABOR_BUCKET_LABELS.intercompany} ({intercompany.length})
        </Link>
      </div>

      {/* Calendar-year split of the same candidates the table lists — the
          amounts every year pill selects, side by side. */}
      {yearTotals.entries > 0 && (
        <Card className="mb-6" pad={false}>
          <div className="px-6 pt-5">
            <CardTitle>
              By year{activeTab === "all" ? "" : ` — ${CAP_LABOR_BUCKET_LABELS[activeTab]}`}
            </CardTitle>
          </div>
          <Table
            head={
              <tr>
                <Th>Year</Th>
                <Th right>Jobs</Th>
                <Th right>Entries</Th>
                <Th right>Labor posted</Th>
                <Th right>Already capitalized</Th>
                <Th right>Awaiting review</Th>
                <Th right>Benefit allocation</Th>
              </tr>
            }
          >
            {yearRows.map((r) => {
              const selected = period === "year" && activeYear === r.year;
              return (
                <tr
                  key={r.year}
                  className={`transition-colors ${selected ? "bg-brand-50/60" : "hover:bg-surface/60"}`}
                >
                  <td className="px-4 py-3 font-medium text-ink-900">
                    <Link
                      href={href({ year: selected ? undefined : r.year, period: selected ? "all" : "year" })}
                      className="hover:text-brand-700"
                      title={selected ? "Clear the year filter" : `Show ${r.year} only`}
                    >
                      {r.year}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-ink-600">
                    {r.jobs || "—"}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-ink-600">
                    {r.entries || "—"}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-ink-600">
                    {r.debits ? money(r.debits) : "—"}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-ink-600">
                    {r.credits ? money(r.credits) : "—"}
                  </td>
                  <td className="px-4 py-3 text-right font-medium tabular-nums text-ink-900">
                    {r.debits || r.credits ? money(r.net) : "—"}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-ink-600">
                    {r.benefits ? money(r.benefits) : "—"}
                  </td>
                </tr>
              );
            })}
            <tr className="border-t-2 border-line font-semibold text-ink-900">
              <td className="px-4 py-3">
                <Link href={href({ period: "all" })} className="hover:text-brand-700">
                  All years
                </Link>
              </td>
              <td className="px-4 py-3 text-right tabular-nums">{yearTotals.jobs}</td>
              <td className="px-4 py-3 text-right tabular-nums">{yearTotals.entries}</td>
              <td className="px-4 py-3 text-right tabular-nums">{money(yearTotals.debits)}</td>
              <td className="px-4 py-3 text-right tabular-nums">{money(yearTotals.credits)}</td>
              <td className="px-4 py-3 text-right tabular-nums">{money(yearTotals.net)}</td>
              <td className="px-4 py-3 text-right tabular-nums">{money(yearTotals.benefits)}</td>
            </tr>
          </Table>
        </Card>
      )}

      {/* clip off so the sticky header can escape the card while scrolling */}
      <Card pad={false} clip={false}>
        {rows.length === 0 ? (
          <EmptyState icon={HardHat} title="No capitalized labor found">
            Journal entries that post labor, payroll, or wages accounts to
            non-billable (EQP) or intercompany jobs will appear here. Connect
            QuickBooks in Settings and run a sync.
          </EmptyState>
        ) : (
          <Table
            stickyHeader
            head={
              <tr>
                <Th>Job</Th>
                {showCompany && <Th>QB Company</Th>}
                <Th>Customer</Th>
                <Th>Type</Th>
                <Th right>Entries</Th>
                <Th right>Latest entry</Th>
                <Th right>Labor posted</Th>
                <Th right>Already capitalized</Th>
                <Th right>Awaiting review</Th>
                <Th right>Benefit allocation</Th>
              </tr>
            }
          >
            <CapLaborRows jobs={rows} showCompany={showCompany} />
          </Table>
        )}
      </Card>

      <Card className="mt-6">
        <CardTitle>Methodology</CardTitle>
        <div className="grid gap-x-8 gap-y-5 text-sm text-ink-600 lg:grid-cols-2">
          <div>
            <h3 className="mb-1 font-semibold text-ink-900">
              1. What counts as labor
            </h3>
            <p>
              Journal-entry lines imported from QuickBooks that post to an
              account whose name contains <em>labor</em>, <em>payroll</em>, or{" "}
              <em>wages</em> — the payroll allocations (e.g. Paychex gross
              wages) posted per job. Bills, purchases, and time entries are
              regular job cost and are excluded. Debits count as labor posted;
              credits count against it.
            </p>
          </div>
          <div>
            <h3 className="mb-1 font-semibold text-ink-900">
              2. Which jobs qualify
            </h3>
            <p>
              Jobs named <em>EQP…</em> (internal equipment work) bucket as
              Non-Billable; jobs whose customer is a sister company bucket as
              Intercompany. Transportation jobs (names ending LH, HS, FL, BC)
              are operating work and never qualify. Precision Paint jobs for
              Superior Marine Ways are excluded — those allocations are
              capitalized wages, already handled. Unlike the Jobs dashboard,
              there is no recent-activity cutoff — old entries still need
              review, so the page covers every imported journal line back to
              Jan 1, {years[0]}, split by calendar year.
            </p>
          </div>
          <div>
            <h3 className="mb-1 font-semibold text-ink-900">
              3. How &ldquo;already capitalized&rdquo; is detected
            </h3>
            <p>
              A capitalization entry credits the labor account and debits a
              capital (fixed-asset) account. When that credit is tagged to the
              job in QuickBooks, it lands here as a negative line, so{" "}
              <strong>Already capitalized</strong> totals those credits and{" "}
              <strong>Awaiting review</strong> is labor posted minus credits —
              what may still belong in a capital account. A credit posted
              without the job tag won&rsquo;t appear on this page; the asset
              side of such entries is visible on the Financials page.
            </p>
          </div>
          <div>
            <h3 className="mb-1 font-semibold text-ink-900">
              4. Benefit allocation
            </h3>
            <p>
              The direct-labor share of Employee Benefits attributed to each
              job — the same figure as the Jobs dashboard column: per company
              per month, Employee Benefits &times; Direct Labor &divide;
              (Direct Labor + Salaries &amp; Wages) from the Income Statement,
              distributed across jobs pro-rata by direct-labor cost, summed
              over the selected period. It covers all of a job&rsquo;s direct
              labor (not just journal entries) and is shown for context — a
              capitalization entry may need to carry this burden along with
              the labor. It is not included in the Awaiting review amounts.
            </p>
          </div>
          <div>
            <h3 className="mb-1 font-semibold text-ink-900">
              5. Traceability
            </h3>
            <p>
              Every line carries its journal number so it traces back to the
              exact entry in QuickBooks. This page is read-only: record the
              capitalization entry in QuickBooks (tagging the job on the
              credit line), run a sync, and the amounts here update
              automatically — each sync fully refreshes the imported rows.
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}
