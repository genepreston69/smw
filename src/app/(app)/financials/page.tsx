import Link from "next/link";
import { Landmark } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { fetchAllRows } from "@/lib/supabase/fetchAll";
import { moneyWhole } from "@/lib/format";
import { Card, EmptyState, PageHeader, Table, Th, buttonCls } from "@/components/ui";

// Slice-and-dice over raw general-ledger lines imported from QuickBooks
// (gl_lines / gl_accounts, migration 0009). All aggregation happens in the
// gl_pivot SQL function; this page only lays the cells out.
//
// Sign conventions (the ledger stores "natural" amounts — positive increases
// an account in its normal direction):
//   - Account rows show natural amounts, grouped into statement sections.
//   - Other row dimensions under Net income scope show Revenue - Expense,
//     i.e. each slice's contribution to profit.

type RowDim = "account" | "class" | "customer" | "vendor" | "txn_type" | "month";
type ColDim = "month" | "quarter" | "year" | "class" | "company" | "total";
type Scope = "pl" | "income" | "expense" | "all";

const ROW_DIMS: { key: RowDim; label: string }[] = [
  { key: "account", label: "Account" },
  { key: "class", label: "Class" },
  { key: "customer", label: "Customer" },
  { key: "vendor", label: "Vendor" },
  { key: "txn_type", label: "Transaction type" },
  { key: "month", label: "Month" },
];

const COL_DIMS: { key: ColDim; label: string }[] = [
  { key: "month", label: "Month" },
  { key: "quarter", label: "Quarter" },
  { key: "year", label: "Year" },
  { key: "class", label: "Class" },
  { key: "company", label: "Company" },
  { key: "total", label: "Total only" },
];

const SCOPES: { key: Scope; label: string }[] = [
  { key: "pl", label: "Net income" },
  { key: "income", label: "Income only" },
  { key: "expense", label: "Expenses only" },
  { key: "all", label: "All accounts" },
];

// Which account classifications each scope pulls from the ledger.
const SCOPE_CLASSIFICATIONS: Record<Scope, string[] | null> = {
  pl: ["Revenue", "Expense"],
  income: ["Revenue"],
  expense: ["Expense"],
  all: null,
};

// Statement section order and display names for the account row dimension.
const SECTIONS: { classification: string; label: string }[] = [
  { classification: "Revenue", label: "Income" },
  { classification: "Expense", label: "Expenses" },
  { classification: "Asset", label: "Assets" },
  { classification: "Liability", label: "Liabilities" },
  { classification: "Equity", label: "Equity" },
  { classification: "", label: "Other" },
];

interface PivotRow {
  classification: string | null;
  account_type: string | null;
  row_key: string;
  col_key: string;
  amount: number | string;
  line_count: number;
}

const MONTH_PARAM = /^\d{4}-\d{2}$/;

function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${y}`;
}

function lastDayOfMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

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
  const rowDim: RowDim = ROW_DIMS.some((d) => d.key === sp.rows)
    ? (sp.rows as RowDim)
    : "account";
  const colDim: ColDim = COL_DIMS.some((d) => d.key === sp.cols)
    ? (sp.cols as ColDim)
    : "month";
  const scope: Scope = SCOPES.some((s) => s.key === sp.scope)
    ? (sp.scope as Scope)
    : "pl";

  const today = new Date();
  const thisMonth = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}`;
  const from = MONTH_PARAM.test(sp.from ?? "")
    ? sp.from!
    : `${today.getUTCFullYear()}-01`;
  const to = MONTH_PARAM.test(sp.to ?? "") ? sp.to! : thisMonth;

  const { supabase } = await requireUser();
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
  const company = companyByRealm.has(sp.company ?? "") ? sp.company! : "all";

  const href = (overrides: {
    company?: string;
    from?: string;
    to?: string;
    rows?: RowDim;
    cols?: ColDim;
    scope?: Scope;
  }) => {
    const params = new URLSearchParams();
    const merged = { company, from, to, rows: rowDim, cols: colDim, scope, ...overrides };
    if (merged.company !== "all") params.set("company", merged.company);
    if (merged.from !== `${today.getUTCFullYear()}-01`) params.set("from", merged.from);
    if (merged.to !== thisMonth) params.set("to", merged.to);
    if (merged.rows !== "account") params.set("rows", merged.rows);
    if (merged.cols !== "month") params.set("cols", merged.cols);
    if (merged.scope !== "pl") params.set("scope", merged.scope);
    const q = params.toString();
    return q ? `/financials?${q}` : "/financials";
  };

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
  )) as PivotRow[];

  // ---- pivot assembly -----------------------------------------------------

  const colKeys = [...new Set(cells.map((c) => c.col_key))].sort();
  const colLabel = (key: string) =>
    colDim === "month"
      ? monthLabel(key)
      : colDim === "company"
        ? (companyByRealm.get(key) ?? key)
        : colDim === "total"
          ? "Amount"
          : key;

  // Net-income sign: on the account view every account shows its natural
  // amount; on every other row dimension, expense activity counts against
  // the slice so the Net income scope reads as profit contribution.
  const signed = (c: PivotRow): number => {
    const amount = Number(c.amount);
    if (rowDim === "account" || scope !== "pl") return amount;
    return c.classification === "Expense" ? -amount : amount;
  };

  interface DisplayRow {
    key: string;
    classification: string;
    accountType: string;
    cells: Map<string, number>;
    total: number;
  }
  const rowByKey = new Map<string, DisplayRow>();
  for (const c of cells) {
    // Off the account view the same row key can span several account
    // classifications; fold them into one display row.
    const mapKey = rowDim === "account" ? `${c.classification}|${c.row_key}` : c.row_key;
    let row = rowByKey.get(mapKey);
    if (!row) {
      row = {
        key: c.row_key,
        classification: c.classification ?? "",
        accountType: c.account_type ?? "",
        cells: new Map(),
        total: 0,
      };
      rowByKey.set(mapKey, row);
    }
    const v = signed(c);
    row.cells.set(c.col_key, (row.cells.get(c.col_key) ?? 0) + v);
    row.total += v;
  }
  const allRows = [...rowByKey.values()];

  // Account view: statement sections with subtotals (and a Net income line
  // under the P&L scope). Other dimensions: one flat list, largest first.
  const sections =
    rowDim === "account"
      ? SECTIONS.filter((s) =>
          allRows.some((r) => (r.classification || "") === s.classification),
        ).map((s) => ({
          ...s,
          rows: allRows
            .filter((r) => (r.classification || "") === s.classification)
            .sort(
              (a, b) =>
                a.accountType.localeCompare(b.accountType) ||
                a.key.localeCompare(b.key),
            ),
        }))
      : [
          {
            classification: "",
            label: SCOPES.find((s) => s.key === scope)!.label,
            rows: allRows.sort((a, b) => b.total - a.total),
          },
        ];

  const sums = (rows: DisplayRow[]) => {
    const bycol = new Map<string, number>();
    let total = 0;
    for (const r of rows) {
      for (const [k, v] of r.cells) bycol.set(k, (bycol.get(k) ?? 0) + v);
      total += r.total;
    }
    return { bycol, total };
  };
  const grand = sums(allRows);
  // Natural amounts make net income = income - expenses on the account view.
  const netIncome =
    rowDim === "account" && scope === "pl"
      ? (() => {
          const revenue = sums(allRows.filter((r) => r.classification === "Revenue"));
          const bycol = new Map(revenue.bycol);
          let total = revenue.total;
          for (const r of allRows.filter((r) => r.classification === "Expense")) {
            for (const [k, v] of r.cells) bycol.set(k, (bycol.get(k) ?? 0) - v);
            total -= r.total;
          }
          return { bycol, total };
        })()
      : null;

  const amountCell = (v: number | undefined, bold = false) => (
    <td
      className={`whitespace-nowrap px-4 py-2 text-right tabular-nums ${
        bold ? "font-semibold text-ink-900" : "text-ink-900"
      } ${v !== undefined && v < 0 ? "text-bad-600" : ""}`}
    >
      {v === undefined || v === 0 ? <span className="text-ink-400">—</span> : moneyWhole(v)}
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

  return (
    <div>
      <PageHeader
        title="Financials"
        subtitle={
          scope === "all"
            ? "Raw general-ledger activity imported from QuickBooks since Jan 1, 2023. Balance-sheet sections show activity for the selected period, not ending balances."
            : "Raw general-ledger activity imported from QuickBooks since Jan 1, 2023. Build your own statements by choosing what to put on rows and columns."
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
                {colKeys.map((k) => (
                  <Th key={k} right>
                    {colLabel(k)}
                  </Th>
                ))}
                {colDim !== "total" && <Th right>Total</Th>}
              </tr>
            }
          >
            {sections.map((section) => (
              <SectionRows
                key={section.label}
                label={section.label}
                showHeader={rowDim === "account" && sections.length > 1}
                rows={section.rows}
                colKeys={colKeys}
                showRowTotal={colDim !== "total"}
                subtotal={rowDim === "account" ? sums(section.rows) : null}
                amountCell={amountCell}
              />
            ))}
            {netIncome ? (
              <tr className="bg-surface">
                <td className="px-4 py-2 font-semibold text-ink-900">Net income</td>
                {colKeys.map((k) => amountCell(netIncome.bycol.get(k), true))}
                {colDim !== "total" && amountCell(netIncome.total, true)}
              </tr>
            ) : (
              <tr className="bg-surface/70">
                <td className="px-4 py-2 font-semibold text-ink-900">
                  {rowDim !== "account" && scope === "pl" ? "Net income" : "Total"}
                </td>
                {colKeys.map((k) => amountCell(grand.bycol.get(k), true))}
                {colDim !== "total" && amountCell(grand.total, true)}
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
        Net income on the account view is Income minus Expenses.
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
  amountCell,
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
  amountCell: (v: number | undefined, bold?: boolean) => React.ReactNode;
}) {
  const span = colKeys.length + 1 + (showRowTotal ? 1 : 0);
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
          {colKeys.map((k) => amountCell(r.cells.get(k)))}
          {showRowTotal && amountCell(r.total)}
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
