import Link from "next/link";
import { BookOpen, Landmark } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchAllRows } from "@/lib/supabase/fetchAll";
import { moneyWhole } from "@/lib/format";
import {
  COL_DIMS,
  MONTH_PARAM,
  SCOPE_CLASSIFICATIONS,
  UNCATEGORIZED,
  buildCategoryStatement,
  currentMonth,
  defaultFrom,
  lastDayOfMonth,
  monthLabel,
  pivotColLabel,
  type ColDim,
  type PivotCell,
} from "@/lib/financials";
import {
  Card,
  EmptyState,
  PageHeader,
  StatTile,
  buttonCls,
} from "@/components/ui";
import { StatementTable } from "./StatementTable";

// Expandable income statement grouped by the Category assigned to each
// account on the Chart of Accounts page. Same ledger slice as the Financials
// pivot (gl_pivot, account rows, Revenue + Expense): each category row
// subtotals its member accounts and expands to show them.

export default async function IncomeStatementPage({
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
  // GL data is admin-only; same access pattern as /financials — requireAdmin()
  // verifies the caller, then reads go through the service-role client
  // because the admin RLS qual on the gl_* tables is too slow for app reads.
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
    return q ? `/financials/statement?${q}` : "/financials/statement";
  };

  const [cells, accountRows] = await Promise.all([
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
    fetchAllRows((fromRow, toRow) =>
      supabase
        .from("gl_accounts")
        .select("realm_id, name, fully_qualified_name, category")
        .in("classification", ["Revenue", "Expense"])
        .order("id")
        .range(fromRow, toRow),
    ) as Promise<
      {
        realm_id: string;
        name: string;
        fully_qualified_name: string | null;
        category: string | null;
      }[]
    >,
  ]);

  // gl_pivot's account row key is the account's full name, merged across
  // companies under "All companies" — map name → category the same way,
  // first assigned category winning if realms ever disagree.
  const categoryByAccount = new Map<string, string>();
  for (const a of accountRows) {
    if (!a.category) continue;
    if (company !== "all" && a.realm_id !== company) continue;
    const key = a.fully_qualified_name ?? a.name;
    if (!categoryByAccount.has(key)) categoryByAccount.set(key, a.category);
  }

  const statement = buildCategoryStatement(cells, categoryByAccount);
  const colLabels = Object.fromEntries(
    statement.colKeys.map((k) => [k, pivotColLabel(colDim, k, companyByRealm)]),
  );
  const uncategorizedCount = [
    statement.income,
    statement.directCosts,
    statement.expenses,
  ]
    .flatMap((s) => s.groups)
    .filter((g) => g.label === UNCATEGORIZED)
    .reduce((n, g) => n + g.rows.length, 0);
  const periodHint = `${monthLabel(from)} – ${monthLabel(to)}`;

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

  return (
    <div>
      <PageHeader
        title="Income Statement"
        subtitle="Income and expenses grouped by the Category assigned to each account. Click a category to expand its accounts."
        action={
          <Link href="/financials/accounts" className={buttonCls("secondary")}>
            <BookOpen size={15} strokeWidth={2} />
            Chart of Accounts
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
        <form method="get" action="/financials/statement" className={filterRowCls}>
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
        <div
          className={`mb-4 grid gap-4 sm:grid-cols-2 ${statement.grossProfit ? "xl:grid-cols-4" : "xl:grid-cols-3"}`}
        >
          <StatTile
            label="Income"
            value={moneyWhole(statement.income.total)}
            hint={periodHint}
          />
          {statement.grossProfit && (
            <StatTile
              label="Gross profit"
              value={moneyWhole(statement.grossProfit.total)}
              hint="Income less direct costs"
            />
          )}
          <StatTile
            label={statement.grossProfit ? "Operating expenses" : "Expenses"}
            value={moneyWhole(statement.expenses.total)}
            hint={periodHint}
          />
          <StatTile
            label="Net income"
            value={moneyWhole(statement.netIncome.total)}
            hint="Income less all expenses"
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
          <StatementTable
            statement={statement}
            colLabels={colLabels}
            showRowTotal={colDim !== "total"}
          />
        )}
      </Card>
      <p className="mt-3 text-xs text-ink-400">
        Categories are assigned per account on the{" "}
        <Link href="/financials/accounts" className="underline">
          Chart of Accounts
        </Link>{" "}
        page; accounts without one appear under Uncategorized
        {uncategorizedCount > 0
          ? ` (${uncategorizedCount} account${uncategorizedCount === 1 ? "" : "s"} in this view)`
          : ""}
        . Expense categories named &ldquo;Direct Costs&rdquo; (or Cost of Goods
        Sold / Cost of Sales / COGS) are shown between Income and the operating
        expense categories, and Gross profit is Income less those direct costs
        — the line appears once at least one account carries a direct-cost
        category. Amounts are the same natural-signed ledger activity as the
        Financials pivot, so Net income here matches the Financials page for
        the same filters.
      </p>
    </div>
  );
}
