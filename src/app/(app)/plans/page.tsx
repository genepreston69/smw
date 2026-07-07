import Link from "next/link";
import { ClipboardList, Plus } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { money, shortDate } from "@/lib/format";
import { StatusBadge, TbdBadge } from "@/components/StatusBadge";
import { DeleteRowButton } from "@/components/DeleteRowButton";
import { deletePlan } from "./actions";
import {
  Card,
  EmptyState,
  PageHeader,
  Table,
  Th,
  buttonCls,
} from "@/components/ui";
import type { PlanStatus } from "@/lib/types";

interface PlanRow {
  id: string;
  title: string;
  status: PlanStatus;
  version: number;
  updated_at: string;
  created_by: string;
  customer: { display_name: string } | null;
  creator: { full_name: string | null; email: string | null } | null;
}

export default async function PlansPage() {
  const { supabase, profile } = await requireUser();
  const isAdmin = profile.role === "admin";

  const { data } = await supabase
    .from("project_plans")
    .select(
      "id, title, status, version, updated_at, created_by, customer:customers(display_name), creator:profiles!project_plans_created_by_fkey(full_name, email)",
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
    <div>
      <PageHeader
        title="Job Plans"
        subtitle="Cost estimates and their approval status."
        action={
          <Link href="/plans/new" className={buttonCls("primary")}>
            <Plus size={16} strokeWidth={2} />
            New job plan
          </Link>
        }
      />

      <Card pad={false}>
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
                <Th>Created by</Th>
                <Th>Status</Th>
                <Th right>Price</Th>
                <Th right>Updated</Th>
                <Th right />
              </tr>
            }
          >
            {plans.map((p) => {
              const t = totals.get(p.id);
              return (
                <tr
                  key={p.id}
                  className="transition-colors hover:bg-surface/60"
                >
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-2">
                      <Link
                        href={`/plans/${p.id}`}
                        className="font-medium text-ink-900 hover:text-brand-600"
                      >
                        {p.title}
                      </Link>
                      {p.version > 1 && (
                        <span className="text-xs text-ink-400">
                          v{p.version}
                        </span>
                      )}
                      {t && <TbdBadge count={t.tbd} />}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-ink-600">
                    {p.customer?.display_name ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-ink-600">
                    {p.creator?.full_name || p.creator?.email || "—"}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={p.status} />
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {t ? money(t.price) : "—"}
                  </td>
                  <td className="px-4 py-3 text-right text-ink-400">
                    {shortDate(p.updated_at)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {(isAdmin ||
                      (p.created_by === profile.id &&
                        p.status === "draft")) && (
                      <DeleteRowButton
                        action={deletePlan.bind(null, p.id)}
                        confirmText={`Delete "${p.title}"? This permanently removes the plan and all its line items.`}
                        title="Delete plan"
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
    </div>
  );
}
