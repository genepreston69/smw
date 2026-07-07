import { Wrench } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { shortDate } from "@/lib/format";
import { Card, EmptyState, PageHeader, Table, Th } from "@/components/ui";

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
    <div>
      <PageHeader
        title="Jobs"
        subtitle="QuickBooks projects and sub-customers. Job plans attach to these."
      />

      <Card pad={false}>
        {jobs.length === 0 ? (
          <EmptyState icon={Wrench} title="No jobs yet">
            Connect QuickBooks in Settings and run a sync.
          </EmptyState>
        ) : (
          <Table
            head={
              <tr>
                <Th>Job</Th>
                <Th>Customer</Th>
                <Th>Active</Th>
                <Th right>Last synced</Th>
              </tr>
            }
          >
            {jobs.map((j) => (
              <tr key={j.id} className="transition-colors hover:bg-surface/60">
                <td className="px-4 py-3 font-medium text-ink-900">{j.name}</td>
                <td className="px-4 py-3 text-ink-600">
                  {j.customer?.display_name ?? "—"}
                </td>
                <td className="px-4 py-3 text-ink-600">
                  {j.active ? "Yes" : "No"}
                </td>
                <td className="px-4 py-3 text-right text-ink-400">
                  {shortDate(j.last_synced_at)}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
