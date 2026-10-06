import Link from "next/link";
import { BookOpen, HelpCircle } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/service";
import { monthLabel } from "@/lib/financials";
import {
  BUDGET_COL_DIMS,
  BUDGET_VIEWS,
  BUDGET_YEAR,
  NO_CLASS,
  baselineRange,
  growthCategories,
  inBudgetClass,
  initiativeTotals,
  sortClasses,
  type BudgetClass,
  type BudgetColDim,
  type BudgetView,
} from "@/lib/budget";
import { loadBudget } from "@/lib/budgetServer";
import { buttonCls } from "@/components/ui";
import { BudgetWorkspace } from "./BudgetWorkspace";
import {
  InitiativesPanel,
  NewInitiativeButton,
  type InitiativeAccount,
} from "./InitiativesPanel";

// Calendar-year budget in the Income Statement's layout. Baseline = each
// account's actuals for the twelve months ending June 30 of the prior year,
// mapped month-for-month onto the budget year and grown by each company's
// growth assumptions — a rate per category, falling back to the company's
// revenue / expense default. Approved new initiatives fold into
// their accounts' categories; proposed ones are listed but excluded until
// approved. The Budget vs Actual view compares year-to-date budget with
// ledger actuals once budget-year months close.
//
// The budget is built per QuickBooks class (migration 0034): the Class filter
// shows one class's budget; All classes is the company roll-up (the sum of
// its classes), and All companies the consolidation of the companies.

export default async function BudgetPage({
  searchParams,
}: {
  searchParams: Promise<{ company?: string; cols?: string; view?: string; class?: string }>;
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

  const data = await loadBudget(supabase, { year, company, realms, view });
  const { accountRows } = data;

  // Classes in view: every class any selected company budgets. A class the
  // selection doesn't have (e.g. after switching company) falls back to All
  // classes.
  const classes = sortClasses(realms.flatMap((r) => data.classesByRealm[r] ?? []));
  const cls: BudgetClass =
    sp.class !== undefined && classes.includes(sp.class) ? sp.class : null;
  const keep = inBudgetClass(cls);
  const initiatives = data.initiatives.filter(keep);

  const href = (
    overrides: Partial<{
      company: string;
      cols: BudgetColDim;
      view: BudgetView;
      cls: BudgetClass;
    }>,
  ) => {
    const s = { company, cols: colDim, view, cls, ...overrides };
    const params = new URLSearchParams();
    if (s.company !== "all") params.set("company", s.company);
    if (s.cls !== null) params.set("class", s.cls);
    if (s.cols !== "month") params.set("cols", s.cols);
    if (s.view !== "budget") params.set("view", s.view);
    const q = params.toString();
    return q ? `/financials/budget?${q}` : "/financials/budget";
  };

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

  const filters = (
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
        {classes.some((c) => c !== NO_CLASS) &&
          pillGroup(
            "Class",
            <>
              <Link href={href({ cls: null })} className={pill(cls === null)}>
                All classes
              </Link>
              {classes.map((c) => (
                <Link key={c} href={href({ cls: c })} className={pill(cls === c)}>
                  {c}
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
  );

  return (
    <div>
      <BudgetWorkspace
        title={cls === null ? `Budget ${year}` : `Budget ${year} — ${cls}`}
        subtitle={`Calendar ${year} budget built from ${monthLabel(baseline.from)} – ${monthLabel(baseline.to)} actuals by QuickBooks class, grown by each company's assumptions, plus approved new initiatives — classes roll up to each company, and companies to the consolidated budget. Click a category to expand its accounts; with one company and one class selected, click an account's month or Total to type a figure over it.`}
        headerLinks={
          <>
            <Link href="/financials/statement" className={buttonCls("secondary")}>
              <BookOpen size={15} strokeWidth={2} />
              Income Statement
            </Link>
            <Link
              href="/financials/budget/manual"
              title="Printable user manual for the Budget module"
              className={buttonCls("secondary")}
            >
              <HelpCircle size={15} strokeWidth={2} />
              User manual
            </Link>
          </>
        }
        filters={filters}
        company={company}
        cls={cls}
        classes={classes}
        classesByRealm={data.classesByRealm}
        year={year}
        colDim={colDim}
        view={view}
        closedThrough={data.closedThrough}
        companies={realms.map((r) => ({ realmId: r, name: companyByRealm.get(r) ?? r }))}
        initialAssumptions={data.assumptions}
        // Only the selected class's inputs cross to the browser.
        initialOverrides={data.overrides.filter(keep)}
        baselineByRealm={data.baselineByRealm.map((cells) => cells.filter(keep))}
        actuals={data.actuals?.filter(keep) ?? null}
        approved={initiatives.filter((i) => i.status === "approved")}
        categoryEntries={[...data.categoryByAccount.entries()]}
        realmCategoryEntries={data.realmCategories.map((m) => [...m.entries()])}
        growthCategories={growthCategories(accountRows, realms)}
        approvedNet={approvedNet}
        proposedNet={proposedNet}
        proposedCount={proposed.length}
        baselineHint={baselineHint}
        assumptionsAction={
          <NewInitiativeButton
            budgetYear={year}
            companies={realms.map((r) => ({ realmId: r, name: companyByRealm.get(r) ?? r }))}
            accountsByRealm={accountsByRealm}
            classesByRealm={data.classesByRealm}
            defaultClass={cls}
          />
        }
      />

      <InitiativesPanel
        budgetYear={year}
        company={company}
        cls={cls}
        showClass={classes.some((c) => c !== NO_CLASS)}
        initiatives={initiatives}
        companies={realms.map((r) => ({ realmId: r, name: companyByRealm.get(r) ?? r }))}
        accountsByRealm={accountsByRealm}
        classesByRealm={data.classesByRealm}
      />

      <p className="mt-3 text-xs text-ink-400">
        Each {year} month starts from the same calendar month of the baseline
        ({monthLabel(baseline.from)} → Jul {year}, {monthLabel(`${year - 1}-01`)}{" "}
        → Jan {year}), so seasonality carries forward. Each account grows at
        its category&rsquo;s rate for its company; a category left blank, and
        any uncategorized account, grows at the company&rsquo;s revenue or
        expense default. New initiatives
        spread each account&rsquo;s amount evenly from their start month
        through their end month and are folded into those accounts&rsquo; categories
        only once approved; proposed and rejected initiatives never touch the
        budget totals. Every baseline amount, typed figure, and initiative
        belongs to one QuickBooks class (lines with none are{" "}
        &ldquo;{NO_CLASS}&rdquo;): a company&rsquo;s budget is the sum of its
        classes and All companies the sum of the companies; growth rates are
        per company and apply to every class. Categories and the direct-cost
        split work exactly as on the{" "}
        <Link href="/financials/statement" className="underline">
          Income Statement
        </Link>
        . Budget vs Actual compares year-to-date budget with ledger actuals
        through the last closed month; variances are shown favorable-positive.
      </p>
    </div>
  );
}
