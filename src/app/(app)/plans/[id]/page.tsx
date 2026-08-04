import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { fetchAllRows } from "@/lib/supabase/fetchAll";
import { PlanWizard } from "@/components/plan/PlanWizard";
import type {
  Approval,
  ApprovalThreshold,
  Customer,
  Job,
  PlanLineItem,
  PlanPhase,
  ProjectPlan,
  Profile,
} from "@/lib/types";

export default async function PlanPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { supabase, profile } = await requireUser();

  const { data: plan } = await supabase
    .from("project_plans")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (!plan) notFound();

  const [
    { data: phases },
    { data: items },
    { data: approvals },
    { data: thresholds },
    customers,
    jobs,
    { data: profiles },
  ] = await Promise.all([
    supabase
      .from("plan_phases")
      .select("*")
      .eq("plan_id", id)
      .order("sort_order"),
    supabase
      .from("plan_line_items")
      .select("*")
      .eq("plan_id", id)
      .order("sort_order"),
    supabase
      .from("approvals")
      .select("*")
      .eq("plan_id", id)
      .order("created_at", { ascending: false }),
    supabase
      .from("approval_thresholds")
      .select("id, min_amount, max_amount, required_approvals, label")
      .order("min_amount"),
    // Paged reads so the pickers list every record past Supabase's
    // 1000-row cap.
    fetchAllRows((from, to) =>
      supabase
        .from("customers")
        .select("id, display_name")
        .eq("active", true)
        .order("display_name")
        .order("id")
        .range(from, to),
    ),
    fetchAllRows((from, to) =>
      supabase
        .from("jobs")
        .select("id, name, customer_id")
        .eq("active", true)
        .order("name")
        .order("id")
        .range(from, to),
    ),
    supabase.from("profiles").select("id, email, full_name, role"),
  ]);

  // Actual costs from QuickBooks for the linked job (if any).
  let actuals: {
    total: number;
    hours: number;
    byCategory: { name: string; amount: number }[];
  } | null = null;
  if (plan.job_id) {
    // Paged read: big jobs can exceed 1000 cost lines, and a truncated
    // read would understate the actuals.
    const costLines = await fetchAllRows((from, to) =>
      supabase
        .from("job_costs")
        .select("category, amount, hours")
        .eq("job_id", plan.job_id)
        .order("id")
        .range(from, to),
    );
    if (costLines.length > 0) {
      const byCat = new Map<string, number>();
      let total = 0;
      let hoursTotal = 0;
      for (const l of costLines) {
        total += Number(l.amount ?? 0);
        hoursTotal += Number(l.hours ?? 0);
        const key = (l.category as string) ?? "Uncategorized";
        byCat.set(key, (byCat.get(key) ?? 0) + Number(l.amount ?? 0));
      }
      actuals = {
        total,
        hours: hoursTotal,
        byCategory: [...byCat.entries()]
          .map(([name, amount]) => ({ name, amount }))
          .sort((a, b) => b.amount - a.amount),
      };
    }
  }

  return (
    <PlanWizard
      plan={plan as ProjectPlan}
      phases={(phases ?? []) as PlanPhase[]}
      items={(items ?? []) as PlanLineItem[]}
      approvals={(approvals ?? []) as Approval[]}
      thresholds={(thresholds ?? []) as ApprovalThreshold[]}
      customers={customers as Pick<Customer, "id" | "display_name">[]}
      jobs={jobs as Pick<Job, "id" | "name" | "customer_id">[]}
      profiles={(profiles ?? []) as Profile[]}
      me={profile}
      actuals={actuals}
    />
  );
}
