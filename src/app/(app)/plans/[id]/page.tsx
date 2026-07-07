import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { PlanWorkspace } from "@/components/plan/PlanWorkspace";
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
    { data: customers },
    { data: jobs },
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
    supabase
      .from("customers")
      .select("id, display_name")
      .eq("active", true)
      .order("display_name"),
    supabase
      .from("jobs")
      .select("id, name, customer_id")
      .eq("active", true)
      .order("name"),
    supabase.from("profiles").select("id, email, full_name, role"),
  ]);

  return (
    <PlanWorkspace
      plan={plan as ProjectPlan}
      phases={(phases ?? []) as PlanPhase[]}
      items={(items ?? []) as PlanLineItem[]}
      approvals={(approvals ?? []) as Approval[]}
      thresholds={(thresholds ?? []) as ApprovalThreshold[]}
      customers={(customers ?? []) as Pick<Customer, "id" | "display_name">[]}
      jobs={(jobs ?? []) as Pick<Job, "id" | "name" | "customer_id">[]}
      profiles={(profiles ?? []) as Profile[]}
      me={profile}
    />
  );
}
