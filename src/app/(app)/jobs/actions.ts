"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

type ActionResult = { ok: true } | { ok: false; error: string };

export interface JobCostLine {
  id: string;
  txn_date: string | null;
  qb_txn_type: string;
  vendor_name: string | null;
  description: string | null;
  category: string | null;
  cost_type: "materials" | "labor" | "other";
  amount: number;
  hours: number | null;
}

export type JobCostsResult =
  | { ok: true; lines: JobCostLine[] }
  | { ok: false; error: string };

/** Transaction history for one job, newest first (RLS: any signed-in user). */
export async function getJobCosts(jobId: string): Promise<JobCostsResult> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("job_costs")
    .select(
      "id, txn_date, qb_txn_type, vendor_name, description, category, cost_type, amount, hours",
    )
    .eq("job_id", jobId)
    .order("txn_date", { ascending: false, nullsFirst: false });
  if (error) return { ok: false, error: error.message };
  return {
    ok: true,
    lines: (data ?? []).map((r) => ({
      ...r,
      cost_type: (r.cost_type ?? "other") as JobCostLine["cost_type"],
      amount: Number(r.amount ?? 0),
      hours: r.hours == null ? null : Number(r.hours),
    })),
  };
}

export async function deleteJob(jobId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("jobs")
    .delete()
    .eq("id", jobId)
    .select("id");

  if (error) {
    if (error.code === "23503")
      return {
        ok: false,
        error:
          "This job is referenced by one or more job plans. Remove the job from those plans first.",
      };
    return { ok: false, error: error.message };
  }
  // RLS silently matches zero rows when the caller isn't an admin.
  if (!data?.length) return { ok: false, error: "Only admins can delete jobs" };
  revalidatePath("/jobs");
  return { ok: true };
}
