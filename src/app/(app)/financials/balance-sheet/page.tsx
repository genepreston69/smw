import Link from "next/link";
import { BookOpen, Columns2, Download } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/service";
import { moneyWhole } from "@/lib/format";
import { latestMonth } from "@/lib/financials";
import {
  BALANCE_COL_DIMS,
  BALANCE_HISTORY_START,
  balanceColLabel,
  balanceSheetExportHref,
  balanceSheetHref,
  balanceSheetState,
  monthEndLabel,
  type BalanceSheetState,
} from "@/lib/balanceSheet";
import {
  balanceSheetLoadErrorMessage,
  loadBalanceSheet,
  type LoadedBalanceSheet,
} from "@/lib/balanceSheetServer";
import { Card, EmptyState, PageHeader, StatTile, buttonCls } from "@/components/ui";
import { BalanceSheetTable } from "./BalanceSheetTable";

// Month-end balance sheet, per company or consolidated. Every amount is the
// balance QuickBooks' own BalanceSheet report gives for that account at that
// month end (gl_balances, migration 0036), so each company ties to
// QuickBooks to the cent; All companies is the sum of the companies, as
// booked — no intercompany eliminations.

export default async function BalanceSheetPage({
  searchParams,
}: {
  searchParams: Promise<{ company?: string; from?: string; to?: string; cols?: string }>;
}) {
  const sp = await searchParams;
  // GL data is admin-only; same access pattern as the other Financials pages.
  await requireAdmin();
  const supabase = createServiceClient();

  const { data: connRows } = await supabase
    .from("qb_connection_status")
    .select("realm_id, company_name")
    .order("created_at");
  const companies = (connRows ?? []) as { realm_id: string; company_name: string | null }[];
  const companyByRealm = new Map(
    companies.map((c) => [c.realm_id, c.company_name ?? `Company ${c.realm_id}`]),
  );

  const state = balanceSheetState((k) => sp[k as keyof typeof sp], new Set(companyByRealm.keys()));
  const { company, from, to, cols } = state;
  const maxMonth = latestMonth();
  const href = (overrides: Partial<BalanceSheetState>) =>
    balanceSheetHref({ ...state, ...overrides });

  let loaded: LoadedBalanceSheet | null = null;
  let loadError: string | null = null;
  try {
    loaded = await loadBalanceSheet(
      supabase,
      state,
      companies.map((c) => c.realm_id),
    );
  } catch (e) {
    loadError = balanceSheetLoadErrorMessage(e instanceof Error ? e.message : String(e));
  }
  const sheet = loaded?.sheet;
  const hasData = (loaded?.cellCount ?? 0) > 0;

  const colLabels = Object.fromEntries(
    (sheet?.colKeys ?? []).map((k) => [k, balanceColLabel(cols, k, companyByRealm)]),
  );
  // Tiles read the last column: the latest month end in view, or the
  // consolidated total in the Company layout.
  const lastCol = sheet?.colKeys[sheet.colKeys.length - 1];
  const asOf = `As of ${monthEndLabel(to)}`;
  const tile = (cells: Record<string, number>) =>
    moneyWhole(lastCol ? (cells[lastCol] ?? 0) : 0);

  const pill = (active: boolean) =>
    `rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
      active ? "bg-navy-900 text-white" : "text-ink-600 hover:bg-surface hover:text-ink-900"
    }`;
  const filterRowCls = "grid grid-cols-[6rem_1fr] items-center gap-x-3 px-4 py-2";
  const filterLabel = (label: string) => (
    <span className="text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
      {label}
    </span>
  );
  const pillGroup = (label: string, children: React.ReactNode) => (
    <div className={filterRowCls}>
      {filterLabel(label)}
      <div className="flex flex-wrap items-center divide-x divide-line/70 py-0.5">{children}</div>
    </div>
  );
  const monthInput = (name: string, value: string) => (
    <input
      type="month"
      name={name}
      defaultValue={value}
      min={BALANCE_HISTORY_START}
      max={maxMonth}
      className="rounded-md border border-line bg-white px-3 py-1 text-sm text-ink-900"
    />
  );

  return (
    <div>
      <PageHeader
        title="Balance Sheet"
        subtitle="Assets, liabilities and equity at each month end, straight from QuickBooks. Click a group to expand its accounts."
        action={
          <div className="flex items-center gap-2">
            <a href={balanceSheetExportHref(state)} className={buttonCls("secondary")}>
              <Download size={15} strokeWidth={2} />
              Export Excel
            </a>
            <Link href="/financials/accounts" className={buttonCls("secondary")}>
              <BookOpen size={15} strokeWidth={2} />
              Chart of Accounts
            </Link>
          </div>
        }
      />

      <div className="mb-4 divide-y divide-line/70 rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(13,36,56,0.05)]">
        {companies.length > 1 &&
          pillGroup(
            "Company",
            <>
              <Link href={href({ company: "all" })} className={pill(company === "all")}>
                All companies
              </Link>
              {companies.map((c) => (
                <Link
                  key={c.realm_id}
                  href={href({ company: c.realm_id })}
                  className={pill(company === c.realm_id)}
                >
                  {c.company_name ?? `Company ${c.realm_id}`}
                </Link>
              ))}
            </>,
          )}
        {pillGroup(
          "Columns",
          BALANCE_COL_DIMS.filter((d) => d.key !== "company" || companies.length > 1).map((d) => (
            <Link key={d.key} href={href({ cols: d.key })} className={pill(cols === d.key)}>
              {d.label}
            </Link>
          )),
        )}
        <form method="get" action="/financials/balance-sheet" className={filterRowCls}>
          {filterLabel(cols === "company" ? "As of" : "Period")}
          {company !== "all" && <input type="hidden" name="company" value={company} />}
          {cols !== "month" && <input type="hidden" name="cols" value={cols} />}
          {cols === "company" && <input type="hidden" name="from" value={from} />}
          <div className="flex flex-wrap items-center gap-2 py-0.5">
            {cols !== "company" && (
              <>
                {monthInput("from", from)}
                <span className="text-sm text-ink-400">to</span>
              </>
            )}
            {monthInput("to", to)}
            <button type="submit" className={buttonCls("secondary", "sm")}>
              Apply
            </button>
          </div>
        </form>
      </div>

      {loadError && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {loadError}
        </div>
      )}

      {sheet && hasData && (
        <div className="mb-4 grid gap-4 sm:grid-cols-3">
          <StatTile label="Total assets" value={tile(sheet.assets.cells)} hint={asOf} />
          <StatTile label="Total liabilities" value={tile(sheet.liabilities.cells)} hint={asOf} />
          <StatTile label="Total equity" value={tile(sheet.equity.cells)} hint={asOf} />
        </div>
      )}

      <Card pad={false}>
        {!sheet || !hasData ? (
          <EmptyState icon={Columns2} title="No balances for this selection">
            {loadError
              ? "Fix the problem above, then reload."
              : "Month-end balances are imported with the general ledger: run Sync general ledger in Settings (or wait for the nightly sync), or pick another period."}
          </EmptyState>
        ) : (
          <BalanceSheetTable
            sheet={sheet}
            colLabels={colLabels}
            drillCompany={cols === "month" ? company : null}
          />
        )}
      </Card>
      <p className="mt-3 text-xs text-ink-400">
        Every amount is the balance QuickBooks&rsquo; own Balance Sheet report
        shows for that account at that month end (accrual basis), imported
        nightly with the general ledger — including the Retained Earnings and
        Net Income lines QuickBooks computes — so each company ties to
        QuickBooks to the cent. Accounts are grouped by their QuickBooks
        account type, in QuickBooks&rsquo; order. All companies adds the
        companies together as booked: there are no intercompany eliminations,
        so balances between sister companies appear on both sides. Quarter-end
        and year-end columns show the balance at the last month end of each
        quarter or year in the period. With month-end columns, click an
        account&rsquo;s balance to see that month&rsquo;s ledger activity
        behind the change. The current month is omitted until it closes;
        month ends before 2025 are the audited history, stored once and never
        re-imported.
      </p>
    </div>
  );
}
