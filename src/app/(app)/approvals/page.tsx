import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { money, shortDate } from "@/lib/format";
import type { ApprovalThreshold } from "@/lib/types";

interface QueueRow {
  id: string;
  title: string;
  version: number;
  submitted_at: string | null;
  created_by: string;
  customer: { display_name: string } | null;
  creator: { full_name: string | null; email: string | null } | null;
}

export default async function ApprovalsPage() {
  const { supabase, profile } = await requireUser();

  const [{ data: queue }, { data: thresholds }] = await Promise.all([
    supabase
      .from("project_plans")
      .select(
        "id, title, version, submitted_at, created_by, customer:customers(display_name), creator:profiles!project_plans_created_by_fkey(full_name, email)",
      )
      .eq("status", "submitted")
      .order("submitted_at", { ascending: true }),
    supabase
      .from("approval_thresholds")
      .select("id, min_amount, max_amount, required_approvals, label")
      .order("min_amount"),
  ]);

  const plans = (queue ?? []) as unknown as QueueRow[];
  const planIds = plans.map((p) => p.id);

  const [{ data: totalsRows }, { data: approvalRows }] = await Promise.all([
    planIds.length
      ? supabase
          .from("plan_totals")
          .select("plan_id, total_price, tbd_count")
          .in("plan_id", planIds)
      : Promise.resolve({ data: [] as never[] }),
    planIds.length
      ? supabase
          .from("approvals")
          .select("plan_id, plan_version, decision, approver_id")
          .in("plan_id", planIds)
          .eq("decision", "approved")
      : Promise.resolve({ data: [] as never[] }),
  ]);

  const totals = new Map(
    (totalsRows ?? []).map((t) => [
      t.plan_id as string,
      { price: Number(t.total_price), tbd: Number(t.tbd_count) },
    ]),
  );

  const ths = (thresholds ?? []) as ApprovalThreshold[];
  const requiredFor = (price: number) =>
    ths.find(
      (t) =>
        price >= Number(t.min_amount) &&
        (t.max_amount === null || price < Number(t.max_amount)),
    )?.required_approvals ?? 1;

  const canApprove = profile.role === "approver" || profile.role === "admin";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Approvals</h1>
        <p className="mt-1 text-sm text-zinc-500">
          {canApprove
            ? "Plans waiting for review. Open a plan to approve, reject, or request changes."
            : "Plans currently waiting for approval."}
        </p>
      </div>

      <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
        {plans.length === 0 ? (
          <p className="p-6 text-sm text-zinc-500">
            Nothing waiting for approval. 🎉
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-2.5">Plan</th>
                <th className="px-4 py-2.5">Customer</th>
                <th className="px-4 py-2.5">Submitted by</th>
                <th className="px-4 py-2.5 text-right">Price</th>
                <th className="px-4 py-2.5">Approvals</th>
                <th className="px-4 py-2.5 text-right">Submitted</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {plans.map((p) => {
                const t = totals.get(p.id);
                const price = t?.price ?? 0;
                const needed = requiredFor(price);
                const got = (approvalRows ?? []).filter(
                  (a) =>
                    (a as { plan_id: string }).plan_id === p.id &&
                    (a as { plan_version: number }).plan_version === p.version,
                ).length;
                return (
                  <tr key={p.id} className="hover:bg-zinc-50">
                    <td className="px-4 py-2.5">
                      <Link
                        href={`/plans/${p.id}`}
                        className="font-medium text-zinc-900 hover:underline"
                      >
                        {p.title}
                      </Link>
                      {t && t.tbd > 0 && (
                        <span className="ml-1.5 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                          {t.tbd} TBD — blocked
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-zinc-600">
                      {p.customer?.display_name ?? "—"}
                    </td>
                    <td className="px-4 py-2.5 text-zinc-600">
                      {p.creator?.full_name || p.creator?.email || "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {money(price)}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${got >= needed ? "bg-emerald-50 text-emerald-700" : "bg-blue-50 text-blue-700"}`}
                      >
                        {got} / {needed}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right text-zinc-500">
                      {shortDate(p.submitted_at)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <section className="rounded-xl border border-zinc-200 bg-white p-5">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Approval thresholds
        </h2>
        <ul className="space-y-1 text-sm text-zinc-600">
          {ths.map((t) => (
            <li key={t.id}>
              {money(Number(t.min_amount))}
              {t.max_amount !== null
                ? ` – ${money(Number(t.max_amount))}`
                : " and up"}{" "}
              → <span className="font-medium">{t.label}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-zinc-400">
          Thresholds are evaluated against a plan&apos;s total price at approval
          time. Admins can adjust them in the database (approval_thresholds).
        </p>
      </section>
    </div>
  );
}
