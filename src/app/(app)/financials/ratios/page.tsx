import { Fragment } from "react";
import Link from "next/link";
import { Landmark, Table2 } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchAllRows } from "@/lib/supabase/fetchAll";
import { moneyWhole, pct } from "@/lib/format";
import {
  COL_DIMS,
  MONTH_PARAM,
  SCOPE_CLASSIFICATIONS,
  buildEliminations,
  buildIncomeStatement,
  currentMonth,
  defaultFrom,
  lastDayOfMonth,
  monthLabel,
  pivotColLabel,
  type ColDim,
  type PivotCell,
  type PivotTotals,
} from "@/lib/financials";
import {
  Card,
  EmptyState,
  PageHeader,
  StatTile,
  Table,
  Th,
  buttonCls,
} from "@/components/ui";

// Income statement ratio analysis over the same general ledger the Financials
// pivot slices (gl_pivot, account rows, Revenue + Expense classifications).
// Accounts are bucketed into statement lines by QuickBooks account type in
// buildIncomeStatement; each dollar line is followed by its ratio to total
// revenue, so margins can be read across periods at a glance.

export default async function IncomeRatiosPage({
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
  const { data: connRows } = await supabase
    .from("qb_connection_status")
    .select("realm_id, company_name")
    .order("created_at");
  const companies = (connRows ?? []) as {
    realm_id: string;
    company_name: string | null;
  }[];
  const companyByRealm = new Map(
    companies.map((c) => [c.realm_id, c.company_name ?? `Company ${c.realm_id}`]),
  );

  const company =
    sp.company && companyByRealm.has(sp.company) ? sp.company : "all";
  const from = MONTH_PARAM.test(sp.from ?? "") ? sp.from! : defaultFrom();
  const to = MONTH_PARAM.test(sp.to ?? "") ? sp.to! : currentMonth();
  const colDim = COL_DIMS.some((d) => d.key === sp.cols)
    ? (sp.cols as ColDim)
    : "month";
  const thisMonth = currentMonth();

  const href = (
    overrides: Partial<{ company: string; from: string; to: string; cols: ColDim }>,
  ) => {
    const s = { company, from, to, cols: colDim, ...overrides };
    const params = new URLSearchParams();
    if (s.company !== "all") params.set("company", s.company);
    if (s.from !== defaultFrom()) params.set("from", s.from);
    if (s.to !== currentMonth()) params.set("to", s.to);
    if (s.cols !== "month") params.set("cols", s.cols);
    const q = params.toString();
    return q ? `/financials/ratios?${q}` : "/financials/ratios";
  };

  // Same slices as the Financials page under the Net income scope: the
  // statement itself plus one revenue-by-customer slice per company in scope
  // for the Intercompany eliminations below the Net income line (per company
  // because the Marathon billing-agent rule depends on which company booked
  // the revenue).
  const eliminationRealms =
    company === "all" ? companies.map((c) => c.realm_id) : [company];
  const [cells, eliminationSlices] = await Promise.all([
    fetchAllRows((fromRow, toRow) =>
      supabase
        .rpc("gl_pivot", {
          p_start: `${from}-01`,
          p_end: lastDayOfMonth(to),
          p_row_dim: "account",
          p_col_dim: colDim,
          p_realm_id: company === "all" ? null : company,
          p_classifications: SCOPE_CLASSIFICATIONS.pl,
        })
        .order("row_key")
        .order("col_key")
        .order("classification")
        .order("account_type")
        .range(fromRow, toRow),
    ) as Promise<PivotCell[]>,
    Promise.all(
      eliminationRealms.map(async (realmId) => ({
        realmId,
        companyName: companyByRealm.get(realmId) ?? null,
        cells: (await fetchAllRows((fromRow, toRow) =>
          supabase
            .rpc("gl_pivot", {
              p_start: `${from}-01`,
              p_end: lastDayOfMonth(to),
              p_row_dim: "customer",
              p_col_dim: colDim,
              p_realm_id: realmId,
              p_classifications: SCOPE_CLASSIFICATIONS.income,
            })
            .order("row_key")
            .order("col_key")
            .order("classification")
            .order("account_type")
            .range(fromRow, toRow),
        )) as PivotCell[],
      })),
    ),
  ]);

  const stmt = buildIncomeStatement(cells);
  const denom = stmt.totalRevenue;
  const showRowTotal = colDim !== "total";
  const hasActivity = (t: PivotTotals) =>
    t.total !== 0 || [...t.bycol.values()].some((v) => v !== 0);

  // Eliminations are pure revenue removals (costs are untouched), so they
  // reduce net income and the ratio denominator by the same amounts: the
  // after-eliminations margin is (NI + elim) ÷ (revenue + elim).
  const eliminations = buildEliminations(eliminationSlices, stmt.netIncome);
  let revenueAfterElim = denom;
  if (eliminations) {
    const bycol = new Map(denom.bycol);
    let total = denom.total;
    for (const l of eliminations.lines) {
      for (const [k, v] of l.totals.bycol) bycol.set(k, (bycol.get(k) ?? 0) + v);
      total += l.totals.total;
    }
    revenueAfterElim = { bycol, total };
  }

  const ratioOf = (
    v: number | undefined,
    colKey: string | null,
    d: PivotTotals = denom,
  ): number | null => {
    const dv = colKey === null ? d.total : (d.bycol.get(colKey) ?? 0);
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

  const ratioCell = (
    v: number | undefined,
    colKey: string | null,
    d: PivotTotals = denom,
  ) => {
    const r = ratioOf(v, colKey, d);
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

  const ratioRow = (
    label: string,
    totals: PivotTotals,
    d: PivotTotals = denom,
  ) => (
    <tr className="bg-brand-50/40">
      <td className="px-4 py-1.5 pl-8 text-[0.8rem] font-medium text-ink-600">
        {label}
      </td>
      {stmt.colKeys.map((k) => ratioCell(totals.bycol.get(k), k, d))}
      {showRowTotal && ratioCell(totals.total, null, d)}
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

  const periodMargin = (t: PivotTotals) =>
    denom.total !== 0 ? pct(t.total / denom.total) : "—";
  const periodHint = `${monthLabel(from)} – ${monthLabel(to)}`;

  return (
    <div>
      <PageHeader
        title="Income Statement Ratios"
        subtitle="Margins and expense ratios as a percent of revenue, built from the QuickBooks general ledger. Accounts are grouped into statement lines by account type."
        action={
          <Link href="/financials" className={buttonCls("secondary")}>
            <Table2 size={15} strokeWidth={2} />
            Open Financials
          </Link>
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
              max={thisMonth}
              className="rounded-md border border-line bg-white px-3 py-1 text-sm text-ink-900"
            />
            <span className="text-sm text-ink-400">to</span>
            <input
              type="month"
              name="to"
              defaultValue={to}
              min="2023-01"
              max={thisMonth}
              className="rounded-md border border-line bg-white px-3 py-1 text-sm text-ink-900"
            />
            <button type="submit" className={buttonCls("secondary", "sm")}>
              Apply
            </button>
          </div>
        </form>
      </div>

      {cells.length > 0 && (
        <div className="mb-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatTile
            label="Revenue"
            value={moneyWhole(denom.total)}
            hint={periodHint}
          />
          <StatTile
            label="Gross margin"
            value={periodMargin(stmt.grossProfit)}
            hint="Revenue less cost of goods sold"
          />
          <StatTile
            label="Operating margin"
            value={periodMargin(stmt.operatingIncome)}
            hint="After operating expenses"
          />
          <StatTile
            label="Net margin"
            value={
              eliminations
                ? revenueAfterElim.total !== 0
                  ? pct(eliminations.adjusted.total / revenueAfterElim.total)
                  : "—"
                : periodMargin(stmt.netIncome)
            }
            hint={
              eliminations
                ? "After intercompany eliminations"
                : "Net income ÷ revenue"
            }
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
            {eliminations && (
              <>
                <tr className="bg-surface/50">
                  <td
                    colSpan={stmt.colKeys.length + 1 + (showRowTotal ? 1 : 0)}
                    className="px-4 py-1.5 text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-ink-400"
                  >
                    Intercompany eliminations
                  </td>
                </tr>
                {eliminations.lines.map((line) => (
                  <Fragment key={line.label}>
                    {dollarRow(line.label, line.totals)}
                  </Fragment>
                ))}
                {dollarRow("Net income after eliminations", eliminations.adjusted, {
                  bold: true,
                })}
                {ratioRow(
                  "Net margin after eliminations",
                  eliminations.adjusted,
                  revenueAfterElim,
                )}
              </>
            )}
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
        {eliminations
          ? " Intercompany eliminations back out revenue Superior Marine bills as agent for its sister companies and that both companies recognize (the same adjustment shown on the Financials page); because eliminations remove revenue only, Net margin after eliminations divides adjusted net income by adjusted revenue."
          : ""}
      </p>
    </div>
  );
}
