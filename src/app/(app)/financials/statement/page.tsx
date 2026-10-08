import Link from "next/link";
import { BookOpen, Download, Landmark } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/service";
import { moneyWhole } from "@/lib/format";
import {
  STATEMENT_COL_DIMS,
  UNCATEGORIZED,
  defaultFrom,
  latestMonth,
  monthLabel,
  pivotColLabel,
  statementExportHref,
} from "@/lib/financials";
import { NO_CLASS } from "@/lib/budget";
import {
  loadStatement,
  statementState,
  type LoadedStatement,
  type StatementState,
} from "@/lib/statementServer";
import {
  Card,
  EmptyState,
  PageHeader,
  StatTile,
  buttonCls,
} from "@/components/ui";
import { StatementTable } from "./StatementTable";
import { ClassSelect } from "./ClassSelect";

// Expandable income statement grouped by the Category assigned to each
// account on the Chart of Accounts page. Same ledger slice as the Financials
// pivot (gl_pivot, account rows, Revenue + Expense): each category row
// subtotals its member accounts and expands to show them. Amounts are the
// ledger as booked — no allocations or eliminations — so it ties to QB.
// One QuickBooks class at a time (Class dropdown, default All classes), with
// months as columns by default; All classes is the sum of every class.

export default async function IncomeStatementPage({
  searchParams,
}: {
  searchParams: Promise<{
    company?: string;
    from?: string;
    to?: string;
    cols?: string;
    class?: string;
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

  const state = statementState(
    (k) => sp[k as keyof typeof sp],
    new Set(companyByRealm.keys()),
  );
  const { company, from, to, cols: colDim, cls } = state;
  const maxMonth = latestMonth();

  const href = (overrides: Partial<StatementState>) => {
    const s = { ...state, ...overrides };
    const params = new URLSearchParams();
    if (s.company !== "all") params.set("company", s.company);
    if (s.from !== defaultFrom()) params.set("from", s.from);
    if (s.to !== latestMonth()) params.set("to", s.to);
    if (s.cols !== "month") params.set("cols", s.cols);
    if (s.cls !== null) params.set("class", s.cls);
    const q = params.toString();
    return q ? `/financials/statement?${q}` : "/financials/statement";
  };

  let loaded: LoadedStatement | null = null;
  let loadError: string | null = null;
  try {
    loaded = await loadStatement(
      supabase,
      state,
      companies.map((c) => c.realm_id),
    );
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e);
  }
  const statement = loaded?.statement;
  const hasData = (loaded?.cellCount ?? 0) > 0;

  // The class in view stays listed even when it has no activity in this
  // period or company, so the dropdown always shows what's selected.
  const classes = [...(loaded?.classes ?? [])];
  if (cls !== null && !classes.includes(cls)) classes.push(cls);
  const classLabel = (c: string) => (c === NO_CLASS ? "No class assigned" : c);
  const classOptions = [
    { value: "all", label: "All classes", href: href({ cls: null }) },
    ...classes.map((c) => ({ value: c, label: classLabel(c), href: href({ cls: c }) })),
  ];

  const colLabels = Object.fromEntries(
    (statement?.colKeys ?? []).map((k) => [k, pivotColLabel(colDim, k, companyByRealm)]),
  );
  const uncategorizedCount = (
    statement ? [statement.income, statement.directCosts, statement.expenses] : []
  )
    .flatMap((s) => s.groups)
    .filter((g) => g.label === UNCATEGORIZED)
    .reduce((n, g) => n + g.rows.length, 0);
  const periodHint = `${monthLabel(from)} – ${monthLabel(to)}${
    cls !== null ? ` · ${classLabel(cls)}` : ""
  }`;

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
        subtitle="Income and expenses grouped by the Category assigned to each account, for one class at a time. Click a category to expand its accounts."
        action={
          <div className="flex items-center gap-2">
            <a
              href={statementExportHref({ company, from, to, cols: colDim, cls })}
              className={buttonCls("secondary")}
            >
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
        <div className={filterRowCls}>
          {filterLabel("Class")}
          <div className="flex flex-wrap items-center gap-3 py-0.5">
            <ClassSelect value={cls ?? "all"} options={classOptions} />
            <span className="text-xs text-ink-400">
              {cls === null
                ? "Every class combined. Pick a class to see its own statement."
                : "This class only. All classes is the sum of every class."}
            </span>
          </div>
        </div>
        {pillGroup(
          "Columns",
          STATEMENT_COL_DIMS.map((d) => (
            <Link key={d.key} href={href({ cols: d.key })} className={pill(colDim === d.key)}>
              {d.label}
            </Link>
          )),
        )}
        <form method="get" action="/financials/statement" className={filterRowCls}>
          {filterLabel("Period")}
          {company !== "all" && <input type="hidden" name="company" value={company} />}
          {colDim !== "month" && <input type="hidden" name="cols" value={colDim} />}
          {cls !== null && <input type="hidden" name="class" value={cls} />}
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

      {loadError && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          The ledger could not be loaded: {loadError}
        </div>
      )}

      {statement && hasData && (
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
        {!statement || !hasData ? (
          <EmptyState icon={Landmark} title="No ledger data for this selection">
            {cls !== null
              ? "This class has no income or expense activity in the selected period and company. Pick another class or widen the period."
              : "Run a QuickBooks sync in Settings to import the general ledger, or widen the period filter."}
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
        category. Every account stays in its own category: there are no
        allocations between categories and no intercompany eliminations, so
        amounts are the same natural-signed ledger activity as the Financials
        pivot and QuickBooks, and Net income matches both for the same
        filters. The Class dropdown shows one QuickBooks class at a time;
        lines with no class are under &ldquo;No class assigned&rdquo;, and All
        classes is simply every class added together, so the class statements
        always sum to it. The % column after each amount is the common-size view: the
        amount as a percent of the same column&rsquo;s total income (columns
        with no income show a dash).
      </p>
    </div>
  );
}
