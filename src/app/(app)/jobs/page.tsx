import { Wrench } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { shortDate } from "@/lib/format";
import { Card, EmptyState, PageHeader, Table, Th } from "@/components/ui";
import { DeleteRowButton } from "@/components/DeleteRowButton";
import { deleteJob } from "./actions";

interface JobRow {
  id: string;
  name: string;
  fully_qualified_name: string | null;
  active: boolean;
  last_synced_at: string | null;
  customer: { display_name: string } | null;
}

export default async function JobsPage() {
  const { supabase, profile } = await requireUser();
  const isAdmin = profile.role === "admin";
  const [{ data }, { data: connRows }] = await Promise.all([
    supabase
      .from("jobs")
      .select(
        "id, name, realm_id, fully_qualified_name, active, last_synced_at, customer:customers(display_name)",
      )
      .order("name"),
    supabase.from("qb_connection_status").select("realm_id, company_name"),
  ]);

  const jobs = (data ?? []) as unknown as (JobRow & { realm_id: string | null })[];
  const companyByRealm = new Map(
    (connRows ?? []).map((c) => [c.realm_id as string, c.company_name as string | null]),
  );
  const showCompany = companyByRealm.size > 1;

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
                {showCompany && <Th>QB Company</Th>}
                <Th>Customer</Th>
                <Th>Active</Th>
                <Th right>Last synced</Th>
                {isAdmin && <Th right />}
              </tr>
            }
          >
            {jobs.map((j) => (
              <tr key={j.id} className="transition-colors hover:bg-surface/60">
                <td className="px-4 py-3 font-medium text-ink-900">{j.name}</td>
                {showCompany && (
                  <td className="px-4 py-3 text-ink-600">
                    {(j.realm_id && companyByRealm.get(j.realm_id)) ?? "—"}
                  </td>
                )}
                <td className="px-4 py-3 text-ink-600">
                  {j.customer?.display_name ?? "—"}
                </td>
                <td className="px-4 py-3 text-ink-600">
                  {j.active ? "Yes" : "No"}
                </td>
                <td className="px-4 py-3 text-right text-ink-400">
                  {shortDate(j.last_synced_at)}
                </td>
                {isAdmin && (
                  <td className="px-4 py-3 text-right">
                    <DeleteRowButton
                      action={deleteJob.bind(null, j.id)}
                      confirmText={`Delete job "${j.name}"? This only removes the local record — the job stays in QuickBooks and will re-import on the next sync.`}
                      title="Delete job"
                    />
                  </td>
                )}
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
