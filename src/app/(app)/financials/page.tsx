import Link from "next/link";
import { Download, Landmark } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchAllRows } from "@/lib/supabase/fetchAll";
import { moneyWhole } from "@/lib/format";
import {
  COL_DIMS,
  ROW_DIMS,
  SCOPES,
  SCOPE_CLASSIFICATIONS,
  buildPivot,
  currentMonth,
  financialsExportHref,
  financialsHref,
  lastDayOfMonth,
  linesHref,
  pivotColLabel,
  resolveFinancialsState,
  type FinancialsState,
  type PivotCell,
} from "@/lib/financials";
import { Card, EmptyState, PageHeader, Table, Th, buttonCls } from "@/components/ui";

// Slice-and-dice over raw general-ledger lines imported from QuickBooks
// (gl_lines / gl_accounts, migration 0009). Aggregation happens in the
// gl_pivot SQL function and table assembly in buildPivot (shared with the
// Excel export so the file always matches the screen); this page only lays
// the cells out. Every amount cell links to /financials/lines, which lists
// the raw ledger lines behind that exact cell.

export default async function FinancialsPage({
  searchParams,
}: {
  searchParams: Promise<{
    company?: string;
    from?: string;
    to?: string;
    rows?: string;
    cols?: string;
    scope?: string;
  }>;
}) {
  const sp = await searchParams;
  // Financials are admin-only. requireAdmin() verifies the caller; the reads
  // below then go through the service-role client because the admin RLS qual
  // on the gl_* tables pushes a query the size of gl_pivot past the statement
  // timeout. RLS still guards those tables against direct API access.
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

  const state = resolveFinancialsState(sp, new Set(companyByRealm.keys()));
  const { company, from, to, rows: rowDim, cols: colDim, scope } = state;
  const thisMonth = currentMonth();
  const href = (overrides: Partial<FinancialsState>) =>
    financialsHref({ ...state, ...overrides });

  // Aggregated cells; paged like every other complete list so PostgREST's
  // 1000-row cap can't silently truncate a wide pivot. The four-column
  // ordering matches the RPC's GROUP BY, so pages are deterministic.
  const cells = (await fetchAllRows((fromRow, toRow) =>
    supabase
      .rpc("gl_pivot", {
        p_start: `${from}-01`,
        p_end: lastDayOfMonth(to),
        p_row_dim: rowDim,
        p_col_dim: colDim,
        p_realm_id: company === "all" ? null : company,
        p_classifications: SCOPE_CLASSIFICATIONS[scope],
      })
      .order("row_key")
      .order("col_key")
      .order("classification")
      .order("account_type")
      .range(fromRow, toRow),
  )) as PivotCell[];

  const pivot = buildPivot(cells, rowDim, scope);
  const showRowTotal = colDim !== "total";

  const amountCell = (v: number | undefined, bold = false, drill?: string) => (
    <td
      className={`whitespace-nowrap px-4 py-2 text-right tabular-nums ${
        bold ? "font-semibold text-ink-900" : "text-ink-900"
      } ${v !== undefined && v < 0 ? "text-bad-600" : ""}`}
    >
      {v === undefined || v === 0 ? (
        <span className="text-ink-400">—</span>
      ) : drill ? (
        <Link
          href={drill}
          className="rounded-sm underline-offset-2 hover:bg-brand-50 hover:underline"
          title="View ledger lines"
        >
          {moneyWhole(v)}
        </Link>
      ) : (
        moneyWhole(v)
      )}
    </td>
  );

  const pill = (active: boolean) =>
    `rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
      active
        ? "bg-navy-900 text-white"
        : "text-ink-600 hover:bg-surface hover:text-ink-900"
    }`;
  const pillGroup = (label: string, children: React.ReactNode) => (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
        {label}
      </span>
      <div className="flex w-fit flex-wrap gap-1 rounded-lg border border-line bg-white p-1">
        {children}
      </div>
    </div>
  );

  const sectionSpan = pivot.colKeys.length + 1 + (showRowTotal ? 1 : 0);

  return (
    <div>
      <PageHeader
        title="Financials"
        subtitle={
          scope === "all"
            ? "Raw general-ledger activity imported from QuickBooks since Jan 1, 2023. Balance-sheet sections show activity for the selected period, not ending balances."
            : "Raw general-ledger activity imported from QuickBooks since Jan 1, 2023. Build your own statements by choosing what to put on rows and columns; click any amount to see the ledger lines behind it."
        }
        action={
          <a href={financialsExportHref(state)} className={buttonCls("secondary")}>
            <Download size={15} strokeWidth={2} />
            Export Excel
          </a>
        }
      />

      <div className="mb-4 space-y-2">
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
          "Scope",
          SCOPES.map((s) => (
            <Link key={s.key} href={href({ scope: s.key })} className={pill(scope === s.key)}>
              {s.label}
            </Link>
          )),
        )}
        {pillGroup(
          "Rows",
          ROW_DIMS.map((d) => (
            <Link key={d.key} href={href({ rows: d.key })} className={pill(rowDim === d.key)}>
              {d.label}
            </Link>
          )),
        )}
        {pillGroup(
          "Columns",
          COL_DIMS.map((d) => (
            <Link key={d.key} href={href({ cols: d.key })} className={pill(colDim === d.key)}>
              {d.label}
            </Link>
          )),
        )}
        <form method="get" action="/financials" className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
            Period
          </span>
          {company !== "all" && <input type="hidden" name="company" value={company} />}
          {rowDim !== "account" && <input type="hidden" name="rows" value={rowDim} />}
          {colDim !== "month" && <input type="hidden" name="cols" value={colDim} />}
          {scope !== "pl" && <input type="hidden" name="scope" value={scope} />}
          <input
            type="month"
            name="from"
            defaultValue={from}
            min="2023-01"
            max={thisMonth}
            className="rounded-lg border border-line bg-white px-3 py-1.5 text-sm text-ink-900"
          />
          <span className="text-sm text-ink-400">to</span>
          <input
            type="month"
            name="to"
            defaultValue={to}
            min="2023-01"
            max={thisMonth}
            className="rounded-lg border border-line bg-white px-3 py-1.5 text-sm text-ink-900"
          />
          <button type="submit" className={buttonCls("secondary", "sm")}>
            Apply
          </button>
        </form>
      </div>

      <Card pad={false}>
        {cells.length === 0 ? (
          <EmptyState icon={Landmark} title="No ledger data for this selection">
            Run a QuickBooks sync in Settings to import the general ledger, or
            widen the period and scope filters.
          </EmptyState>
        ) : (
          <Table
            head={
              <tr>
                <Th>{ROW_DIMS.find((d) => d.key === rowDim)!.label}</Th>
                {pivot.colKeys.map((k) => (
                  <Th key={k} right>
                    {pivotColLabel(colDim, k, companyByRealm)}
                  </Th>
                ))}
                {showRowTotal && <Th right>Total</Th>}
              </tr>
            }
          >
            {pivot.sections.map((section) => (
              <SectionRows
                key={section.label}
                label={section.label}
                showHeader={pivot.sectioned && pivot.sections.length > 1}
                rows={section.rows}
                colKeys={pivot.colKeys}
                showRowTotal={showRowTotal}
                subtotal={section.subtotal}
                span={sectionSpan}
                amountCell={amountCell}
                drillHref={(rowKey, colKey) => linesHref(state, rowKey, colKey)}
              />
            ))}
            {pivot.netIncome ? (
              <tr className="bg-surface">
                <td className="px-4 py-2 font-semibold text-ink-900">Net income</td>
                {pivot.colKeys.map((k) => amountCell(pivot.netIncome!.bycol.get(k), true))}
                {showRowTotal && amountCell(pivot.netIncome.total, true)}
              </tr>
            ) : (
              <tr className="bg-surface/70">
                <td className="px-4 py-2 font-semibold text-ink-900">
                  {pivot.totalLabel}
                </td>
                {pivot.colKeys.map((k) =>
                  amountCell(pivot.grand.bycol.get(k), true, linesHref(state, null, k)),
                )}
                {showRowTotal &&
                  amountCell(pivot.grand.total, true, linesHref(state, null, null))}
              </tr>
            )}
          </Table>
        )}
      </Card>
      <p className="mt-3 text-xs text-ink-400">
        Amounts are natural signed ledger activity: positive increases an
        account in its normal direction.
        {rowDim !== "account" && scope === "pl"
          ? " With Net income scope, each row shows income minus expenses for that slice."
          : ""}{" "}
        Net income on the account view is Income minus Expenses. Click any
        amount to drill into the underlying ledger lines.
      </p>
    </div>
  );
}

function SectionRows({
  label,
  showHeader,
  rows,
  colKeys,
  showRowTotal,
  subtotal,
  span,
  amountCell,
  drillHref,
}: {
  label: string;
  showHeader: boolean;
  rows: {
    key: string;
    accountType: string;
    cells: Map<string, number>;
    total: number;
  }[];
  colKeys: string[];
  showRowTotal: boolean;
  subtotal: { bycol: Map<string, number>; total: number } | null;
  span: number;
  amountCell: (v: number | undefined, bold?: boolean, drill?: string) => React.ReactNode;
  drillHref: (rowKey: string | null, colKey: string | null) => string;
}) {
  return (
    <>
      {showHeader && (
        <tr className="bg-surface/50">
          <td
            colSpan={span}
            className="px-4 py-1.5 text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-ink-400"
          >
            {label}
          </td>
        </tr>
      )}
      {rows.map((r) => (
        <tr key={`${label}|${r.key}`} className="hover:bg-surface/50">
          <td
            className="max-w-[26rem] truncate px-4 py-2 text-ink-900"
            title={r.accountType ? `${r.key} — ${r.accountType}` : r.key}
          >
            {r.key}
          </td>
          {colKeys.map((k) => amountCell(r.cells.get(k), false, drillHref(r.key, k)))}
          {showRowTotal && amountCell(r.total, false, drillHref(r.key, null))}
        </tr>
      ))}
      {showHeader && subtotal && (
        <tr className="bg-surface/30">
          <td className="px-4 py-2 font-medium text-ink-700">Total {label}</td>
          {colKeys.map((k) => amountCell(subtotal.bycol.get(k), true))}
          {showRowTotal && amountCell(subtotal.total, true)}
        </tr>
      )}
    </>
  );
}
