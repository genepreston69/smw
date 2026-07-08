"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

type ActionResult = { ok: true } | { ok: false; error: string };

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
