import { requireAdmin } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/service";
import { PageHeader } from "@/components/ui";
import { ReconcileUploader } from "./ReconcileUploader";

// Reconciliation with QB: upload the consolidated Profit and Loss export
// straight from QuickBooks and verify the general ledger imported here
// (gl_lines) ties to it, account by account and month by month. Parsing and
// comparison run in the server action (./actions.ts); the math lives in
// src/lib/reconciliation.ts.

export default async function ReconciliationPage() {
  // GL data is admin-only; the service-role read below only fetches sync
  // freshness metadata (same pattern as the other Financials pages).
  await requireAdmin();
  const supabase = createServiceClient();
  const [{ data: syncRows }, { data: connRows }] = await Promise.all([
    supabase.from("gl_sync_state").select("realm_id, updated_at"),
    supabase.from("qb_connection_status").select("realm_id, company_name"),
  ]);
  const nameByRealm = new Map(
    (connRows ?? []).map((c: { realm_id: string; company_name: string | null }) => [
      c.realm_id,
      c.company_name ?? `Company ${c.realm_id}`,
    ]),
  );
  const lastSynced = (syncRows ?? [])
    .map((s: { realm_id: string; updated_at: string }) => ({
      company: nameByRealm.get(s.realm_id) ?? `Company ${s.realm_id}`,
      at: s.updated_at,
    }))
    .sort((a, b) => a.company.localeCompare(b.company));

  return (
    <div>
      <PageHeader
        title="Reconciliation with QB"
        subtitle={
          <>
            Verify the general ledger imported into this app ties to
            QuickBooks: upload the consolidated Profit and Loss export and
            compare every account, month by month.
            {lastSynced.length > 0 && (
              <>
                {" "}
                Ledger last imported:{" "}
                {lastSynced
                  .map(
                    (s) =>
                      `${s.company} ${new Date(s.at).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })}`,
                  )
                  .join(", ")}
                .
              </>
            )}
          </>
        }
      />
      <ReconcileUploader />
    </div>
  );
}
