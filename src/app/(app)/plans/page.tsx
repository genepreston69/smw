import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { money, shortDate } from "@/lib/format";
import { StatusBadge } from "@/components/StatusBadge";
import type { PlanStatus } from "@/lib/types";

interface PlanRow {
  id: string;
  title: string;
  status: PlanStatus;
  version: number;
  updated_at: string;
  customer: { display_name: string } | null;
  creator: { full_name: string | null; email: string | null } | null;
}

export default async function PlansPage() {
  const { supabase } = await requireUser();

  const { data } = await supabase
    .from("project_plans")
    .select(
      "id, title, status, version, updated_at, customer:customers(display_name), creator:profiles!project_plans_created_by_fkey(full_name, email)",
    )
    .order("updated_at", { ascending: false });

  const plans = (data ?? []) as unknown as PlanRow[];

  const planIds = plans.map((p) => p.id);
  const { data: totalsRows } = planIds.length
    ? await supabase
        .from("plan_totals")
        .select("plan_id, total_price, tbd_count")
        .in("plan_id", planIds)
    : { data: [] };
  const totals = new Map(
    (totalsRows ?? []).map((t) => [
      t.plan_id as string,
      { price: Number(t.total_price), tbd: Number(t.tbd_count) },
    ]),
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Job Plans</h1>
        <Link
          href="/plans/new"
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
        >
          New job plan
        </Link>
      </div>

      <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
        {plans.length === 0 ? (
          <p className="p-6 text-sm text-zinc-500">No plans yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-2.5">Plan</th>
                <th className="px-4 py-2.5">Customer</th>
                <th className="px-4 py-2.5">Created by</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5 text-right">Price</th>
                <th className="px-4 py-2.5 text-right">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {plans.map((p) => {
                const t = totals.get(p.id);
                return (
                  <tr key={p.id} className="hover:bg-zinc-50">
                    <td className="px-4 py-2.5">
                      <Link
                        href={`/plans/${p.id}`}
                        className="font-medium text-zinc-900 hover:underline"
                      >
                        {p.title}
                      </Link>
                      {p.version > 1 && (
                        <span className="ml-1.5 text-xs text-zinc-400">
                          v{p.version}
                        </span>
                      )}
                      {t && t.tbd > 0 && (
                        <span className="ml-1.5 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                          {t.tbd} TBD
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-zinc-600">
                      {p.customer?.display_name ?? "—"}
                    </td>
                    <td className="px-4 py-2.5 text-zinc-600">
                      {p.creator?.full_name || p.creator?.email || "—"}
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusBadge status={p.status} />
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {t ? money(t.price) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right text-zinc-500">
                      {shortDate(p.updated_at)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
