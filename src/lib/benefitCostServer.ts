import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/supabase/fetchAll";
import { lastDayOfMonth } from "@/lib/financials";
import {
  benefitLineFor,
  buildBenefitCost,
  type BenefitCell,
  type BenefitCost,
} from "@/lib/benefitCost";

// Ledger read for /financials/benefits. Callers verify the admin role first
// and pass the service-role client (same access pattern as every Financials
// read). The ledger comes through budget_ledger_summary — one org-scoped,
// index-range-scanned JSON row of account × month cells — exactly as the
// Income Statement reads it, so every line here ties to that statement.

export async function loadBenefitCost(
  db: SupabaseClient,
  /** Realm ids in view (one company, or all of them). */
  realms: string[],
  from: string, // YYYY-MM
  to: string, // YYYY-MM
): Promise<BenefitCost> {
  if (realms.length === 0) return buildBenefitCost([]);

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
  for (const [realm, classification, , account, month, amount] of summary.accounts) {
    if (classification !== "Expense") continue;
    const line = benefitLineFor(account, categoryOf.get(`${realm}\u0000${account}`));
    if (line) cells.push({ line, account, month, amount: Number(amount) || 0 });
  }
  return buildBenefitCost(cells);
}
