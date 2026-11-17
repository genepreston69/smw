import { Download, Scale } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/service";
import { dateTimeIn, moneyWhole } from "@/lib/format";
import { asOfLabel } from "@/lib/balanceSheet";
import { balanceSheetState, loadBalanceSheet } from "@/lib/balanceSheetServer";
import { throwIfError } from "@/lib/supabase/throwIfError";
import { Alert, Card, EmptyState, PageHeader, StatTile, buttonCls } from "@/components/ui";
import { BalanceSheetTable } from "./BalanceSheetTable";
import { PeriodSelect } from "./PeriodSelect";
import { RefreshBalanceSheetButton } from "./RefreshBalanceSheetButton";

// Each company's balance sheet as of the end of the prior month — QuickBooks'
// own BalanceSheet report, stored as a snapshot (migration 0043), not a sum of
// the imported ledger. The month shown moves on at midnight on the last day of
// each month; see docs/areas/general-ledger.md.
export const maxDuration = 300;

export default async function BalanceSheetPage({
  searchParams,
}: {
  searchParams: Promise<{ asOf?: string }>;
}) {
  const sp = await searchParams;
  // Admin-only, like the rest of Financials: verify, then read with the
  // service-role client.
  await requireAdmin();
  const supabase = createServiceClient();

  const { data: connRows, error: connRowsError } = await supabase
    .from("qb_connection_status")
    .select("realm_id, company_name")
    .order("created_at");
  throwIfError("the connected QuickBooks companies", connRowsError);
  const companies = (connRows ?? []) as {
    realm_id: string;
    company_name: string | null;
  }[];

  const state = balanceSheetState((k) => sp[k as keyof typeof sp]);
  const sheet = await loadBalanceSheet(supabase, state, companies);
  const { asOf, latest, columns } = sheet;
  const hasData = sheet.rows.length > 0;

  const hrefFor = (date: string) =>
    date === latest
      ? "/financials/balance-sheet"
      : `/financials/balance-sheet?asOf=${date}`;
  // The month in view stays listed even before it has a snapshot.
  const periods = [...new Set([latest, asOf, ...sheet.periods])].sort().reverse();
  const periodOptions = periods.map((p) => ({
    value: p,
    label: p === latest ? `${asOfLabel(p)} (prior month)` : asOfLabel(p),
    href: hrefFor(p),
  }));

  // The headline figures are the last column's: the lone company, or Combined.
  const headline = columns[columns.length - 1]?.key;
  const tile = (by: Record<string, number>) =>
    headline && by[headline] !== undefined ? moneyWhole(by[headline]) : "—";
  const tileHint = `As of ${asOfLabel(asOf)}${columns.length > 1 ? " · all companies" : ""}`;

  return (
    <div>
      <PageHeader
        title="Balance Sheet"
        subtitle={`Assets, liabilities and equity as of ${asOfLabel(asOf)}, straight from each company's QuickBooks balance sheet. Click a section to collapse it to its total.`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            {asOf === latest && !sheet.migrationMissing && <RefreshBalanceSheetButton />}
            {hasData && (
              <a
                href={`/api/export/balance-sheet?asOf=${asOf}`}
                className={buttonCls("secondary")}
              >
                <Download size={15} strokeWidth={2} />
                Export Excel
              </a>
            )}
          </div>
        }
      />

      {sheet.migrationMissing && (
        <div className="mb-4">
          <Alert tone="bad">
            The Balance Sheet needs database migration 0043_balance_sheet.sql —
            apply it in Supabase, then use Refresh from QuickBooks.
          </Alert>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-white px-4 py-2.5 shadow-[0_1px_2px_rgba(13,36,56,0.05)]">
        <span className="text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
          As of
        </span>
        <PeriodSelect value={asOf} options={periodOptions} />
        <span className="text-xs text-ink-400">
          {sheet.fetchedAt
            ? `Pulled from QuickBooks ${dateTimeIn(sheet.fetchedAt, sheet.timezone)}.`
            : "Not pulled from QuickBooks yet."}{" "}
          Moves to the next month at midnight on the last day of each month.
        </span>
      </div>

      {hasData && sheet.missing.length > 0 && (
        <div className="mb-4">
          <Alert tone="info">
            No balance sheet for this month end yet from{" "}
            {sheet.missing.join(", ")}
            {columns.length > 1 ? ", so Combined leaves " : ", so this view leaves "}
            {sheet.missing.length === 1 ? "it" : "them"} out.
          </Alert>
        </div>
      )}

      {hasData && (
        <div className="mb-4 grid gap-4 sm:grid-cols-3">
          <StatTile label="Total assets" value={tile(sheet.totals.assets)} hint={tileHint} />
          <StatTile
            label="Total liabilities"
            value={tile(sheet.totals.liabilities)}
            hint={tileHint}
          />
          <StatTile
            label="Total equity"
            value={tile(sheet.totals.equity)}
            hint="Assets less liabilities"
          />
        </div>
      )}

      <Card pad={false}>
        {hasData ? (
          <BalanceSheetTable rows={sheet.rows} columns={columns} />
        ) : (
          <EmptyState icon={Scale} title={`No balance sheet for ${asOfLabel(asOf)} yet`}>
            {asOf === latest
              ? "It is pulled from QuickBooks automatically at midnight when a month ends, and again with each nightly sync. Use Refresh from QuickBooks to pull it now."
              : "Nothing was pulled from QuickBooks for this month end. Pick another month."}
          </EmptyState>
        )}
      </Card>
      <p className="mt-3 text-xs text-ink-400">
        These are QuickBooks&rsquo; own balance sheet figures (accrual basis),
        stored per company for each month end, so every line ties to the
        Balance Sheet report in QuickBooks for the same date. The prior
        month&rsquo;s balance sheet is pulled at midnight when that month ends
        and pulled again by each nightly sync, so entries posted to it during
        the close appear the next morning; earlier month ends stay as they
        were last pulled. Net Income is the year to date through the month
        end.
        {columns.length > 1 &&
          " Combined is the plain sum of the companies, line by line, with no intercompany eliminations — intercompany receivables and payables appear on both sides."}
      </p>
    </div>
  );
}
