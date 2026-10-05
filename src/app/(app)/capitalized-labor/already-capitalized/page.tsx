import Link from "next/link";
import { Archive, Download, Layers, ScrollText, Wrench } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/service";
import { money } from "@/lib/format";
import { capScheduleYear, capScheduleYears } from "@/lib/alreadyCapitalized";
import { loadCapSchedule } from "@/lib/alreadyCapitalizedServer";
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
import { EntryRows } from "./EntryRows";

// Schedule of direct labor already moved to asset accounts: every journal
// entry that debits a Fixed Asset / Other Asset account and credits labor
// (capitalized_labor_entries, migration 0032), by calendar year. Built from
// the general ledger, so it's admin-only like the Financials pages.

export default async function AlreadyCapitalizedPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string }>;
}) {
  const { year: yearParam } = await searchParams;
  // GL data is admin-only; requireAdmin() verifies the caller, then reads go
  // through the service-role client (see migrations 0014/0015).
  await requireAdmin();
  const supabase = createServiceClient();

  const years = capScheduleYears();
  const year = capScheduleYear(yearParam);

  const [{ data: connRows }, { period, schedule }] = await Promise.all([
    supabase.from("qb_connection_status").select("realm_id, company_name"),
    loadCapSchedule(supabase, year),
  ]);
  const companyName: Record<string, string> = Object.fromEntries(
    ((connRows ?? []) as { realm_id: string; company_name: string | null }[]).map((c) => [
      c.realm_id,
      c.company_name ?? `Company ${c.realm_id}`,
    ]),
  );
  const showCompany = Object.keys(companyName).length > 1;
  const { entries, byAsset, total, jobCount } = schedule;

  const pill = (active: boolean) =>
    `rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
      active
        ? "bg-navy-900 text-white"
        : "text-ink-600 hover:bg-surface hover:text-ink-900"
    }`;

  return (
    <div>
      <div className="mb-4 flex w-fit flex-wrap items-center gap-1 rounded-lg border border-line bg-white p-1">
        {years.map((y) => (
          <Link
            key={y}
            href={y === years[0] ? "/capitalized-labor/already-capitalized" : `/capitalized-labor/already-capitalized?year=${y}`}
            className={pill(y === year)}
          >
            {y}
          </Link>
        ))}
      </div>

      <PageHeader
        title="Already Capitalized"
        subtitle={`Direct labor moved to an asset account by journal entry — every entry that debits a Fixed Asset or Other Asset account and credits wages or employer payroll taxes — for ${period.label}. Click an entry to see all of its lines; the methodology is at the bottom of the page.`}
        action={
          <a
            href={`/api/export/already-capitalized?year=${year}`}
            className={buttonCls("secondary")}
          >
            <Download size={15} strokeWidth={2} />
            Download Excel
          </a>
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label={`Labor capitalized (${period.label})`}
          value={money(total)}
          hint="moved from labor accounts to assets"
          icon={Archive}
        />
        <StatTile
          label="Journal entries"
          value={entries.length}
          hint="that debit an asset and credit labor"
          icon={ScrollText}
        />
        <StatTile
          label="Asset accounts"
          value={byAsset.length}
          hint="receiving capitalized labor"
          icon={Layers}
        />
        <StatTile
          label="Jobs"
          value={jobCount}
          hint="tagged on the entries"
          icon={Wrench}
        />
      </div>

      {entries.length === 0 ? (
        <Card>
          <EmptyState icon={Archive} title={`No labor capitalized in ${period.label}`}>
            Journal entries that credit wages or employer payroll taxes and
            debit a Fixed Asset or Other Asset account appear here once the
            general ledger sync imports them. Pick another year above, or run
            a QuickBooks sync in Settings.
          </EmptyState>
        </Card>
      ) : (
        <>
          <Card className="mb-6" pad={false}>
            <div className="px-6 pt-5">
              <CardTitle>By asset account</CardTitle>
            </div>
            <Table
              head={
                <tr>
                  <Th>Asset account</Th>
                  {showCompany && <Th>QB Company</Th>}
                  <Th right>Entries</Th>
                  <Th right>Labor capitalized</Th>
                  <Th right>Share</Th>
                </tr>
              }
            >
              {byAsset.map((a) => (
                <tr key={`${a.realmId}:${a.account}`} className="hover:bg-surface/60">
                  <td className="px-4 py-3 font-medium text-ink-900">{a.account}</td>
                  {showCompany && (
                    <td className="px-4 py-3 text-ink-600">{companyName[a.realmId] ?? a.realmId}</td>
                  )}
                  <td className="px-4 py-3 text-right tabular-nums text-ink-600">{a.entries}</td>
                  <td className="px-4 py-3 text-right font-medium tabular-nums text-ink-900">
                    {money(a.labor)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-ink-600">
                    {total ? `${((a.labor / total) * 100).toFixed(1)}%` : "—"}
                  </td>
                </tr>
              ))}
              <tr className="border-t-2 border-line font-semibold text-ink-900">
                <td className="px-4 py-3">Total</td>
                {showCompany && <td />}
                <td className="px-4 py-3 text-right tabular-nums">{entries.length}</td>
                <td className="px-4 py-3 text-right tabular-nums">{money(total)}</td>
                <td className="px-4 py-3 text-right tabular-nums">100.0%</td>
              </tr>
            </Table>
          </Card>

          {/* clip off so the sticky header can escape the card while scrolling */}
          <Card pad={false} clip={false}>
            <div className="px-6 pt-5">
              <CardTitle>Journal entries</CardTitle>
            </div>
            <Table
              stickyHeader
              head={
                <tr>
                  <Th>Date</Th>
                  <Th>Journal entry</Th>
                  {showCompany && <Th>QB Company</Th>}
                  <Th>Asset account</Th>
                  <Th>Job</Th>
                  <Th right>Labor capitalized</Th>
                  <Th>Memo</Th>
                </tr>
              }
            >
              <EntryRows entries={entries} companyName={companyName} showCompany={showCompany} />
            </Table>
          </Card>
        </>
      )}

      <Card className="mt-6">
        <CardTitle>Methodology</CardTitle>
        <div className="grid gap-x-8 gap-y-5 text-sm text-ink-600 lg:grid-cols-2">
          <div>
            <h3 className="mb-1 font-semibold text-ink-900">1. Which entries count</h3>
            <p>
              Journal entries in the imported general ledger that{" "}
              <strong>debit a Fixed Asset or Other Asset account</strong> and,
              net, <strong>credit labor</strong>. The asset account varies by
              equipment and job, so entries are found by the asset&rsquo;s
              account type, never its name. Bank, receivable, and other
              current-asset accounts (an employee advance, for instance) don&rsquo;t
              count as capitalization.
            </p>
          </div>
          <div>
            <h3 className="mb-1 font-semibold text-ink-900">2. What counts as labor</h3>
            <p>
              The same accounts as the Capitalized Labor dashboard: expense
              accounts for wages (labor, payroll, wages, salaries) and the
              employer&rsquo;s share of payroll taxes (FICA, Medicare, FUTA,
              SUTA, unemployment). Withholdings and other payroll liabilities
              never count; payroll service fees are excluded.{" "}
              <strong>Labor capitalized</strong> is the entry&rsquo;s net credit
              to those accounts.
            </p>
          </div>
          <div>
            <h3 className="mb-1 font-semibold text-ink-900">3. By asset account</h3>
            <p>
              Each entry&rsquo;s labor goes to the asset it debits. When one
              entry debits several assets, its labor is split between them in
              proportion to each asset&rsquo;s debit — the ledger doesn&rsquo;t
              say which credit funded which debit. An entry that also
              capitalizes materials or other costs shows them in its expanded
              lines; only the labor is totaled here.
            </p>
          </div>
          <div>
            <h3 className="mb-1 font-semibold text-ink-900">
              4. How this relates to the dashboard
            </h3>
            <p>
              The Capitalized Labor dashboard&rsquo;s{" "}
              <em>Already capitalized</em> column counts only labor credits
              tagged to a non-billable or intercompany job, year to date. This
              schedule reads the whole ledger, so it also includes credits with
              no job tag or tagged to other jobs, and any year back to{" "}
              {years[years.length - 1]}. Each line traces to its journal number
              in QuickBooks.
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}
