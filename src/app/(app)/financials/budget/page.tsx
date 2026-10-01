import Link from "next/link";
import { BookOpen, Landmark } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchAllRows } from "@/lib/supabase/fetchAll";
import { moneyWhole } from "@/lib/format";
import {
  SCOPE_CLASSIFICATIONS,
  buildCategoryStatement,
  buildEliminations,
  lastDayOfMonth,
  latestMonth,
  monthLabel,
  serializeEliminations,
  type PivotCell,
  type PivotTotals,
  type RealmRevenueSlice,
} from "@/lib/financials";
import {
  BUDGET_COL_DIMS,
  BUDGET_VIEWS,
  BUDGET_YEAR,
  MONTH_NAMES,
  actualCells,
  baselineRange,
  budgetColKey,
  budgetColLabel,
  growBaselineCells,
  growEliminationSlice,
  initiativeCells,
  initiativeTotals,
  type BudgetAssumption,
  type BudgetColDim,
  type BudgetInitiative,
  type BudgetView,
  type MonthToCol,
} from "@/lib/budget";
import { Card, EmptyState, PageHeader, StatTile, buttonCls } from "@/components/ui";
import { StatementTable } from "../statement/StatementTable";
import { AssumptionsEditor } from "./AssumptionsEditor";
import { InitiativesPanel, type InitiativeAccount } from "./InitiativesPanel";
import { VarianceTable } from "./VarianceTable";

// Calendar-year budget in the Income Statement's layout. Baseline = each
// account's actuals for the twelve months ending June 30 of the prior year,
// mapped month-for-month onto the budget year and grown by each company's
// revenue / expense growth assumptions. Approved new initiatives fold into
// their accounts' categories; proposed ones are listed but excluded until
// approved. The Budget vs Actual view compares year-to-date budget with
// ledger actuals once budget-year months close.

type RpcPage = { data: PivotCell[] | null; error: { message: string } | null };

export default async function BudgetPage({
  searchParams,
}: {
  searchParams: Promise<{ company?: string; cols?: string; view?: string }>;
}) {
  const sp = await searchParams;
  await requireAdmin();
  const supabase = createServiceClient();
  const year = BUDGET_YEAR;
  const baseline = baselineRange(year);

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
  const colDim = BUDGET_COL_DIMS.some((d) => d.key === sp.cols)
    ? (sp.cols as BudgetColDim)
    : "month";
  const view = BUDGET_VIEWS.some((v) => v.key === sp.view)
    ? (sp.view as BudgetView)
    : "budget";
  const realms =
    company === "all" ? companies.map((c) => c.realm_id) : [company];

  const href = (
    overrides: Partial<{ company: string; cols: BudgetColDim; view: BudgetView }>,
  ) => {
    const s = { company, cols: colDim, view, ...overrides };
    const params = new URLSearchParams();
    if (s.company !== "all") params.set("company", s.company);
    if (s.cols !== "month") params.set("cols", s.cols);
    if (s.view !== "budget") params.set("view", s.view);
    const q = params.toString();
    return q ? `/financials/budget?${q}` : "/financials/budget";
  };

  // Budget-year months already closed (the in-progress month never counts).
  const latest = latestMonth();
  const closedThrough =
    latest < `${year}-01` ? 0 : latest >= `${year}-12` ? 12 : Number(latest.slice(5, 7));

  const pivot = (
    realmId: string,
    from: string,
    to: string,
    rowDim: "account" | "customer",
    classifications: string[] | null,
  ) =>
    fetchAllRows((fromRow, toRow) =>
      supabase
        .rpc("gl_pivot", {
          p_start: `${from}-01`,
          p_end: lastDayOfMonth(to),
          p_row_dim: rowDim,
          p_col_dim: "month",
          p_realm_id: realmId,
          p_classifications: classifications,
        })
        .order("row_key")
        .order("col_key")
        .order("classification")
        .order("account_type")
        .range(fromRow, toRow) as unknown as PromiseLike<RpcPage>,
    );

  const wantEliminations = company === "all";
  const wantActuals = view === "variance" && closedThrough > 0;
  const actualTo = `${year}-${String(closedThrough).padStart(2, "0")}`;

  const [
    baselineByRealm,
    customerByRealm,
    actualByRealm,
    actualCustomerByRealm,
    accountRows,
    assumptionRows,
    initiativeRows,
  ] = await Promise.all([
    Promise.all(
      realms.map((r) =>
        pivot(r, baseline.from, baseline.to, "account", SCOPE_CLASSIFICATIONS.pl),
      ),
    ),
    Promise.all(
      (wantEliminations ? realms : []).map((r) =>
        pivot(r, baseline.from, baseline.to, "customer", SCOPE_CLASSIFICATIONS.income),
      ),
    ),
    Promise.all(
      (wantActuals ? realms : []).map((r) =>
        pivot(r, `${year}-01`, actualTo, "account", SCOPE_CLASSIFICATIONS.pl),
      ),
    ),
    Promise.all(
      (wantActuals && wantEliminations ? realms : []).map((r) =>
        pivot(r, `${year}-01`, actualTo, "customer", SCOPE_CLASSIFICATIONS.income),
      ),
    ),
    fetchAllRows((fromRow, toRow) =>
      supabase
        .from("gl_accounts")
        .select("realm_id, name, fully_qualified_name, classification, category, active")
        .in("classification", ["Revenue", "Expense"])
        .order("id")
        .range(fromRow, toRow),
    ) as Promise<
      {
        realm_id: string;
        name: string;
        fully_qualified_name: string | null;
        classification: "Revenue" | "Expense";
        category: string | null;
        active: boolean;
      }[]
    >,
    supabase
      .from("budget_assumptions")
      .select("realm_id, revenue_growth_pct, expense_growth_pct")
      .eq("budget_year", year),
    supabase
      .from("budget_initiatives")
      .select(
        "id, realm_id, name, description, start_month, status, created_at, approved_at, approved_by, budget_initiative_lines (account_name, classification, annual_amount)",
      )
      .eq("budget_year", year)
      .order("created_at"),
  ]);

  const assumptionByRealm = new Map<string, BudgetAssumption>(
    ((assumptionRows.data ?? []) as BudgetAssumption[]).map((a) => [
      a.realm_id,
      {
        realm_id: a.realm_id,
        revenue_growth_pct: Number(a.revenue_growth_pct),
        expense_growth_pct: Number(a.expense_growth_pct),
      },
    ]),
  );

  type InitiativeRow = Omit<BudgetInitiative, "lines" | "approved_by_name"> & {
    approved_by: string | null;
    budget_initiative_lines: {
      account_name: string;
      classification: "Revenue" | "Expense";
      annual_amount: number | string;
    }[];
  };
  const rawInitiatives = (initiativeRows.data ?? []) as InitiativeRow[];
  const approverIds = [
    ...new Set(rawInitiatives.map((i) => i.approved_by).filter((v): v is string => !!v)),
  ];
  const { data: approverRows } = approverIds.length
    ? await supabase.from("profiles").select("id, full_name, email").in("id", approverIds)
    : { data: [] };
  const approverName = new Map(
    ((approverRows ?? []) as { id: string; full_name: string | null; email: string }[]).map(
      (p) => [p.id, p.full_name || p.email],
    ),
  );
  const allInitiatives: BudgetInitiative[] = rawInitiatives.map((i) => ({
    id: i.id,
    realm_id: i.realm_id,
    name: i.name,
    description: i.description,
    start_month: i.start_month,
    status: i.status,
    created_at: i.created_at,
    approved_at: i.approved_at,
    approved_by_name: i.approved_by ? (approverName.get(i.approved_by) ?? null) : null,
    lines: i.budget_initiative_lines.map((l) => ({
      account_name: l.account_name,
      classification: l.classification,
      annual_amount: Number(l.annual_amount),
    })),
  }));
  const initiatives = allInitiatives.filter((i) => realms.includes(i.realm_id));
  const approvedByRealm = (realmId: string) =>
    initiatives.filter((i) => i.realm_id === realmId && i.status === "approved");

  // Same account-name → category mapping as the Income Statement page.
  const categoryByAccount = new Map<string, string>();
  for (const a of accountRows) {
    if (!a.category) continue;
    if (company !== "all" && a.realm_id !== company) continue;
    const key = a.fully_qualified_name ?? a.name;
    if (!categoryByAccount.has(key)) categoryByAccount.set(key, a.category);
  }

  // Budget cells for every realm under a column mapping.
  const budgetCells = (toCol: MonthToCol): PivotCell[] =>
    realms.flatMap((r, idx) => [
      ...growBaselineCells(baselineByRealm[idx], assumptionByRealm.get(r), toCol),
      ...initiativeCells(approvedByRealm(r), toCol),
    ]);
  const budgetSlices = (toCol: MonthToCol): RealmRevenueSlice[] =>
    customerByRealm.map((cells, idx) =>
      growEliminationSlice(
        { realmId: realms[idx], companyName: companyByRealm.get(realms[idx]) ?? null, cells },
        assumptionByRealm.get(realms[idx]),
        toCol,
      ),
    );
  const eliminationsFor = (
    slices: RealmRevenueSlice[],
    netIncome: { cells: Record<string, number>; total: number },
  ) => {
    if (!wantEliminations) return null;
    const pivotNet: PivotTotals = {
      bycol: new Map(Object.entries(netIncome.cells)),
      total: netIncome.total,
    };
    const raw = buildEliminations(slices, pivotNet);
    return raw ? serializeEliminations(raw) : null;
  };

  // Budget view: the full-year budget laid out by the chosen columns.
  const toCol: MonthToCol = (m) => budgetColKey(year, m, colDim);
  const statement = buildCategoryStatement(budgetCells(toCol), categoryByAccount);
  const eliminations = eliminationsFor(budgetSlices(toCol), statement.netIncome);
  const colLabels = Object.fromEntries(
    statement.colKeys.map((k) => [k, budgetColLabel(colDim, k)]),
  );

  // Budget vs Actual: full-year budget, YTD budget, and YTD actual as three
  // columns of one statement, so categories, the direct-cost split, and the
  // benefits allocation line up row for row.
  let variance: {
    statement: ReturnType<typeof buildCategoryStatement>;
    eliminations: ReturnType<typeof eliminationsFor>;
  } | null = null;
  if (wantActuals) {
    const fy: MonthToCol = () => "fy";
    const ytd: MonthToCol = (m) => (m <= closedThrough ? "budget" : null);
    const cells = [
      ...budgetCells(fy),
      ...budgetCells(ytd),
      ...actualByRealm.flatMap((c) => actualCells(c, "actual", closedThrough)),
    ];
    const vStatement = buildCategoryStatement(cells, categoryByAccount);
    const slices: RealmRevenueSlice[] = [
      ...budgetSlices(fy),
      ...budgetSlices(ytd),
      ...actualCustomerByRealm.map((c, idx) => ({
        realmId: realms[idx],
        companyName: companyByRealm.get(realms[idx]) ?? null,
        cells: actualCells(c, "actual", closedThrough),
      })),
    ];
    variance = {
      statement: vStatement,
      eliminations: eliminationsFor(slices, vStatement.netIncome),
    };
  }

  // Accounts offered in the New Initiative dialog, per company.
  const accountsByRealm: Record<string, InitiativeAccount[]> = {};
  for (const a of accountRows) {
    if (!a.active) continue;
    (accountsByRealm[a.realm_id] ??= []).push({
      name: a.fully_qualified_name ?? a.name,
      classification: a.classification,
      category: a.category,
    });
  }
  for (const list of Object.values(accountsByRealm))
    list.sort((x, y) =>
      x.classification === y.classification
        ? x.name.localeCompare(y.name)
        : x.classification === "Revenue"
          ? -1
          : 1,
    );

  const proposed = initiatives.filter((i) => i.status === "proposed");
  const proposedNet = proposed.reduce((n, i) => n + initiativeTotals(i).net, 0);
  const approvedNet = initiatives
    .filter((i) => i.status === "approved")
    .reduce((n, i) => n + initiativeTotals(i).net, 0);
  const hasBaseline = baselineByRealm.some((c) => c.length > 0);
  const baselineHint = `Baseline ${monthLabel(baseline.from)} – ${monthLabel(baseline.to)}`;

  const pill = (active: boolean) =>
    `rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
      active
        ? "bg-navy-900 text-white"
        : "text-ink-600 hover:bg-surface hover:text-ink-900"
    }`;
  const filterRowCls =
    "grid grid-cols-[6rem_1fr] items-center gap-x-3 px-4 py-2";
  const pillGroup = (label: string, children: React.ReactNode) => (
    <div className={filterRowCls}>
      <span className="text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
        {label}
      </span>
      <div className="flex flex-wrap items-center divide-x divide-line/70 py-0.5">
        {children}
      </div>
    </div>
  );

  return (
    <div>
      <PageHeader
        title={`Budget ${year}`}
        subtitle={`Calendar ${year} budget built from ${monthLabel(baseline.from)} – ${monthLabel(baseline.to)} actuals, grown by each company's assumptions, plus approved new initiatives. Click a category to expand its accounts.`}
        action={
          <Link href="/financials/statement" className={buttonCls("secondary")}>
            <BookOpen size={15} strokeWidth={2} />
            Income Statement
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
          "View",
          BUDGET_VIEWS.map((v) => (
            <Link key={v.key} href={href({ view: v.key })} className={pill(view === v.key)}>
              {v.label}
            </Link>
          )),
        )}
        {view === "budget" &&
          pillGroup(
            "Columns",
            BUDGET_COL_DIMS.map((d) => (
              <Link key={d.key} href={href({ cols: d.key })} className={pill(colDim === d.key)}>
                {d.label}
              </Link>
            )),
          )}
      </div>

      <AssumptionsEditor
        budgetYear={year}
        companies={realms.map((r) => {
          const a = assumptionByRealm.get(r);
          return {
            realmId: r,
            name: companyByRealm.get(r) ?? r,
            revenueGrowthPct: a?.revenue_growth_pct ?? 0,
            expenseGrowthPct: a?.expense_growth_pct ?? 0,
          };
        })}
      />

      {hasBaseline && (
        <div
          className={`mb-4 grid gap-4 sm:grid-cols-2 ${statement.grossProfit ? "xl:grid-cols-4" : "xl:grid-cols-3"}`}
        >
          <StatTile
            label="Budgeted income"
            value={moneyWhole(statement.income.total)}
            hint={baselineHint}
          />
          {statement.grossProfit && (
            <StatTile
              label="Budgeted gross profit"
              value={moneyWhole(statement.grossProfit.total)}
              hint="Income less direct costs"
            />
          )}
          <StatTile
            label="Budgeted net income"
            value={moneyWhole((eliminations?.adjusted ?? statement.netIncome).total)}
            hint={
              approvedNet !== 0
                ? `Includes ${moneyWhole(approvedNet)} from approved initiatives`
                : eliminations
                  ? "After intercompany eliminations"
                  : "Income less all expenses"
            }
          />
          <StatTile
            label="Proposed initiatives"
            value={moneyWhole(proposedNet)}
            hint={`${proposed.length} awaiting approval — not in budget`}
          />
        </div>
      )}

      <Card pad={false}>
        {!hasBaseline ? (
          <EmptyState icon={Landmark} title="No baseline ledger data">
            The budget is built from {monthLabel(baseline.from)} –{" "}
            {monthLabel(baseline.to)} actuals. Run a QuickBooks sync in Settings
            to import the general ledger.
          </EmptyState>
        ) : view === "budget" ? (
          <StatementTable
            statement={statement}
            eliminations={eliminations}
            colLabels={colLabels}
            showRowTotal={colDim !== "total"}
          />
        ) : variance ? (
          <VarianceTable
            statement={variance.statement}
            eliminations={variance.eliminations}
            ytdLabel={`YTD ${MONTH_NAMES[closedThrough - 1]} ${year}`}
          />
        ) : (
          <EmptyState icon={Landmark} title="No actuals yet">
            Budget vs Actual starts once January {year} closes; until then the
            Budget view shows the full plan.
          </EmptyState>
        )}
      </Card>

      <InitiativesPanel
        budgetYear={year}
        initiatives={initiatives}
        companies={realms.map((r) => ({ realmId: r, name: companyByRealm.get(r) ?? r }))}
        accountsByRealm={accountsByRealm}
      />

      <p className="mt-3 text-xs text-ink-400">
        Each {year} month starts from the same calendar month of the baseline
        ({monthLabel(baseline.from)} → Jul {year}, {monthLabel(`${year - 1}-01`)}{" "}
        → Jan {year}), so seasonality carries forward. Revenue accounts grow by
        the company&rsquo;s revenue growth %, and all expense accounts —
        direct costs included — by its expense growth %. New initiatives
        spread each account&rsquo;s annual amount evenly from the start month
        through December and are folded into those accounts&rsquo; categories
        only once approved; proposed and rejected initiatives never touch the
        budget totals. Categories, the direct-cost split, the Employee Benefits
        allocation{wantEliminations ? ", and intercompany eliminations (grown by revenue growth)" : ""}{" "}
        work exactly as on the{" "}
        <Link href="/financials/statement" className="underline">
          Income Statement
        </Link>
        . Budget vs Actual compares year-to-date budget with ledger actuals
        through the last closed month; variances are shown favorable-positive.
      </p>
    </div>
  );
}
