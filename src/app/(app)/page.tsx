import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { money, shortDate } from "@/lib/format";
import { StatusBadge } from "@/components/StatusBadge";
import type { PlanStatus } from "@/lib/types";

export default async function DashboardPage() {
  const { supabase, profile } = await requireUser();

  const [plansRes, submittedRes, customersRes] = await Promise.all([
    supabase
      .from("project_plans")
      .select("id, title, status, updated_at, customer:customers(display_name)")
      .order("updated_at", { ascending: false })
      .limit(8),
    supabase
      .from("project_plans")
      .select("id", { count: "exact", head: true })
      .eq("status", "submitted"),
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

  const canApprove = profile.role === "approver" || profile.role === "admin";

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <Link
          href="/plans/new"
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
        >
          New job plan
        </Link>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-zinc-200 bg-white p-5">
          <p className="text-sm text-zinc-500">Awaiting approval</p>
          <p className="mt-1 text-3xl font-semibold">
            {submittedRes.count ?? 0}
          </p>
          {canApprove && (
            <Link
              href="/approvals"
              className="mt-2 inline-block text-sm text-blue-600 hover:underline"
            >
              Review queue →
            </Link>
          )}
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white p-5">
          <p className="text-sm text-zinc-500">Customers (from QuickBooks)</p>
          <p className="mt-1 text-3xl font-semibold">
            {customersRes.count ?? 0}
          </p>
          <Link
            href="/customers"
            className="mt-2 inline-block text-sm text-blue-600 hover:underline"
          >
            View customers →
          </Link>
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white p-5">
          <p className="text-sm text-zinc-500">Your role</p>
          <p className="mt-1 text-3xl font-semibold capitalize">
            {profile.role}
          </p>
        </div>
      </div>

      <section>
        <h2 className="mb-3 text-lg font-medium">Recent plans</h2>
        <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
          {plans.length === 0 ? (
            <p className="p-6 text-sm text-zinc-500">
              No plans yet.{" "}
              <Link href="/plans/new" className="text-blue-600 hover:underline">
                Create the first one
              </Link>
              .
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="px-4 py-2.5">Plan</th>
                  <th className="px-4 py-2.5">Customer</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5 text-right">Price</th>
                  <th className="px-4 py-2.5 text-right">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {plans.map((p) => (
                  <tr key={p.id} className="hover:bg-zinc-50">
                    <td className="px-4 py-2.5">
                      <Link
                        href={`/plans/${p.id}`}
                        className="font-medium text-zinc-900 hover:underline"
                      >
                        {p.title}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5 text-zinc-600">
                      {p.customer?.display_name ?? "—"}
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusBadge status={p.status} />
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {totals.has(p.id) ? money(totals.get(p.id)) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right text-zinc-500">
                      {shortDate(p.updated_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}
