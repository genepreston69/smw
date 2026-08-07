import Link from "next/link";
import { Anchor, Stamp } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { money, shortDate } from "@/lib/format";
import { TbdBadge } from "@/components/StatusBadge";
import {
  Card,
  CardTitle,
  EmptyState,
  PageHeader,
  Table,
  Th,
} from "@/components/ui";
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

interface BargeQueueRow {
  id: string;
  name: string;
  version: number;
  sales_price: number;
  submitted_at: string | null;
  created_by: string;
  customer: { display_name: string } | null;
  creator: { full_name: string | null; email: string | null } | null;
}

export default async function ApprovalsPage() {
  const { supabase, profile } = await requireUser();

  const [{ data: queue }, { data: bargeQueue }, { data: thresholds }] =
    await Promise.all([
      supabase
        .from("project_plans")
        .select(
          "id, title, version, submitted_at, created_by, customer:customers(display_name), creator:profiles!project_plans_created_by_fkey(full_name, email)",
        )
        .eq("status", "submitted")
        .order("submitted_at", { ascending: true }),
      supabase
        .from("barge_quotes")
        .select(
          "id, name, version, sales_price, submitted_at, created_by, customer:customers(display_name), creator:profiles!barge_quotes_created_by_fkey(full_name, email)",
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
  const barges = (bargeQueue ?? []) as unknown as BargeQueueRow[];
  const bargeIds = barges.map((b) => b.id);

  const [{ data: totalsRows }, { data: approvalRows }, { data: bargeApprovalRows }] =
    await Promise.all([
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
      bargeIds.length
        ? supabase
            .from("barge_quote_approvals")
            .select("quote_id, quote_version, decision, approver_id")
            .in("quote_id", bargeIds)
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
    <div>
      <PageHeader
        title="Approvals"
        subtitle={
          canApprove
            ? "Plans and barge quotes waiting for review. Open one to approve, reject, or request changes."
            : "Plans and barge quotes currently waiting for approval."
        }
      />

      <Card pad={false} className="mb-6">
        <div className="border-b border-line px-6 py-4">
          <h2 className="text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
            Job plans
          </h2>
        </div>
        {plans.length === 0 ? (
          <EmptyState icon={Stamp} title="Nothing waiting for approval">
            Submitted plans land here for review.
          </EmptyState>
        ) : (
          <Table
            head={
              <tr>
                <Th>Plan</Th>
                <Th>Customer</Th>
                <Th>Submitted by</Th>
                <Th right>Price</Th>
                <Th>Approvals</Th>
                <Th right>Submitted</Th>
              </tr>
            }
          >
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
                      {t && <TbdBadge count={t.tbd} />}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-ink-600">
                    {p.customer?.display_name ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-ink-600">
                    {p.creator?.full_name || p.creator?.email || "—"}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {money(price)}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium tabular-nums ${
                        got >= needed
                          ? "border-ok-600/25 bg-ok-50 text-ok-600"
                          : "border-brand-500/25 bg-brand-50 text-brand-700"
                      }`}
                    >
                      {got} / {needed}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-ink-400">
                    {shortDate(p.submitted_at)}
                  </td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>

      <Card pad={false} className="mb-6">
        <div className="border-b border-line px-6 py-4">
          <h2 className="text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
            Barge quotes
          </h2>
        </div>
        {barges.length === 0 ? (
          <EmptyState icon={Anchor} title="No barge quotes waiting">
            Submitted barge quotes land here for review.
          </EmptyState>
        ) : (
          <Table
            head={
              <tr>
                <Th>Quote</Th>
                <Th>Customer</Th>
                <Th>Submitted by</Th>
                <Th right>Price</Th>
                <Th>Approvals</Th>
                <Th right>Submitted</Th>
              </tr>
            }
          >
            {barges.map((b) => {
              const price = Number(b.sales_price);
              const needed = requiredFor(price);
              const got = (bargeApprovalRows ?? []).filter(
                (a) =>
                  (a as { quote_id: string }).quote_id === b.id &&
                  (a as { quote_version: number }).quote_version === b.version,
              ).length;
              return (
                <tr key={b.id} className="transition-colors hover:bg-surface/60">
                  <td className="px-4 py-3">
                    <Link
                      href={`/barge/${b.id}`}
                      className="font-medium text-ink-900 hover:text-brand-600"
                    >
                      {b.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-ink-600">
                    {b.customer?.display_name ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-ink-600">
                    {b.creator?.full_name || b.creator?.email || "—"}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {money(price)}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium tabular-nums ${
                        got >= needed
                          ? "border-ok-600/25 bg-ok-50 text-ok-600"
                          : "border-brand-500/25 bg-brand-50 text-brand-700"
                      }`}
                    >
                      {got} / {needed}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-ink-400">
                    {shortDate(b.submitted_at)}
                  </td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>

      <Card>
        <CardTitle>Approval thresholds</CardTitle>
        <ul className="space-y-1.5 text-sm text-ink-600">
          {ths.map((t) => (
            <li key={t.id} className="tabular-nums">
              {money(Number(t.min_amount))}
              {t.max_amount !== null
                ? ` – ${money(Number(t.max_amount))}`
                : " and up"}{" "}
              → <span className="font-medium text-ink-900">{t.label}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-ink-400">
          Thresholds are evaluated at approval time — against a plan&apos;s
          total price, or a barge quote&apos;s sales price.
        </p>
      </Card>
    </div>
  );
}
