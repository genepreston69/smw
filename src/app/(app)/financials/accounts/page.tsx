import Link from "next/link";
import { BookOpen, Rows3 } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchAllRows } from "@/lib/supabase/fetchAll";
import {
  Card,
  EmptyState,
  PageHeader,
  Table,
  Th,
  buttonCls,
} from "@/components/ui";
import { CategoryEditor } from "./CategoryEditor";

// Chart of accounts imported from QuickBooks (gl_accounts), with an editable
// Category per account. Categories group Revenue/Expense accounts into the
// expandable sections of the Income Statement page (/financials/statement).

interface AccountRow {
  id: string;
  realm_id: string;
  name: string;
  fully_qualified_name: string | null;
  account_number: string | null;
  classification: string | null;
  account_type: string | null;
  account_sub_type: string | null;
  active: boolean;
  category: string | null;
}

// Statement-section display order, mirroring the Financials pivot sections.
const SECTIONS: { classification: string; label: string }[] = [
  { classification: "Revenue", label: "Income" },
  { classification: "Expense", label: "Expenses" },
  { classification: "Asset", label: "Assets" },
  { classification: "Liability", label: "Liabilities" },
  { classification: "Equity", label: "Equity" },
  { classification: "", label: "Other" },
];

const CATEGORY_LIST_ID = "account-category-options";

export default async function ChartOfAccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ company?: string; inactive?: string }>;
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
  const showInactive = sp.inactive === "1";

  const allAccounts = (await fetchAllRows((from, to) =>
    supabase
      .from("gl_accounts")
      .select(
        "id, realm_id, name, fully_qualified_name, account_number, classification, account_type, account_sub_type, active, category",
      )
      .order("fully_qualified_name")
      .order("id")
      .range(from, to),
  )) as AccountRow[];

  // Datalist across every account (all companies, inactive included) so an
  // existing category is always offered no matter the current filter.
  const categoryOptions = [
    ...new Set(allAccounts.map((a) => a.category).filter(Boolean) as string[]),
  ].sort((a, b) => a.localeCompare(b));

  const accounts = allAccounts.filter(
    (a) =>
      (company === "all" || a.realm_id === company) &&
      (showInactive || a.active),
  );
  const showCompany = companies.length > 1 && company === "all";

  const href = (overrides: Partial<{ company: string; inactive: boolean }>) => {
    const s = { company, inactive: showInactive, ...overrides };
    const params = new URLSearchParams();
    if (s.company !== "all") params.set("company", s.company);
    if (s.inactive) params.set("inactive", "1");
    const q = params.toString();
    return q ? `/financials/accounts?${q}` : "/financials/accounts";
  };

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

  const sections = SECTIONS.map((s) => ({
    ...s,
    rows: accounts
      .filter((a) => (a.classification ?? "") === s.classification)
      .sort(
        (a, b) =>
          (a.account_type ?? "").localeCompare(b.account_type ?? "") ||
          (a.fully_qualified_name ?? a.name).localeCompare(
            b.fully_qualified_name ?? b.name,
          ),
      ),
  })).filter((s) => s.rows.length > 0);

  const colSpan = 4 + (showCompany ? 1 : 0) + (showInactive ? 1 : 0);

  return (
    <div>
      <PageHeader
        title="Chart of Accounts"
        subtitle="Every account imported from QuickBooks. Assign a Category to income and expense accounts to group them on the expandable Income Statement."
        action={
          <Link href="/financials/statement" className={buttonCls("secondary")}>
            <Rows3 size={15} strokeWidth={2} />
            Income Statement
          </Link>
        }
      />

      <div className="mb-4 divide-y divide-line/70 rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(13,36,56,0.05)]">
        {companies.length > 1 && (
          <div className={filterRowCls}>
            {filterLabel("Company")}
            <div className="flex flex-wrap items-center divide-x divide-line/70 py-0.5">
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
            </div>
          </div>
        )}
        <div className={filterRowCls}>
          {filterLabel("Accounts")}
          <div className="flex flex-wrap items-center divide-x divide-line/70 py-0.5">
            <Link href={href({ inactive: false })} className={pill(!showInactive)}>
              Active only
            </Link>
            <Link href={href({ inactive: true })} className={pill(showInactive)}>
              Include inactive
            </Link>
          </div>
        </div>
      </div>

      <datalist id={CATEGORY_LIST_ID}>
        {categoryOptions.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>

      <Card pad={false}>
        {accounts.length === 0 ? (
          <EmptyState icon={BookOpen} title="No accounts imported">
            Run a QuickBooks sync in Settings to import the chart of accounts.
          </EmptyState>
        ) : (
          <Table
            head={
              <tr>
                <Th className="w-24">Number</Th>
                <Th>Account</Th>
                <Th>Type</Th>
                {showCompany && <Th>Company</Th>}
                {showInactive && <Th>Status</Th>}
                <Th>Category</Th>
              </tr>
            }
          >
            {sections.map((section) => (
              <SectionRows
                key={section.label}
                label={section.label}
                colSpan={colSpan}
                rows={section.rows}
                showCompany={showCompany}
                showInactive={showInactive}
                companyByRealm={companyByRealm}
              />
            ))}
          </Table>
        )}
      </Card>
      <p className="mt-3 text-xs text-ink-400">
        Accounts, numbers, and types come from QuickBooks and refresh on every
        general-ledger sync; Category is assigned here and survives syncs. Only
        income and expense account categories appear on the Income Statement —
        accounts left blank fall under Uncategorized there.
      </p>
    </div>
  );
}

function SectionRows({
  label,
  colSpan,
  rows,
  showCompany,
  showInactive,
  companyByRealm,
}: {
  label: string;
  colSpan: number;
  rows: AccountRow[];
  showCompany: boolean;
  showInactive: boolean;
  companyByRealm: ReadonlyMap<string, string>;
}) {
  return (
    <>
      <tr className="bg-surface/50">
        <td
          colSpan={colSpan}
          className="px-4 py-1.5 text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-ink-400"
        >
          {label}
        </td>
      </tr>
      {rows.map((a) => (
        <tr key={a.id} className="hover:bg-surface/50">
          <td className="whitespace-nowrap px-4 py-2 tabular-nums text-ink-600">
            {a.account_number ?? "—"}
          </td>
          <td className="px-4 py-2 text-ink-900">
            {a.fully_qualified_name ?? a.name}
          </td>
          <td className="whitespace-nowrap px-4 py-2 text-ink-600">
            {a.account_type ?? "—"}
            {a.account_sub_type && (
              <span className="text-ink-400"> · {a.account_sub_type}</span>
            )}
          </td>
          {showCompany && (
            <td className="whitespace-nowrap px-4 py-2 text-ink-600">
              {companyByRealm.get(a.realm_id) ?? a.realm_id}
            </td>
          )}
          {showInactive && (
            <td className="whitespace-nowrap px-4 py-2">
              {a.active ? (
                <span className="text-ink-600">Active</span>
              ) : (
                <span className="rounded border border-zinc-200 bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-700">
                  Inactive
                </span>
              )}
            </td>
          )}
          <td className="px-4 py-1.5">
            <CategoryEditor
              accountId={a.id}
              category={a.category}
              listId={CATEGORY_LIST_ID}
            />
          </td>
        </tr>
      ))}
    </>
  );
}
