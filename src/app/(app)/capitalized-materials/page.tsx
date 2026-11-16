import Link from "next/link";
import {
  Boxes,
  CheckCircle2,
  Download,
  HardHat,
  Package,
  Receipt,
  Truck,
} from "lucide-react";
import { requireUser } from "@/lib/auth";
import { money } from "@/lib/format";
import { monthLabel } from "@/lib/financials";
import {
  capLaborHref,
  capLaborPeriod,
  type CapLaborPeriodParams,
} from "@/lib/capitalizedLabor";
import {
  capMaterialByCompany,
  capMaterialByMonth,
  capMaterialJobRows,
  capMaterialsErrorMessage,
  capMaterialTotal,
  CAP_MATERIAL_BUCKET_LABELS,
  type CapMaterialBucket,
  type CapMaterialRollupRow,
} from "@/lib/capitalizedMaterials";
import { loadCapMaterials, type CapMaterials } from "@/lib/capitalizedMaterialsServer";
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
import { PeriodPicker } from "../capitalized-labor/PeriodPicker";
import { CapMaterialRows } from "./CapMaterialRows";

const PATH = "/capitalized-materials";

// Everything expensed on a non-billable job — EQP equipment work and
// Precision Paint's own PPS work — across every QuickBooks company, for one
// period: the expense lines cap_material_lines counts (migration 0036), what
// was already moved to an asset, and the net still awaiting review.
export default async function CapitalizedMaterialsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string } & CapLaborPeriodParams>;
}) {
  const { tab, ...periodParams } = await searchParams;
  const activeTab: CapMaterialBucket | "all" =
    tab === "equipment" || tab === "internal" ? tab : "all";

  // Capitalized Labor's period: one calendar year, one month, or a month
  // range — the current year to date by default.
  const period = capLaborPeriod(periodParams);

  // Tab links keep the period; period links keep the tab.
  const tabParam = activeTab === "all" ? null : activeTab;
  const href = (t: CapMaterialBucket | "all") =>
    capLaborHref(PATH, period.params, { tab: t === "all" ? null : t });
  const exportQuery = capLaborHref("", period.params);

  const { supabase } = await requireUser();
  // A failed read renders as a banner, not a 500 — and is logged, since a
  // banner leaves no trace in the platform logs otherwise.
  const loaded: CapMaterials | { error: string } = await loadCapMaterials(
    supabase,
    period,
  ).catch((e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`Capitalized Materials: read failed: ${message}`);
    return { error: capMaterialsErrorMessage(message) };
  });
  const loadError = "error" in loaded ? loaded.error : null;
  const { jobs, lines, multiCompany }: CapMaterials =
    "error" in loaded
      ? { jobs: new Map(), lines: [], multiCompany: false }
      : loaded;

  const candidates = capMaterialJobRows(jobs, lines);
  const equipment = candidates.filter((c) => c.bucket === "equipment");
  const internal = candidates.filter((c) => c.bucket === "internal");
  const rows =
    activeTab === "all" ? candidates : activeTab === "equipment" ? equipment : internal;

  // The breakdowns follow the active tab. A one-month period has nothing to
  // break down by month; one company has nothing to break down by company.
  const visibleJobs = new Set(rows.map((r) => r.id));
  const byMonth =
    period.fromMonth === period.toMonth
      ? null
      : capMaterialByMonth(period, lines, (jobId) => visibleJobs.has(jobId));
  const byCompany = multiCompany ? capMaterialByCompany(rows) : null;

  const total = capMaterialTotal(candidates);
  const companyCount = new Set(candidates.map((c) => c.realmId)).size;
  const plural = (n: number, one: string, many = `${one}s`) =>
    `${n} ${n === 1 ? one : many}`;
  const periodLabel = period.label;

  const tabCls = (active: boolean) =>
    `rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
      active
        ? "bg-navy-900 text-white"
        : "text-ink-600 hover:bg-surface hover:text-ink-900"
    }`;

  // Rollup tables share their money columns.
  const rollupCells = (r: CapMaterialRollupRow, cls: string) => (
    <>
      <td className={`px-4 py-2.5 text-right tabular-nums ${cls}`}>{r.jobs || "—"}</td>
      <td className={`px-4 py-2.5 text-right tabular-nums ${cls}`}>{r.txns || "—"}</td>
      <td className={`px-4 py-2.5 text-right tabular-nums ${cls}`}>
        {r.txns ? money(r.expensed) : "—"}
      </td>
      <td className={`px-4 py-2.5 text-right tabular-nums ${cls}`}>
        {r.capitalized ? money(r.capitalized) : "—"}
      </td>
      <td className="px-4 py-2.5 text-right font-medium tabular-nums text-ink-900">
        {r.txns ? money(r.net) : "—"}
      </td>
    </>
  );
  const rollupHead = (first: string) => (
    <tr>
      <Th>{first}</Th>
      <Th right>Jobs</Th>
      <Th right>Transactions</Th>
      <Th right>Expensed</Th>
      <Th right>Already capitalized</Th>
      <Th right>Awaiting review</Th>
    </tr>
  );
  const rollupTotal = (r: CapMaterialRollupRow) => (
    <tr className="border-t-2 border-line font-semibold text-ink-900">
      <td className="px-4 py-2.5">Total</td>
      <td className="px-4 py-2.5 text-right tabular-nums">{r.jobs}</td>
      <td className="px-4 py-2.5 text-right tabular-nums">{r.txns}</td>
      <td className="px-4 py-2.5 text-right tabular-nums">{money(r.expensed)}</td>
      <td className="px-4 py-2.5 text-right tabular-nums">{money(r.capitalized)}</td>
      <td className="px-4 py-2.5 text-right tabular-nums">{money(r.net)}</td>
    </tr>
  );

  return (
    <div>
      <PageHeader
        title="Capitalized Materials"
        subtitle={`Everything expensed on non-billable jobs across every QuickBooks company — materials, parts, outside services, rentals, and other costs on EQP equipment work and Precision Paint's own PPS work that may belong in a capital account rather than job cost — for ${period.label}. Pick a year, a month, or a range of months below. Payroll is reviewed on Capitalized Labor and never counted here. Cost moved to an asset account counts as already capitalized; the net is what still awaits review. Click a job to see its transactions, and see the methodology at the bottom of the page.`}
        action={
          <div className="flex gap-2">
            <a
              href={`/api/export/capitalized-materials-workbook${exportQuery}`}
              className={buttonCls("secondary")}
            >
              <Download size={15} strokeWidth={2} />
              Download Excel
            </a>
            <a
              href={`/api/export/capitalized-materials${exportQuery}`}
              className={buttonCls("secondary")}
            >
              <Download size={15} strokeWidth={2} />
              Download CSV
            </a>
          </div>
        }
      />

      <PeriodPicker path={PATH} period={period} keep={{ tab: tabParam }} />

      {loadError && (
        <p className="mb-6 rounded-lg border border-warn-700/25 bg-warn-50 px-4 py-3 text-sm text-warn-700">
          {loadError}
        </p>
      )}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatTile
          label={`Expensed (${periodLabel})`}
          value={money(total.expensed)}
          hint={`${plural(total.txns, "transaction")}, net of refunds and credits`}
          icon={Receipt}
        />
        <StatTile
          label={`Already capitalized (${periodLabel})`}
          value={money(total.capitalized)}
          hint="credited off to an asset account"
          icon={CheckCircle2}
        />
        <StatTile
          label={`Awaiting review (${periodLabel})`}
          value={money(total.net)}
          hint={`net across ${plural(total.jobs, "job")} in ${plural(companyCount, "company", "companies")}`}
          icon={Package}
        />
        <StatTile
          label="Materials"
          value={money(total.materials)}
          hint="products and parts bought on item lines"
          icon={Boxes}
        />
        <StatTile
          label="Outside labor"
          value={money(total.outsideLabor)}
          hint="labor billed by vendors — not payroll"
          icon={HardHat}
        />
        <StatTile
          label="Other expenses"
          value={money(total.other)}
          hint="services, rentals, freight, and other accounts"
          icon={Truck}
        />
      </div>

      <div className="mb-4 flex w-fit gap-1 rounded-lg border border-line bg-white p-1">
        <Link href={href("all")} className={tabCls(activeTab === "all")}>
          All ({candidates.length})
        </Link>
        <Link href={href("equipment")} className={tabCls(activeTab === "equipment")}>
          {CAP_MATERIAL_BUCKET_LABELS.equipment} ({equipment.length})
        </Link>
        <Link href={href("internal")} className={tabCls(activeTab === "internal")}>
          {CAP_MATERIAL_BUCKET_LABELS.internal} ({internal.length})
        </Link>
      </div>

      {byCompany && byCompany.length > 0 && (
        <Card className="mb-6" pad={false}>
          <div className="px-6 pt-5">
            <CardTitle>By company</CardTitle>
          </div>
          <Table head={rollupHead("QB Company")}>
            {byCompany.map((c) => (
              <tr key={c.realmId ?? c.company} className="hover:bg-surface/60">
                <td className="px-4 py-2.5 font-medium text-ink-900">{c.company}</td>
                {rollupCells(c, "text-ink-600")}
              </tr>
            ))}
            {rollupTotal(capMaterialTotal(rows))}
          </Table>
        </Card>
      )}

      {byMonth && (
        <Card className="mb-6" pad={false}>
          <div className="px-6 pt-5">
            <CardTitle>By month</CardTitle>
          </div>
          <Table head={rollupHead("Month")}>
            {byMonth.rows.map((m) => (
              <tr key={m.month} className="hover:bg-surface/60">
                <td className="px-4 py-2.5 font-medium">
                  {/* Each month opens that month on its own. */}
                  <Link
                    href={capLaborHref(PATH, { month: m.month }, { tab: tabParam })}
                    className="text-ink-900 hover:text-brand-700"
                  >
                    {monthLabel(m.month)}
                  </Link>
                </td>
                {rollupCells(m, "text-ink-600")}
              </tr>
            ))}
            {rollupTotal(byMonth.total)}
          </Table>
        </Card>
      )}

      {/* clip off so the sticky header can escape the card while scrolling */}
      <Card pad={false} clip={false}>
        {rows.length === 0 ? (
          <EmptyState icon={Package} title={`No expenses on non-billable jobs in ${period.label}`}>
            Bills, purchases, vendor credits, and non-payroll journal entries
            posted to EQP equipment jobs or Precision Paint&rsquo;s PPS jobs
            will appear here. Pick another period above, or connect QuickBooks
            in Settings and run a sync.
          </EmptyState>
        ) : (
          <Table
            stickyHeader
            head={
              <tr>
                <Th>Job</Th>
                {multiCompany && <Th>QB Company</Th>}
                <Th>Customer</Th>
                <Th>Type</Th>
                <Th right>Transactions</Th>
                <Th right>Latest</Th>
                <Th right>Expensed</Th>
                <Th right>Already capitalized</Th>
                <Th right>Awaiting review</Th>
              </tr>
            }
          >
            {/* Keyed by period so expanded jobs reload for a new period. */}
            <CapMaterialRows
              key={period.fileTag}
              jobs={rows}
              showCompany={multiCompany}
              period={period.params}
            />
          </Table>
        )}
      </Card>

      <Card className="mt-6">
        <CardTitle>Methodology</CardTitle>
        <div className="grid gap-x-8 gap-y-5 text-sm text-ink-600 lg:grid-cols-2">
          <div>
            <h3 className="mb-1 font-semibold text-ink-900">
              1. What counts as an expense
            </h3>
            <p>
              Every QuickBooks line tagged to the job that reached an{" "}
              <strong>expense account</strong>: bills, purchases (checks, cash,
              and credit-card charges), and vendor credits, plus journal-entry
              lines on expense accounts. Refunds, vendor credits, and reversals
              are negative and net against the total. A purchase posted
              straight to a fixed-asset or inventory account was never
              expensed, so it doesn&rsquo;t appear. <strong>Payroll</strong>{" "}
              (wages and employer payroll taxes) is reviewed on Capitalized
              Labor and never counted here, so no dollar appears on both
              pages; time entries post nothing to the ledger and are excluded.
              Labor a vendor bills you (outside labor, subcontracts) is an
              expense and does count.
            </p>
          </div>
          <div>
            <h3 className="mb-1 font-semibold text-ink-900">
              2. Which jobs qualify
            </h3>
            <p>
              Non-billable jobs, as the Jobs dashboard defines them, in every
              connected QuickBooks company: jobs named <em>EQP…</em> (internal
              equipment work) and, in Precision Paint&rsquo;s company, jobs
              under its own <em>PPS</em> customer (internal self-work).
              Transportation jobs (names ending LH, HS, FL, BC) are operating
              work and never qualify. Only jobs with expenses in the selected
              period are listed.
            </p>
          </div>
          <div>
            <h3 className="mb-1 font-semibold text-ink-900">
              3. How &ldquo;already capitalized&rdquo; is detected
            </h3>
            <p>
              A capitalization entry credits the expense and debits a capital
              asset. As on Capitalized Labor, a journal entry counts as
              capitalization when any of its lines debits a{" "}
              <em>Fixed Asset</em> or <em>Other Asset</em> account, whatever
              its name. <strong>Already capitalized</strong> totals the
              job-tagged expense credits on those entries, and{" "}
              <strong>Awaiting review</strong> is expensed minus already
              capitalized. A credit posted without the job tag won&rsquo;t
              appear here.
            </p>
          </div>
          <div>
            <h3 className="mb-1 font-semibold text-ink-900">
              4. Kinds of expense
            </h3>
            <p>
              <strong>Materials</strong> are products and parts bought on item
              lines; <strong>Outside labor</strong> is a bill or purchase on a
              labor item or account; <strong>Other expenses</strong> is
              everything else — services, rentals, freight, and journal-entry
              charges. The three sum to Expensed.
            </p>
          </div>
          <div>
            <h3 className="mb-1 font-semibold text-ink-900">
              5. History before 2025
            </h3>
            <p>
              Transactions dated before 2025 are frozen audited history,
              imported before vendor credits were tracked and before
              credit-card refunds were signed as credits, and item lines from
              then can&rsquo;t be traced to their account. For 2023&ndash;2024
              periods, treat Expensed as an upper bound: it may include
              refunds, omit vendor credits, and count an item bought into
              inventory.
            </p>
          </div>
          <div>
            <h3 className="mb-1 font-semibold text-ink-900">
              6. Traceability
            </h3>
            <p>
              Every line carries its QuickBooks document number so it traces
              back to the exact transaction. This page is read-only: record the
              capitalization entry in QuickBooks (tagging the job on the credit
              line), run a sync, and the amounts here update automatically.
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}
