import { Users } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { shortDate } from "@/lib/format";
import { Card, EmptyState, PageHeader, Table, Th } from "@/components/ui";
import type { Customer } from "@/lib/types";

export default async function CustomersPage() {
  const { supabase } = await requireUser();
  const { data } = await supabase
    .from("customers")
    .select(
      "id, qb_id, display_name, company_name, email, phone, active, last_synced_at",
    )
    .order("display_name");

  const customers = (data ?? []) as Customer[];

  return (
    <div>
      <PageHeader
        title="Customers"
        subtitle="Imported from QuickBooks Online. Read-only — manage customers in QuickBooks and re-sync from Settings."
      />

      <Card pad={false}>
        {customers.length === 0 ? (
          <EmptyState icon={Users} title="No customers yet">
            Connect QuickBooks in Settings and run a sync.
          </EmptyState>
        ) : (
          <Table
            head={
              <tr>
                <Th>Name</Th>
                <Th>Company</Th>
                <Th>Email</Th>
                <Th>Phone</Th>
                <Th right>Last synced</Th>
              </tr>
            }
          >
            {customers.map((c) => (
              <tr key={c.id} className="transition-colors hover:bg-surface/60">
                <td className="px-4 py-3 font-medium text-ink-900">
                  {c.display_name}
                </td>
                <td className="px-4 py-3 text-ink-600">
                  {c.company_name ?? "—"}
                </td>
                <td className="px-4 py-3 text-ink-600">{c.email ?? "—"}</td>
                <td className="px-4 py-3 text-ink-600">{c.phone ?? "—"}</td>
                <td className="px-4 py-3 text-right text-ink-400">
                  {shortDate(c.last_synced_at)}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
