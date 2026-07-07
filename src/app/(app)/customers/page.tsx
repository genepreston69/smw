import { requireUser } from "@/lib/auth";
import { shortDate } from "@/lib/format";
import type { Customer } from "@/lib/types";

export default async function CustomersPage() {
  const { supabase } = await requireUser();
  const { data } = await supabase
    .from("customers")
    .select("id, qb_id, display_name, company_name, email, phone, active, last_synced_at")
    .order("display_name");

  const customers = (data ?? []) as Customer[];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Customers</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Imported from QuickBooks Online. Read-only — manage customers in
          QuickBooks and re-sync from Settings.
        </p>
      </div>

      <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
        {customers.length === 0 ? (
          <p className="p-6 text-sm text-zinc-500">
            No customers yet. Connect QuickBooks in Settings and run a sync.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-2.5">Name</th>
                <th className="px-4 py-2.5">Company</th>
                <th className="px-4 py-2.5">Email</th>
                <th className="px-4 py-2.5">Phone</th>
                <th className="px-4 py-2.5 text-right">Last synced</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {customers.map((c) => (
                <tr key={c.id} className="hover:bg-zinc-50">
                  <td className="px-4 py-2.5 font-medium">{c.display_name}</td>
                  <td className="px-4 py-2.5 text-zinc-600">
                    {c.company_name ?? "—"}
                  </td>
                  <td className="px-4 py-2.5 text-zinc-600">{c.email ?? "—"}</td>
                  <td className="px-4 py-2.5 text-zinc-600">{c.phone ?? "—"}</td>
                  <td className="px-4 py-2.5 text-right text-zinc-500">
                    {shortDate(c.last_synced_at)}
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
