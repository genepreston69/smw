import Link from "next/link";
import { BookOpen, Download, HeartPulse } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/service";
import { moneyWhole, pct } from "@/lib/format";
import { latestMonth, monthLabel } from "@/lib/financials";
import { NO_CLASS } from "@/lib/budget";
import {
  BENEFITS_CATEGORY,
  LABOR_BASE_ACCOUNTS,
  benefitCostExportHref,
  benefitCostHref,
  type BenefitCostState,
  type BenefitLine,
  type BenefitTotals,
} from "@/lib/benefitCost";
import {
  benefitCostState,
  loadBenefitCost,
  type LoadedBenefitCost,
} from "@/lib/benefitCostServer";
import { ClassSelect } from "../statement/ClassSelect";
import {
  Card,
  EmptyState,
  PageHeader,
  StatTile,
  Table,
  Th,
  buttonCls,
} from "@/components/ui";

// Cost of Benefits: Employee Benefits (by Chart of Accounts category) as a
// percent of labor — 710 Labor Cost + 935 Salaries & Wages + 934 Labor Maint —
// by month, straight from the general ledger as booked, for one QuickBooks
// class at a time (default All classes) with a By class comparison. The math
// lives in src/lib/benefitCost.ts; the Excel export shares the same loader.

export default async function CostOfBenefitsPage({
  searchParams,
}: {
  searchParams: Promise<{ company?: string; from?: string; to?: string; class?: string }>;
}) {
  const sp = await searchParams;
  // GL data is admin-only; same access pattern as /financials — requireAdmin()
  // verifies the caller, then reads go through the service-role client.
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
  const realmIds = companies.map((c) => c.realm_id);

  const state = benefitCostState((k) => sp[k as keyof typeof sp], new Set(realmIds));
  const { company, from, to, cls } = state;
  const maxMonth = latestMonth();
  const href = (overrides: Partial<BenefitCostState>) =>
    benefitCostHref({ ...state, ...overrides });

  let loaded: LoadedBenefitCost | null = null;
  let loadError: string | null = null;
  try {
    loaded = await loadBenefitCost(supabase, state, realmIds);
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e);
  }
  const data = loaded?.cost ?? null;
  const byClass = loaded?.byClass ?? [];
  const all = loaded?.allClasses;

  // The class in view stays listed even when it has no activity in this
  // period or company, so the dropdown always shows what's selected.
  const classes = [...(loaded?.classes ?? [])];
  if (cls !== null && !classes.includes(cls)) classes.push(cls);
  const classLabel = (c: string) => (c === NO_CLASS ? "No class assigned" : c);
  const classOptions = [
    { value: "all", label: "All classes", href: href({ cls: null }) },
    ...classes.map((c) => ({ value: c, label: classLabel(c), href: href({ cls: c }) })),
  ];
  const hasData =
    !!data && (data.benefits.accounts.length > 0 || data.labor.some((l) => l.accounts.length > 0));
  const colKeys = data?.colKeys ?? [];
  const periodHint = `${monthLabel(from)} – ${monthLabel(to)}${
    cls !== null ? ` · ${classLabel(cls)}` : ""
  }`;
  const formula = `${BENEFITS_CATEGORY} ÷ (${LABOR_BASE_ACCOUNTS.map((a) => a.label).join(" + ")})`;

  const dash = <span className="text-ink-400">—</span>;
  const moneyCell = (key: string, v: number, strong: boolean, small = false) => (
    <td
      key={key}
      className={`whitespace-nowrap px-4 text-right tabular-nums ${
        small ? "py-1.5 text-[0.8rem]" : "py-2"
      } ${strong ? "font-semibold" : ""} ${
        v < 0 ? "text-bad-600" : small ? "text-ink-600" : "text-ink-900"
      }`}
    >
      {v === 0 ? dash : moneyWhole(v)}
    </td>
  );
  const totalsRow = (label: string, t: BenefitTotals, strong: boolean) => (
    <tr className={strong ? "bg-surface" : "hover:bg-surface/50"}>
      <td className={`px-4 py-2 text-ink-900 ${strong ? "font-semibold" : "font-medium"}`}>
        {label}
      </td>
      {colKeys.map((k) => moneyCell(k, t.cells[k] ?? 0, strong))}
      {moneyCell("total", t.total, true)}
    </tr>
  );
  // A line and, when it is more than one account (or the account's name
  // differs from the line's label), the accounts behind it.
  const lineRows = (line: BenefitLine) => {
    const showAccounts =
      line.accounts.length > 1 ||
      (line.accounts.length === 1 && line.accounts[0].name !== line.label);
    return (
      <>
        {totalsRow(line.label, line, false)}
        {showAccounts &&
          line.accounts.map((a) => (
            <tr key={`${line.key}:${a.name}`} className="hover:bg-surface/50">
              <td className="px-4 py-1.5 pl-8 text-[0.8rem] text-ink-600">{a.name}</td>
              {colKeys.map((k) => moneyCell(k, a.cells[k] ?? 0, false, true))}
              {moneyCell("total", a.total, false, true)}
            </tr>
          ))}
      </>
    );
  };
  const rateCell = (key: string, r: number | null) => (
    <td
      key={key}
      className={`whitespace-nowrap px-4 py-2 text-right font-semibold tabular-nums ${
        r !== null && r < 0 ? "text-bad-600" : "text-ink-900"
      }`}
    >
      {r === null ? dash : pct(r)}
    </td>
  );

  const pill = (active: boolean) =>
    `rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
      active
        ? "bg-navy-900 text-white"
        : "text-ink-600 hover:bg-surface hover:text-ink-900"
    }`;
  const filterRowCls = "grid grid-cols-[6rem_1fr] items-center gap-x-3 px-4 py-2";
  const filterLabel = (label: string) => (
    <span className="text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
      {label}
    </span>
  );

  return (
    <div>
      <PageHeader
        title="Cost of Benefits"
        subtitle={`What employee benefits cost per dollar of labor: ${formula}.`}
        action={
          <div className="flex items-center gap-2">
            <a href={benefitCostExportHref(state)} className={buttonCls("secondary")}>
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
          {filterLabel("Class")}
          <div className="flex flex-wrap items-center gap-3 py-0.5">
            <ClassSelect value={cls ?? "all"} options={classOptions} />
            <span className="text-xs text-ink-400">
              {cls === null
                ? "Every class combined. Pick a class to see its own rate."
                : "This class only. All classes is the sum of every class."}
            </span>
          </div>
        </div>
        <form method="get" action="/financials/benefits" className={filterRowCls}>
          {filterLabel("Period")}
          {company !== "all" && <input type="hidden" name="company" value={company} />}
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

      {data && hasData && (
        <div className="mb-4 grid gap-4 sm:grid-cols-3">
          <StatTile
            label="Benefit rate"
            value={data.rate.total === null ? "—" : pct(data.rate.total)}
            hint="Benefits per dollar of labor"
          />
          <StatTile
            label="Employee benefits"
            value={moneyWhole(data.benefits.total)}
            hint={periodHint}
          />
          <StatTile
            label="Labor"
            value={moneyWhole(data.laborTotal.total)}
            hint="710 + 935 + 934"
          />
        </div>
      )}

      {!loadError && (
        <Card pad={false}>
          {!data || !hasData ? (
            <EmptyState icon={HeartPulse} title="No benefits or labor activity for this selection">
              Assign the {BENEFITS_CATEGORY} category on the Chart of Accounts
              page, run a QuickBooks sync in Settings, or widen the period.
            </EmptyState>
          ) : (
            <Table
              head={
                <tr>
                  <Th>Line</Th>
                  {colKeys.map((k) => (
                    <Th key={k} right>
                      {monthLabel(k)}
                    </Th>
                  ))}
                  <Th right>Total</Th>
                </tr>
              }
            >
              {lineRows(data.benefits)}
              {data.labor.map((l) => (
                <LineFragment key={l.key}>{lineRows(l)}</LineFragment>
              ))}
              {totalsRow("Total labor", data.laborTotal, true)}
              <tr className="bg-brand-50/40">
                <td className="px-4 py-2 font-semibold text-ink-900">Benefit rate</td>
                {colKeys.map((k) => rateCell(k, data.rate.cells[k] ?? null))}
                {rateCell("total", data.rate.total)}
              </tr>
            </Table>
          )}
        </Card>
      )}

      {all && byClass.length > 0 && (
        <div className="mt-4">
          <Card pad={false}>
            <div className="border-b border-line/70 px-4 py-3">
              <p className="text-sm font-semibold text-ink-900">By class</p>
              <p className="text-xs text-ink-600">
                {monthLabel(from)} – {monthLabel(to)}. Pick a class to see it by month.
              </p>
            </div>
            <Table
              head={
                <tr>
                  <Th>Class</Th>
                  <Th right>{BENEFITS_CATEGORY}</Th>
                  {LABOR_BASE_ACCOUNTS.map((a) => (
                    <Th key={a.number} right>
                      {a.label}
                    </Th>
                  ))}
                  <Th right>Total labor</Th>
                  <Th right>Benefit rate</Th>
                </tr>
              }
            >
              {byClass.map((r) => (
                <tr
                  key={r.cls}
                  className={r.cls === cls ? "bg-brand-50/40" : "hover:bg-surface/50"}
                >
                  <td className="px-4 py-2">
                    <Link
                      href={href({ cls: r.cls })}
                      className="font-medium text-brand-700 hover:underline"
                    >
                      {classLabel(r.cls)}
                    </Link>
                  </td>
                  {moneyCell("b", r.benefits, false)}
                  {LABOR_BASE_ACCOUNTS.map((a) =>
                    moneyCell(a.number, r.labor[a.number] ?? 0, false),
                  )}
                  {moneyCell("l", r.laborTotal, false)}
                  {rateCell("r", r.rate)}
                </tr>
              ))}
              <tr className="bg-surface">
                <td className="px-4 py-2 font-semibold text-ink-900">
                  <Link href={href({ cls: null })} className="hover:underline">
                    All classes
                  </Link>
                </td>
                {moneyCell("b", all.benefits.total, true)}
                {all.labor.map((l) => moneyCell(l.key, l.total, true))}
                {moneyCell("l", all.laborTotal.total, true)}
                {rateCell("r", all.rate.total)}
              </tr>
            </Table>
          </Card>
        </div>
      )}

      <p className="mt-3 text-xs text-ink-400">
        Benefit rate = {formula}. {BENEFITS_CATEGORY} is every expense account
        assigned that category on the Chart of Accounts page. The labor
        accounts are found by account number, so sub-accounts of 710, 935, and
        934 count with their parent; an account categorized {BENEFITS_CATEGORY}{" "}
        is never also counted as labor. Amounts are the general ledger as
        booked, so each line ties to the Income Statement. The Total column
        divides the period&rsquo;s benefits by the period&rsquo;s labor (it is
        not an average of the monthly rates), and months with no labor show a
        dash. Classes are QuickBooks classes as booked on each ledger line:
        a class&rsquo;s rate is its own benefits over its own labor, so a
        class whose benefits are booked without a class (or to another class)
        will read low, and the classes always add up to All classes.
      </p>
    </div>
  );
}

function LineFragment({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
