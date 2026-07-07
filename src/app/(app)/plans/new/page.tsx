import { requireUser } from "@/lib/auth";
import { createPlan } from "@/app/(app)/plans/actions";
import type { Customer, Job } from "@/lib/types";

export default async function NewPlanPage() {
  const { supabase } = await requireUser();

  const [{ data: customers }, { data: jobs }] = await Promise.all([
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
  ]);

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">New job plan</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Customer and job can also be set later on the plan itself — a
          customer is required before the plan can be submitted.
        </p>
      </div>

      <form
        action={createPlan}
        className="space-y-4 rounded-xl border border-zinc-200 bg-white p-6"
      >
        <div>
          <label className="block text-sm font-medium text-zinc-700">
            Plan title
          </label>
          <input
            name="title"
            required
            placeholder="e.g. Caroline COI 626 Repair"
            className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-700">
            Customer
          </label>
          <select
            name="customer_id"
            defaultValue=""
            className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          >
            <option value="">— Select later —</option>
            {((customers ?? []) as Pick<Customer, "id" | "display_name">[]).map(
              (c) => (
                <option key={c.id} value={c.id}>
                  {c.display_name}
                </option>
              ),
            )}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-700">
            QuickBooks job (optional)
          </label>
          <select
            name="job_id"
            defaultValue=""
            className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          >
            <option value="">— None —</option>
            {((jobs ?? []) as Pick<Job, "id" | "name">[]).map((j) => (
              <option key={j.id} value={j.id}>
                {j.name}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          className="w-full rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
        >
          Create plan
        </button>
      </form>
    </div>
  );
}
