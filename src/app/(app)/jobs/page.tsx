import { requireUser } from "@/lib/auth";
import { shortDate } from "@/lib/format";

interface JobRow {
  id: string;
  name: string;
  fully_qualified_name: string | null;
  active: boolean;
  last_synced_at: string | null;
  customer: { display_name: string } | null;
}

export default async function JobsPage() {
  const { supabase } = await requireUser();
  const { data } = await supabase
    .from("jobs")
    .select(
      "id, name, fully_qualified_name, active, last_synced_at, customer:customers(display_name)",
    )
    .order("name");

  const jobs = (data ?? []) as unknown as JobRow[];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Jobs</h1>
        <p className="mt-1 text-sm text-zinc-500">
          QuickBooks projects / sub-customers. Job plans attach to these.
        </p>
      </div>

      <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
        {jobs.length === 0 ? (
          <p className="p-6 text-sm text-zinc-500">
            No jobs yet. Connect QuickBooks in Settings and run a sync.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-2.5">Job</th>
                <th className="px-4 py-2.5">Customer</th>
                <th className="px-4 py-2.5">Active</th>
                <th className="px-4 py-2.5 text-right">Last synced</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {jobs.map((j) => (
                <tr key={j.id} className="hover:bg-zinc-50">
                  <td className="px-4 py-2.5 font-medium">{j.name}</td>
                  <td className="px-4 py-2.5 text-zinc-600">
                    {j.customer?.display_name ?? "—"}
                  </td>
                  <td className="px-4 py-2.5 text-zinc-600">
                    {j.active ? "Yes" : "No"}
                  </td>
                  <td className="px-4 py-2.5 text-right text-zinc-500">
                    {shortDate(j.last_synced_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
