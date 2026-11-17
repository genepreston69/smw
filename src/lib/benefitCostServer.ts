import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/supabase/fetchAll";
import {
  MONTH_PARAM,
  clampMonth,
  defaultFrom,
  lastDayOfMonth,
  latestMonth,
} from "@/lib/financials";
import { NO_CLASS, sortClasses } from "@/lib/budget";
import type { BenefitBaseAccount } from "@/lib/appSettings";
import {
  benefitCostByClass,
  benefitLineFor,
  buildBenefitCost,
  type BenefitCell,
  type BenefitClassRow,
  type BenefitCost,
  type BenefitCostState,
} from "@/lib/benefitCost";

// Ledger read for /financials/benefits. Callers verify the admin role first
// and pass the service-role client (same access pattern as every Financials
// read). The ledger comes through budget_ledger_summary — one org-scoped,
// index-range-scanned JSON row of account × month cells — exactly as the
// Income Statement reads it, so every line here ties to that statement.

/** Page/export params → state; anything invalid falls back to the defaults.
    The page and the export share this, so the file matches the screen. */
export function benefitCostState(
  get: (key: string) => string | null | undefined,
  validRealms: ReadonlySet<string>,
): BenefitCostState {
  const company = get("company");
  const rawFrom = get("from") ?? "";
  const rawTo = get("to") ?? "";
  const cls = (get("class") ?? "").trim();
  // The in-progress month is omitted app-wide: params are clamped to the
  // last complete month.
  let from = MONTH_PARAM.test(rawFrom) ? clampMonth(rawFrom) : defaultFrom();
  let to = MONTH_PARAM.test(rawTo) ? clampMonth(rawTo) : latestMonth();
  if (from > to) [from, to] = [to, from];
  return {
    company: company && validRealms.has(company) ? company : "all",
    from,
    to,
    cls: cls && cls !== "all" && cls.length <= 200 ? cls : null,
  };
}

export interface LoadedBenefitCost {
  /** The class in view (or All classes). */
  cost: BenefitCost;
  /** Every class with benefits or labor in the selection, sorted (NO_CLASS last). */
  classes: string[];
  /** Period totals for each of those classes; they sum to All classes. */
  byClass: BenefitClassRow[];
  /** All classes' period totals — the By class table's total row. */
  allClasses: BenefitCost;
  /** Any one class's by-month view, from the same single ledger read. */
  costOf: (cls: string) => BenefitCost;
}

export async function loadBenefitCost(
  db: SupabaseClient,
  state: BenefitCostState,
  /** Every connected company, in display order. */
  allRealms: string[],
  /** The denominator's accounts (settings.benefitBaseAccounts). */
  bases: BenefitBaseAccount[],
): Promise<LoadedBenefitCost> {
  const { company, from, to, cls } = state;
  const realms = company === "all" ? allRealms : [company];
  if (realms.length === 0) {
    const empty = buildBenefitCost([], bases);
    return { cost: empty, classes: [], byClass: [], allClasses: empty, costOf: () => empty };
  }

  const [summaryRes, accountRows] = await Promise.all([
    db.rpc("budget_ledger_summary", {
      p_start: `${from}-01`,
      p_end: lastDayOfMonth(to),
      p_realm_ids: realms,
      p_customers: false,
    }),
    fetchAllRows((fromRow, toRow) =>
      db
        .from("gl_accounts")
        .select("realm_id, name, fully_qualified_name, category")
        .eq("classification", "Expense")
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
  if (summaryRes.error) throw new Error(summaryRes.error.message);
  const summary = (summaryRes.data ?? { accounts: [] }) as {
    accounts: [string, string, string | null, string, string, number | string, string?][];
  };

  // Categories are looked up in each company's own chart, so an account
  // categorized Employee Benefits in one company doesn't pull in a
  // same-named account from another.
  const categoryOf = new Map<string, string>();
  for (const a of accountRows) {
    if (a.category) {
      categoryOf.set(`${a.realm_id}\u0000${a.fully_qualified_name ?? a.name}`, a.category);
    }
  }

  const cells: BenefitCell[] = [];
  for (const [realm, classification, , account, month, amount, rawCls] of summary.accounts) {
    if (classification !== "Expense") continue;
    const line = benefitLineFor(account, categoryOf.get(`${realm}\u0000${account}`), bases);
    const value = Number(amount) || 0;
    if (line && value !== 0) {
      cells.push({ line, account, month, amount: value, cls: rawCls || NO_CLASS });
    }
  }

  const classes = sortClasses(new Set(cells.map((c) => c.cls)));
  const allClasses = buildBenefitCost(cells, bases);
  const costOf = (one: string) => buildBenefitCost(cells.filter((c) => c.cls === one), bases);
  return {
    cost: cls === null ? allClasses : costOf(cls),
    classes,
    byClass: benefitCostByClass(cells, classes, bases),
    allClasses,
    costOf,
  };
}
