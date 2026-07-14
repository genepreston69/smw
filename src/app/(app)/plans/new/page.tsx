import { requireUser } from "@/lib/auth";
import { fetchAllRows } from "@/lib/supabase/fetchAll";
import { createPlan } from "@/app/(app)/plans/actions";
import { Card, PageHeader, buttonCls } from "@/components/ui";
import type { Customer, Job } from "@/lib/types";

const inputCls =
  "mt-1 w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-900 placeholder:text-ink-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20";

export default async function NewPlanPage() {
  const { supabase } = await requireUser();

  // Paged reads so the dropdowns list every record past Supabase's
  // 1000-row cap.
  const [customers, jobs] = await Promise.all([
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
  ]);

  return (
    <div className="mx-auto max-w-lg">
      <PageHeader
        title="New job plan"
        subtitle="Customer and job can also be set later — a customer is required before the plan can be submitted."
      />

      <Card>
        <form action={createPlan} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-ink-900">
              Plan title
            </label>
            <input
              name="title"
              required
              placeholder="e.g. Caroline COI 626 Repair"
              className={inputCls}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-ink-900">
              Customer
            </label>
            <select name="customer_id" defaultValue="" className={inputCls}>
              <option value="">— Select later —</option>
              {(
                customers as Pick<Customer, "id" | "display_name">[]
              ).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.display_name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-ink-900">
              QuickBooks job <span className="text-ink-400">(optional)</span>
            </label>
            <select name="job_id" defaultValue="" className={inputCls}>
              <option value="">— None —</option>
              {(jobs as Pick<Job, "id" | "name">[]).map((j) => (
                <option key={j.id} value={j.id}>
                  {j.name}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className={`${buttonCls("primary")} w-full`}>
            Create plan
          </button>
        </form>
      </Card>
    </div>
  );
}
