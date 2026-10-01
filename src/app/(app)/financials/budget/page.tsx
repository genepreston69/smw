import Link from "next/link";
import { BookOpen } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchAllRows } from "@/lib/supabase/fetchAll";
import {
  eliminationLabel,
  lastDayOfMonth,
  latestMonth,
  monthLabel,
  type PivotCell,
} from "@/lib/financials";
import {
  BUDGET_COL_DIMS,
  BUDGET_VIEWS,
  BUDGET_YEAR,
  baselineRange,
  initiativeTotals,
  type BudgetAssumption,
  type BudgetColDim,
  type BudgetInitiative,
  type BudgetView,
} from "@/lib/budget";
import { PageHeader, buttonCls } from "@/components/ui";
import { BudgetWorkspace } from "./BudgetWorkspace";
import {
  InitiativesPanel,
  NewInitiativeButton,
  type InitiativeAccount,
} from "./InitiativesPanel";

// Calendar-year budget in the Income Statement's layout. Baseline = each
// account's actuals for the twelve months ending June 30 of the prior year,
// mapped month-for-month onto the budget year and grown by each company's
// revenue / expense growth assumptions. Approved new initiatives fold into
// their accounts' categories; proposed ones are listed but excluded until
// approved. The Budget vs Actual view compares year-to-date budget with
// ledger actuals once budget-year months close.

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

  // One budget_ledger_summary call per window (migration 0027): a single
  // ledger scan returning account × month and revenue customer × month cells
  // for every realm as one JSON row. Paged gl_pivot calls re-ran the whole
  // aggregation per 1000-row page, per company, and timed the page out.
  // Cells come back split per realm (in `realms` order) in gl_pivot's shape.
  const ledger = async (
    from: string,
    to: string,
    withCustomers: boolean,
  ): Promise<{ accounts: PivotCell[][]; customers: PivotCell[][] }> => {
    const { data, error } = await supabase.rpc("budget_ledger_summary", {
      p_start: `${from}-01`,
      p_end: lastDayOfMonth(to),
      p_realm_ids: realms,
      p_customers: withCustomers,
    });
    if (error) throw new Error(error.message);
    const summary = (data ?? { accounts: [], customers: [] }) as {
      accounts: [string, string, string | null, string, string, number | string][];
      customers: [string, string, string, number | string][];
    };
    const idx = new Map(realms.map((r, i) => [r, i]));
    const accounts: PivotCell[][] = realms.map(() => []);
    const customers: PivotCell[][] = realms.map(() => []);
    for (const [realm, classification, accountType, account, month, amount] of summary.accounts)
      accounts[idx.get(realm)!]?.push({
        classification,
        account_type: accountType,
        row_key: account,
        col_key: month,
        amount,
        line_count: 0,
      });
    for (const [realm, customer, month, amount] of summary.customers)
      customers[idx.get(realm)!]?.push({
        classification: "Revenue",
        account_type: null,
        row_key: customer,
        col_key: month,
        amount,
        line_count: 0,
      });
    return { accounts, customers };
  };

  const wantEliminations = company === "all";
  const wantActuals = view === "variance" && closedThrough > 0;
  const actualTo = `${year}-${String(closedThrough).padStart(2, "0")}`;
  const noLedger = { accounts: [] as PivotCell[][], customers: [] as PivotCell[][] };

  const [
    baselineLedger,
    actualLedger,
    accountRows,
    assumptionRows,
    initiativeRows,
  ] = await Promise.all([
    ledger(baseline.from, baseline.to, wantEliminations),
    wantActuals ? ledger(`${year}-01`, actualTo, wantEliminations) : noLedger,
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
  const baselineByRealm = baselineLedger.accounts;
  const customerByRealm = wantEliminations ? baselineLedger.customers : [];
  const actualByRealm = actualLedger.accounts;
  const actualCustomerByRealm = wantEliminations ? actualLedger.customers : [];

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

  // Same account-name → category mapping as the Income Statement page.
  const categoryByAccount = new Map<string, string>();
  for (const a of accountRows) {
    if (!a.category) continue;
    if (company !== "all" && a.realm_id !== company) continue;
    const key = a.fully_qualified_name ?? a.name;
    if (!categoryByAccount.has(key)) categoryByAccount.set(key, a.category);
  }

  // Only the customer cells an intercompany elimination will use cross to
  // the client — the full customer × month slice is far larger.
  const eliminationOnly = (cells: PivotCell[], realmId: string) =>
    cells.filter(
      (c) => eliminationLabel(companyByRealm.get(realmId) ?? null, c.row_key) !== null,
    );

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

      <BudgetWorkspace
        year={year}
        colDim={colDim}
        view={view}
        closedThrough={closedThrough}
        companies={realms.map((r) => ({ realmId: r, name: companyByRealm.get(r) ?? r }))}
        initialAssumptions={realms.map(
          (r) =>
            assumptionByRealm.get(r) ?? {
              realm_id: r,
              revenue_growth_pct: 0,
              expense_growth_pct: 0,
            },
        )}
        baselineByRealm={baselineByRealm}
        eliminationCellsByRealm={customerByRealm.map((cells, idx) =>
          eliminationOnly(cells, realms[idx]),
        )}
        actuals={wantActuals ? actualByRealm.flat() : null}
        actualEliminationSlices={actualCustomerByRealm.map((cells, idx) => ({
          realmId: realms[idx],
          companyName: companyByRealm.get(realms[idx]) ?? null,
          cells: eliminationOnly(cells, realms[idx]),
        }))}
        approved={initiatives.filter((i) => i.status === "approved")}
        categoryEntries={[...categoryByAccount.entries()]}
        wantEliminations={wantEliminations}
        approvedNet={approvedNet}
        proposedNet={proposedNet}
        proposedCount={proposed.length}
        baselineHint={baselineHint}
        assumptionsAction={
          <NewInitiativeButton
            budgetYear={year}
            companies={realms.map((r) => ({ realmId: r, name: companyByRealm.get(r) ?? r }))}
            accountsByRealm={accountsByRealm}
          />
        }
      />

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
