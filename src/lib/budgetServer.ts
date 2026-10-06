import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/supabase/fetchAll";
import { lastDayOfMonth, latestMonth } from "@/lib/financials";
import {
  NO_CLASS,
  baselineRange,
  closedMonthsOf,
  emptyCategoryGrowth,
  sortClasses,
  type BudgetAssumption,
  type BudgetCell,
  type BudgetInitiative,
  type BudgetOverride,
  type BudgetView,
} from "@/lib/budget";

// Budget data loading shared by /financials/budget and its Excel export
// (/api/export/budget), so both read exactly the same inputs. Callers verify
// the admin role first and pass the service-role client (same access pattern
// as every Financials read — see migrations 0014/0015).

export interface BudgetAccount {
  realm_id: string;
  name: string;
  fully_qualified_name: string | null;
  classification: "Revenue" | "Expense";
  category: string | null;
  active: boolean;
}

export interface LoadedBudget {
  year: number;
  /** Budget-year months already closed (0 = none). */
  closedThrough: number;
  realms: string[];
  /** True when YTD actuals were loaded (variance view with a closed month). */
  wantActuals: boolean;
  /** Baseline account × month × class cells per realm (realms order). */
  baselineByRealm: BudgetCell[][];
  /** YTD actual account × class cells, all realms, or null when not loaded. */
  actuals: BudgetCell[] | null;
  /** The same YTD actual cells split per realm (realms order), or null. */
  actualsByRealm: BudgetCell[][] | null;
  accountRows: BudgetAccount[];
  /** Saved assumptions per realm, category rates included (missing realms
      default to 0%). */
  assumptions: BudgetAssumption[];
  /** Initiatives for the selected realms, every status. */
  initiatives: BudgetInitiative[];
  /** Account × class months typed over for the selected realms (migrations
      0031, 0034). */
  overrides: BudgetOverride[];
  /** Each realm's budget classes — every class with baseline or YTD actual
      activity, an initiative, or a typed figure — sorted, NO_CLASS last. */
  classesByRealm: Record<string, string[]>;
  /** Account → category for the statement's rows (first realm wins on All
      companies, as on the Income Statement). */
  categoryByAccount: Map<string, string>;
  /** Each realm's own account → category map (realms order); growth rates
      and the per-company export tabs use these. */
  realmCategories: Map<string, string>[];
}

export async function loadBudget(
  db: SupabaseClient,
  opts: {
    year: number;
    company: string; // realm id or "all"
    realms: string[];
    view: BudgetView;
  },
): Promise<LoadedBudget> {
  const { year, company, realms, view } = opts;
  const baseline = baselineRange(year);
  const closedThrough = closedMonthsOf(year, latestMonth());

  // One budget_ledger_summary call per window (migration 0027): a single
  // ledger scan returning account × month × class cells (migration 0034) for
  // every realm as one JSON row. Paged gl_pivot calls re-ran the whole
  // aggregation per 1000-row page, per company, and timed the page out.
  // Cells come back split per realm (in `realms` order) in gl_pivot's shape.
  const ledger = async (from: string, to: string): Promise<BudgetCell[][]> => {
    const { data, error } = await db.rpc("budget_ledger_summary", {
      p_start: `${from}-01`,
      p_end: lastDayOfMonth(to),
      p_realm_ids: realms,
      p_customers: false,
    });
    if (error) throw new Error(error.message);
    const summary = (data ?? { accounts: [] }) as {
      accounts: [string, string, string | null, string, string, number | string, string?][];
    };
    const idx = new Map(realms.map((r, i) => [r, i]));
    const accounts: BudgetCell[][] = realms.map(() => []);
    for (const [realm, classification, accountType, account, month, amount, cls] of summary.accounts)
      accounts[idx.get(realm)!]?.push({
        classification,
        account_type: accountType,
        row_key: account,
        col_key: month,
        amount,
        line_count: 0,
        class_name: cls || NO_CLASS,
      });
    return accounts;
  };

  const wantActuals = view === "variance" && closedThrough > 0;
  const actualTo = `${year}-${String(closedThrough).padStart(2, "0")}`;

  const [
    baselineLedger,
    actualLedger,
    accountRows,
    assumptionRows,
    categoryRateRows,
    initiatives,
    overrideRows,
  ] = await Promise.all([
      ledger(baseline.from, baseline.to),
      wantActuals ? ledger(`${year}-01`, actualTo) : null,
      fetchAllRows((fromRow, toRow) =>
        db
          .from("gl_accounts")
          .select("realm_id, name, fully_qualified_name, classification, category, active")
          .in("classification", ["Revenue", "Expense"])
          .order("id")
          .range(fromRow, toRow),
      ) as Promise<BudgetAccount[]>,
      db
        .from("budget_assumptions")
        .select("realm_id, revenue_growth_pct, expense_growth_pct")
        .eq("budget_year", year),
      fetchAllRows((fromRow, toRow) =>
        db
          .from("budget_category_assumptions")
          .select("realm_id, classification, category, growth_pct")
          .eq("budget_year", year)
          .order("realm_id")
          .order("classification")
          .order("category")
          .range(fromRow, toRow),
      ) as Promise<
        {
          realm_id: string;
          classification: "Revenue" | "Expense";
          category: string;
          growth_pct: number | string;
        }[]
      >,
      loadInitiatives(db, year, realms),
      fetchAllRows((fromRow, toRow) =>
        db
          .from("budget_account_overrides")
          .select("realm_id, account, class_name, classification, month, amount")
          .eq("budget_year", year)
          .in("realm_id", realms)
          .order("realm_id")
          .order("account")
          .order("class_name")
          .order("month")
          .range(fromRow, toRow),
      ) as Promise<(Omit<BudgetOverride, "amount"> & { amount: number | string })[]>,
    ]);

  type AssumptionRow = { realm_id: string; revenue_growth_pct: number | string; expense_growth_pct: number | string };
  const saved = new Map(
    ((assumptionRows.data ?? []) as AssumptionRow[]).map((a) => [a.realm_id, a]),
  );
  const assumptions: BudgetAssumption[] = realms.map((r) => {
    const category_growth = emptyCategoryGrowth();
    for (const c of categoryRateRows)
      if (c.realm_id === r) category_growth[c.classification][c.category] = Number(c.growth_pct);
    return {
      realm_id: r,
      revenue_growth_pct: Number(saved.get(r)?.revenue_growth_pct ?? 0),
      expense_growth_pct: Number(saved.get(r)?.expense_growth_pct ?? 0),
      category_growth,
    };
  });

  // Same account-name → category mapping as the Income Statement page.
  const categoryByAccount = new Map<string, string>();
  const realmIdx = new Map(realms.map((r, i) => [r, i]));
  const realmCategories = realms.map(() => new Map<string, string>());
  for (const a of accountRows) {
    if (!a.category) continue;
    const key = a.fully_qualified_name ?? a.name;
    const own = realmCategories[realmIdx.get(a.realm_id) ?? -1];
    if (own && !own.has(key)) own.set(key, a.category);
    if (company !== "all" && a.realm_id !== company) continue;
    if (!categoryByAccount.has(key)) categoryByAccount.set(key, a.category);
  }

  const overrides = overrideRows.map((o) => ({ ...o, amount: Number(o.amount) }));
  const classesByRealm: Record<string, string[]> = Object.fromEntries(
    realms.map((r, i) => [
      r,
      sortClasses([
        ...baselineLedger[i].map((c) => c.class_name),
        ...(actualLedger?.[i] ?? []).map((c) => c.class_name),
        ...initiatives.filter((x) => x.realm_id === r).map((x) => x.class_name),
        ...overrides.filter((o) => o.realm_id === r).map((o) => o.class_name),
      ]),
    ]),
  );

  return {
    year,
    closedThrough,
    realms,
    wantActuals,
    baselineByRealm: baselineLedger,
    actuals: actualLedger ? actualLedger.flat() : null,
    actualsByRealm: actualLedger,
    accountRows,
    assumptions,
    initiatives,
    overrides,
    classesByRealm,
    categoryByAccount,
    realmCategories,
  };
}

/**
 * A budget year's initiatives for the given realms, every status, with their
 * account lines and approver names. Shared by loadBudget and the initiatives
 * export (/api/export/budget-initiatives), which needs no ledger read.
 */
export async function loadInitiatives(
  db: SupabaseClient,
  year: number,
  realms: readonly string[],
): Promise<BudgetInitiative[]> {
  const { data, error } = await db
    .from("budget_initiatives")
    .select(
      "id, realm_id, class_name, name, description, start_month, end_month, status, created_at, approved_at, approved_by, budget_initiative_lines (account_name, classification, annual_amount)",
    )
    .eq("budget_year", year)
    .order("created_at");
  if (error) throw new Error(error.message);

  type InitiativeRow = Omit<BudgetInitiative, "lines" | "approved_by_name"> & {
    approved_by: string | null;
    budget_initiative_lines: {
      account_name: string;
      classification: "Revenue" | "Expense";
      annual_amount: number | string;
    }[];
  };
  const rawInitiatives = ((data ?? []) as InitiativeRow[]).filter((i) =>
    realms.includes(i.realm_id),
  );
  const approverIds = [
    ...new Set(rawInitiatives.map((i) => i.approved_by).filter((v): v is string => !!v)),
  ];
  const { data: approverRows } = approverIds.length
    ? await db.from("profiles").select("id, full_name, email").in("id", approverIds)
    : { data: [] };
  const approverName = new Map(
    ((approverRows ?? []) as { id: string; full_name: string | null; email: string }[]).map(
      (p) => [p.id, p.full_name || p.email],
    ),
  );
  return rawInitiatives.map((i) => ({
    id: i.id,
    realm_id: i.realm_id,
    class_name: i.class_name || NO_CLASS,
    name: i.name,
    description: i.description,
    start_month: i.start_month,
    end_month: i.end_month,
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
}
