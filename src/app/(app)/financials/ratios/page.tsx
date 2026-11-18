import Link from "next/link";
import { Landmark, Scale, Table2 } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/service";
import { moneyWhole, pct } from "@/lib/format";
import {
  COL_DIMS,
  MONTH_PARAM,
  SCOPE_CLASSIFICATIONS,
  buildIncomeStatement,
  clampMonth,
  defaultFrom,
  lastDayOfMonth,
  latestMonth,
  monthLabel,
  pivotColLabel,
  type ColDim,
  type PivotCell,
  type PivotTotals,
} from "@/lib/financials";
import { asOfLabel } from "@/lib/balanceSheet";
import {
  balanceRatios,
  multiple,
  returnRatios,
  type BalanceFigures,
} from "@/lib/balanceRatios";
import { loadBalanceRatios } from "@/lib/balanceRatiosServer";
import {
  Alert,
  Card,
  EmptyState,
  PageHeader,
  StatTile,
  Table,
  Th,
  buttonCls,
} from "@/components/ui";
import { throwIfError } from "@/lib/supabase/throwIfError";
import { loadPivotCells } from "@/lib/pivotServer";

// Ratio analysis in two halves.
//
// Profitability: the same general ledger the Financials pivot slices
// (gl_pivot, account rows, Revenue + Expense classifications). Accounts are
// bucketed into statement lines by QuickBooks account type in
// buildIncomeStatement; each dollar line is followed by its ratio to total
// revenue, so margins can be read across periods at a glance.
//
// Liquidity, leverage and returns: the stored QuickBooks balance sheets
// (balance_sheet_snapshots, never a sum of the ledger — see
// docs/areas/general-ledger.md), one column per month end in the period.

export default async function FinancialRatiosPage({
  searchParams,
}: {
  searchParams: Promise<{
    company?: string;
    from?: string;
    to?: string;
    cols?: string;
  }>;
}) {
  const sp = await searchParams;
  // Financials data is admin-only; same access pattern as /financials —
  // requireAdmin() verifies the caller, then reads go through the
  // service-role client because the admin RLS qual on the gl_* tables pushes
  // gl_pivot past the statement timeout.
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
  const companyByRealm = new Map(
    companies.map((c) => [c.realm_id, c.company_name ?? `Company ${c.realm_id}`]),
  );

  const company =
    sp.company && companyByRealm.has(sp.company) ? sp.company : "all";
  // The in-progress month is omitted app-wide: params are clamped to the
  // last complete month and the pickers stop there too.
  const from = MONTH_PARAM.test(sp.from ?? "") ? clampMonth(sp.from!) : defaultFrom();
  const to = MONTH_PARAM.test(sp.to ?? "") ? clampMonth(sp.to!) : latestMonth();
  const colDim = COL_DIMS.some((d) => d.key === sp.cols)
    ? (sp.cols as ColDim)
    : "month";
  const maxMonth = latestMonth();

  const href = (
    overrides: Partial<{ company: string; from: string; to: string; cols: ColDim }>,
  ) => {
    const s = { company, from, to, cols: colDim, ...overrides };
    const params = new URLSearchParams();
    if (s.company !== "all") params.set("company", s.company);
    if (s.from !== defaultFrom()) params.set("from", s.from);
    if (s.to !== latestMonth()) params.set("to", s.to);
    if (s.cols !== "month") params.set("cols", s.cols);
    const q = params.toString();
    return q ? `/financials/ratios?${q}` : "/financials/ratios";
  };

  // Same slice as the Financials page under the Net income scope.
  const cells = (await loadPivotCells(supabase, {
    p_start: `${from}-01`,
    p_end: lastDayOfMonth(to),
    p_row_dim: "account",
    p_col_dim: colDim,
    p_realm_id: company === "all" ? null : company,
    p_classifications: SCOPE_CLASSIFICATIONS.pl,
  })) as PivotCell[];
  const balance = await loadBalanceRatios(supabase, { from, to, company }, companies);

  const stmt = buildIncomeStatement(cells);
  const denom = stmt.totalRevenue;
  const showRowTotal = colDim !== "total";
  const hasActivity = (t: PivotTotals) =>
    t.total !== 0 || [...t.bycol.values()].some((v) => v !== 0);

  const ratioOf = (v: number | undefined, colKey: string | null): number | null => {
    const dv = colKey === null ? denom.total : (denom.bycol.get(colKey) ?? 0);
    if (v === undefined || dv === 0) return null;
    return v / dv;
  };

  const moneyCell = (v: number | undefined, bold = false) => (
    <td
      className={`whitespace-nowrap px-4 py-2 text-right tabular-nums ${
        bold ? "font-semibold text-ink-900" : "text-ink-900"
      } ${v !== undefined && v < 0 ? "text-bad-600" : ""}`}
    >
      {v === undefined || v === 0 ? (
        <span className="text-ink-400">—</span>
      ) : (
        moneyWhole(v)
      )}
    </td>
  );

  const ratioCell = (v: number | undefined, colKey: string | null) => {
    const r = ratioOf(v, colKey);
    return (
      <td
        className={`whitespace-nowrap px-4 py-1.5 text-right text-[0.8rem] tabular-nums ${
          r !== null && r < 0 ? "text-bad-600" : "text-ink-600"
        }`}
      >
        {r === null ? <span className="text-ink-400">—</span> : pct(r)}
      </td>
    );
  };

  const dollarRow = (
    label: string,
    totals: PivotTotals,
    opts: { bold?: boolean } = {},
  ) => (
    <tr className={opts.bold ? "bg-surface" : "hover:bg-surface/50"}>
      <td
        className={`px-4 py-2 ${opts.bold ? "font-semibold text-ink-900" : "text-ink-900"}`}
      >
        {label}
      </td>
      {stmt.colKeys.map((k) => moneyCell(totals.bycol.get(k), opts.bold))}
      {showRowTotal && moneyCell(totals.total, opts.bold)}
    </tr>
  );

  const ratioRow = (label: string, totals: PivotTotals) => (
    <tr className="bg-brand-50/40">
      <td className="px-4 py-1.5 pl-8 text-[0.8rem] font-medium text-ink-600">
        {label}
      </td>
      {stmt.colKeys.map((k) => ratioCell(totals.bycol.get(k), k))}
      {showRowTotal && ratioCell(totals.total, null)}
    </tr>
  );

  const pill = (active: boolean) =>
    `rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
      active
        ? "bg-navy-900 text-white"
        : "text-ink-600 hover:bg-surface hover:text-ink-900"
    }`;
  const filterRowCls =
    "grid grid-cols-[6rem_1fr] items-center gap-x-3 px-4 py-2";
  const filterLabel = (label: string) => (
    <span className="text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
      {label}
    </span>
  );
  const pillGroup = (label: string, children: React.ReactNode) => (
    <div className={filterRowCls}>
      {filterLabel(label)}
      <div className="flex flex-wrap items-center divide-x divide-line/70 py-0.5">
        {children}
      </div>
    </div>
  );

  const margin = (t: PivotTotals) =>
    denom.total !== 0 ? pct(t.total / denom.total) : "—";
  const periodHint = `${monthLabel(from)} – ${monthLabel(to)}`;

  // Balance sheet half. The headline figures are the latest month end in the
  // period that has a balance sheet; the table shows every one.
  const points = balance.points.map((p) => ({ ...p, ratios: balanceRatios(p.figures) }));
  const latest = points[points.length - 1];
  const periodEnd = lastDayOfMonth(to);
  // Returns set the period's income against the balance sheet at its end, so
  // they are only stated when that month end's balance sheet is the one in hand.
  const returns =
    latest && latest.asOf === periodEnd && cells.length > 0
      ? returnRatios(
          { revenue: stmt.revenue.total, netIncome: stmt.netIncome.total, from, to },
          latest.figures,
        )
      : null;
  const incomplete = points.filter((p) => p.missing.length > 0);
  const scopeHint = company === "all" && companies.length > 1 ? " · all companies" : "";

  type Point = (typeof points)[number];
  const bsCellCls = "whitespace-nowrap px-4 text-right tabular-nums";
  const bsDollarRow = (
    label: string,
    pick: (f: BalanceFigures) => number,
    opts: { bold?: boolean } = {},
  ) => (
    <tr className={opts.bold ? "bg-surface" : "hover:bg-surface/50"}>
      <td
        className={`px-4 py-2 ${opts.bold ? "font-semibold text-ink-900" : "text-ink-900"}`}
      >
        {label}
      </td>
      {points.map((p) => {
        const v = pick(p.figures);
        return (
          <td
            key={p.asOf}
            className={`${bsCellCls} py-2 ${opts.bold ? "font-semibold" : ""} ${
              v < 0 ? "text-bad-600" : "text-ink-900"
            }`}
          >
            {moneyWhole(v)}
          </td>
        );
      })}
    </tr>
  );
  const bsRatioRow = (label: string, show: (p: Point) => string) => (
    <tr className="bg-brand-50/40">
      <td className="px-4 py-1.5 pl-8 text-[0.8rem] font-medium text-ink-600">
        {label}
      </td>
      {points.map((p) => (
        <td key={p.asOf} className={`${bsCellCls} py-1.5 text-[0.8rem] text-ink-600`}>
          {show(p)}
        </td>
      ))}
    </tr>
  );
  const sectionHeading = (title: string, note: string) => (
    <div className="mb-3 mt-8 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 className="text-base font-semibold text-ink-900">{title}</h2>
      <p className="text-sm text-ink-600">{note}</p>
    </div>
  );

  return (
    <div>
      <PageHeader
        title="Financial Ratios"
        subtitle="Profitability from the QuickBooks general ledger, and liquidity, leverage and returns from each month end's QuickBooks balance sheet."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Link href="/financials/balance-sheet" className={buttonCls("secondary")}>
              <Scale size={15} strokeWidth={2} />
              Open Balance Sheet
            </Link>
            <Link href="/financials" className={buttonCls("secondary")}>
              <Table2 size={15} strokeWidth={2} />
              Open Financials
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
          COL_DIMS.map((d) => (
            <Link key={d.key} href={href({ cols: d.key })} className={pill(colDim === d.key)}>
              {d.label}
            </Link>
          )),
        )}
        <form method="get" action="/financials/ratios" className={filterRowCls}>
          {filterLabel("Period")}
          {company !== "all" && <input type="hidden" name="company" value={company} />}
          {colDim !== "month" && <input type="hidden" name="cols" value={colDim} />}
          <div className="flex flex-wrap items-center gap-2 py-0.5">
            <input
              type="month"
              name="from"
              defaultValue={from}
              min="2023-01"
              max={maxMonth}
              className="rounded-md border border-line bg-white px-3 py-1 text-sm text-ink-900"
            />
            <span className="text-sm text-ink-400">to</span>
            <input
              type="month"
              name="to"
              defaultValue={to}
              min="2023-01"
              max={maxMonth}
              className="rounded-md border border-line bg-white px-3 py-1 text-sm text-ink-900"
            />
            <button type="submit" className={buttonCls("secondary", "sm")}>
              Apply
            </button>
          </div>
        </form>
      </div>

      {sectionHeading(
        "Profitability",
        `Margins as a percent of revenue, ${periodHint}.`,
      )}
      {cells.length > 0 && (
        <div className="mb-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatTile
            label="Revenue"
            value={moneyWhole(denom.total)}
            hint={periodHint}
          />
          <StatTile
            label="Gross margin"
            value={margin(stmt.grossProfit)}
            hint="Revenue less cost of goods sold"
          />
          <StatTile
            label="Operating margin"
            value={margin(stmt.operatingIncome)}
            hint="After operating expenses"
          />
          <StatTile
            label="Net margin"
            value={margin(stmt.netIncome)}
            hint="Net income ÷ revenue"
          />
        </div>
      )}

      <Card pad={false}>
        {cells.length === 0 ? (
          <EmptyState icon={Landmark} title="No ledger data for this selection">
            Run a QuickBooks sync in Settings to import the general ledger, or
            widen the period filter.
          </EmptyState>
        ) : (
          <Table
            head={
              <tr>
                <Th>Line</Th>
                {stmt.colKeys.map((k) => (
                  <Th key={k} right>
                    {pivotColLabel(colDim, k, companyByRealm)}
                  </Th>
                ))}
                {showRowTotal && <Th right>Total</Th>}
              </tr>
            }
          >
            {dollarRow("Revenue", stmt.revenue)}
            {dollarRow("Cost of goods sold", stmt.cogs)}
            {ratioRow("COGS % of revenue", stmt.cogs)}
            {dollarRow("Gross profit", stmt.grossProfit, { bold: true })}
            {ratioRow("Gross margin", stmt.grossProfit)}
            {dollarRow("Operating expenses", stmt.opex)}
            {ratioRow("Operating expenses % of revenue", stmt.opex)}
            {dollarRow("Operating income", stmt.operatingIncome, { bold: true })}
            {ratioRow("Operating margin", stmt.operatingIncome)}
            {hasActivity(stmt.otherIncome) && dollarRow("Other income", stmt.otherIncome)}
            {hasActivity(stmt.otherExpense) &&
              dollarRow("Other expense", stmt.otherExpense)}
            {dollarRow("Net income", stmt.netIncome, { bold: true })}
            {ratioRow("Net margin", stmt.netIncome)}
          </Table>
        )}
      </Card>
      <p className="mt-3 text-xs text-ink-400">
        Statement lines follow QuickBooks account types: Cost of Goods Sold,
        Other Income, and Other Expense accounts are split out; every other
        income account is Revenue and every other expense account is Operating
        expenses. Ratios divide by total revenue (other income included), so
        Net margin here matches Net income as a percent of revenue on the
        Financials page. Columns with no revenue show a dash. Drill into
        individual accounts on the Financials page.
      </p>

      {sectionHeading(
        "Liquidity and leverage",
        latest
          ? `From the QuickBooks balance sheet, as of ${asOfLabel(latest.asOf)}${scopeHint}.`
          : "From the QuickBooks balance sheet at each month end.",
      )}
      {balance.migrationMissing && (
        <div className="mb-4">
          <Alert tone="bad">
            Balance sheet ratios need database migration 0043_balance_sheet.sql —
            apply it in Supabase, then pull the balance sheet from the Balance
            Sheet page.
          </Alert>
        </div>
      )}
      {incomplete.length > 0 && (
        <div className="mb-4">
          <Alert tone="info">
            Some companies have no balance sheet for every month end shown, so
            those columns leave them out:{" "}
            {incomplete
              .map((p) => `${monthLabel(p.asOf.slice(0, 7))} — ${p.missing.join(", ")}`)
              .join("; ")}
            .
          </Alert>
        </div>
      )}
      {latest && (
        <div className="mb-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatTile
            label="Current ratio"
            value={multiple(latest.ratios.currentRatio)}
            hint="Current assets ÷ current liabilities"
          />
          <StatTile
            label="Quick ratio"
            value={multiple(latest.ratios.quickRatio)}
            hint="Cash and receivables ÷ current liabilities"
          />
          <StatTile
            label="Working capital"
            value={moneyWhole(latest.ratios.workingCapital)}
            hint="Current assets less current liabilities"
          />
          <StatTile
            label="Debt to equity"
            value={multiple(latest.ratios.debtToEquity)}
            hint="Total liabilities ÷ total equity"
          />
        </div>
      )}
      <Card pad={false}>
        {points.length === 0 ? (
          <EmptyState icon={Scale} title="No balance sheet in this period yet">
            {balance.migrationMissing
              ? "The balance sheet table is not in the database yet."
              : "A balance sheet is pulled from QuickBooks when each month ends, so these ratios start with the first month end pulled. Use Refresh from QuickBooks on the Balance Sheet page to pull the prior month now, or widen the period."}
          </EmptyState>
        ) : (
          <Table
            head={
              <tr>
                <Th>Line</Th>
                {points.map((p) => (
                  <Th key={p.asOf} right>
                    {monthLabel(p.asOf.slice(0, 7))}
                  </Th>
                ))}
              </tr>
            }
          >
            {bsDollarRow("Cash and receivables", (f) => f.cash + f.receivables)}
            {bsDollarRow("Current assets", (f) => f.currentAssets)}
            {bsDollarRow("Current liabilities", (f) => f.currentLiabilities)}
            {bsDollarRow(
              "Working capital",
              (f) => f.currentAssets - f.currentLiabilities,
              { bold: true },
            )}
            {bsRatioRow("Current ratio", (p) => multiple(p.ratios.currentRatio))}
            {bsRatioRow("Quick ratio", (p) => multiple(p.ratios.quickRatio))}
            {bsDollarRow("Total assets", (f) => f.totalAssets)}
            {bsDollarRow("Total liabilities", (f) => f.totalLiabilities)}
            {bsDollarRow("Total equity", (f) => f.equity, { bold: true })}
            {bsRatioRow("Debt to equity", (p) => multiple(p.ratios.debtToEquity))}
            {bsRatioRow("Debt to assets", (p) =>
              p.ratios.debtToAssets === null ? "—" : pct(p.ratios.debtToAssets),
            )}
          </Table>
        )}
      </Card>

      {sectionHeading(
        "Returns and collection",
        `Income for ${periodHint} against the balance sheet as of ${asOfLabel(periodEnd)}${scopeHint}.`,
      )}
      {returns ? (
        <div className="grid gap-4 sm:grid-cols-3">
          <StatTile
            label="Return on assets"
            value={returns.returnOnAssets === null ? "—" : pct(returns.returnOnAssets)}
            hint="Net income at an annual rate ÷ total assets"
          />
          <StatTile
            label="Return on equity"
            value={returns.returnOnEquity === null ? "—" : pct(returns.returnOnEquity)}
            hint="Net income at an annual rate ÷ total equity"
          />
          <StatTile
            label="Days sales outstanding"
            value={
              returns.daysSalesOutstanding === null
                ? "—"
                : `${Math.round(returns.daysSalesOutstanding)} days`
            }
            hint="Receivables ÷ average revenue per day"
          />
        </div>
      ) : (
        <Card>
          <p className="text-sm text-ink-600">
            These need both ledger activity for the period and a balance sheet
            as of {asOfLabel(periodEnd)}. End the period on a month that has a
            balance sheet to see them.
          </p>
        </Card>
      )}
      <p className="mt-3 text-xs text-ink-400">
        Balance sheet figures are QuickBooks&rsquo; own section totals for each
        month end, as stored on the Balance Sheet page, and follow the Company
        filter only — one column per month end in the period that has a
        balance sheet, whatever the Columns setting. Cash is the Bank Accounts
        section and receivables the Accounts Receivable section, so the quick
        ratio leaves out inventory and other current assets. Returns restate
        the period&rsquo;s net income to an annual rate (× 12 ÷ months in the
        period) and divide by the period-end balance, not an average; days
        sales outstanding uses operating revenue. A ratio over a zero or
        negative base shows a dash.
        {company === "all" &&
          companies.length > 1 &&
          " All companies is the plain sum of the companies with no intercompany eliminations, so intercompany receivables and payables sit on both sides and pull the ratios toward 1 — pick a company for its own."}
      </p>
    </div>
  );
}
