import Link from "next/link";
import { ClipboardList, Plus, Stamp, Users } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { money, shortDate } from "@/lib/format";
import { StatusBadge } from "@/components/StatusBadge";
import {
  Card,
  CardTitle,
  EmptyState,
  PageHeader,
  StatTile,
  Table,
  Th,
  buttonCls,
} from "@/components/ui";
import type { PlanStatus } from "@/lib/types";

export default async function DashboardPage() {
  const { supabase, profile } = await requireUser();

  const [plansRes, submittedRes, activeRes, customersRes] = await Promise.all([
    supabase
      .from("project_plans")
      .select("id, title, status, updated_at, customer:customers(display_name)")
      .order("updated_at", { ascending: false })
      .limit(8),
    supabase
      .from("project_plans")
      .select("id", { count: "exact", head: true })
      .eq("status", "submitted"),
    supabase
      .from("project_plans")
      .select("id", { count: "exact", head: true })
      .in("status", ["draft", "changes_requested"]),
    supabase.from("customers").select("id", { count: "exact", head: true }),
  ]);

  const plans = (plansRes.data ?? []) as unknown as Array<{
    id: string;
    title: string;
    status: PlanStatus;
    updated_at: string;
    customer: { display_name: string } | null;
  }>;

  const planIds = plans.map((p) => p.id);
  const { data: totalsRows } = planIds.length
    ? await supabase
        .from("plan_totals")
        .select("plan_id, total_price")
        .in("plan_id", planIds)
    : { data: [] };
  const totals = new Map(
    (totalsRows ?? []).map((t) => [t.plan_id as string, Number(t.total_price)]),
  );

  const firstName =
    (profile.full_name || profile.email || "").split(/[\s@]/)[0] || "there";

  return (
    <div>
      <PageHeader
        title={`Welcome back, ${firstName}`}
        subtitle="Here's where your job plans stand."
        action={
          <Link href="/plans/new" className={buttonCls("primary")}>
            <Plus size={16} strokeWidth={2} />
            New job plan
          </Link>
        }
      />

      <div className="mb-8 grid gap-4 sm:grid-cols-3">
        <StatTile
          label="Awaiting approval"
          value={submittedRes.count ?? 0}
          hint="Open the review queue"
          href="/approvals"
          icon={Stamp}
        />
        <StatTile
          label="In progress"
          value={activeRes.count ?? 0}
          hint="Drafts & changes requested"
          href="/plans"
          icon={ClipboardList}
        />
        <StatTile
          label="Customers"
          value={customersRes.count ?? 0}
          hint="Synced from QuickBooks"
          href="/customers"
          icon={Users}
        />
      </div>

      <Card pad={false}>
        <div className="border-b border-line px-6 pb-4 pt-5">
          <CardTitle>Recent plans</CardTitle>
        </div>
        {plans.length === 0 ? (
          <EmptyState icon={ClipboardList} title="No plans yet">
            <Link href="/plans/new" className="text-brand-600 hover:underline">
              Create the first one
            </Link>
          </EmptyState>
        ) : (
          <Table
            head={
              <tr>
                <Th>Plan</Th>
                <Th>Customer</Th>
                <Th>Status</Th>
                <Th right>Price</Th>
                <Th right>Updated</Th>
              </tr>
            }
          >
            {plans.map((p) => (
              <tr key={p.id} className="transition-colors hover:bg-surface/60">
                <td className="px-4 py-3">
                  <Link
                    href={`/plans/${p.id}`}
                    className="font-medium text-ink-900 hover:text-brand-600"
                  >
                    {p.title}
                  </Link>
                </td>
                <td className="px-4 py-3 text-ink-600">
                  {p.customer?.display_name ?? "—"}
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={p.status} />
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {totals.has(p.id) ? money(totals.get(p.id)) : "—"}
                </td>
                <td className="px-4 py-3 text-right text-ink-400">
                  {shortDate(p.updated_at)}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
