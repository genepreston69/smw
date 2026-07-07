import { requireUser } from "@/lib/auth";
import { money, shortDate } from "@/lib/format";
import { QbSyncButton } from "@/components/QbSyncButton";
import { RoleSelect } from "@/components/RoleSelect";
import type { ApprovalThreshold, Profile } from "@/lib/types";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ qb_connected?: string; qb_error?: string }>;
}) {
  const sp = await searchParams;
  const { supabase, profile } = await requireUser();
  const isAdmin = profile.role === "admin";

  const [{ data: conn }, { data: thresholds }, { data: users }] =
    await Promise.all([
      supabase
        .from("qb_connection_status")
        .select("*")
        .limit(1)
        .maybeSingle(),
      supabase
        .from("approval_thresholds")
        .select("id, min_amount, max_amount, required_approvals, label")
        .order("min_amount"),
      supabase.from("profiles").select("id, email, full_name, role").order("email"),
    ]);

  return (
    <div className="max-w-3xl space-y-8">
      <h1 className="text-2xl font-semibold">Settings</h1>

      {sp.qb_connected && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-700">
          QuickBooks connected. Run a sync to import customers and jobs.
        </div>
      )}
      {sp.qb_error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
          QuickBooks error: {sp.qb_error}
        </div>
      )}

      {/* QuickBooks */}
      <section className="rounded-xl border border-zinc-200 bg-white p-6">
        <h2 className="text-lg font-medium">QuickBooks Online</h2>
        {conn ? (
          <div className="mt-3 space-y-1 text-sm text-zinc-600">
            <p>
              Status:{" "}
              <span
                className={
                  conn.status === "connected"
                    ? "font-medium text-emerald-600"
                    : "font-medium text-red-600"
                }
              >
                {conn.status}
              </span>{" "}
              · Company (realm) {conn.realm_id}
            </p>
            <p>
              Last sync:{" "}
              {conn.last_sync_at ? shortDate(conn.last_sync_at) : "never"}
              {conn.last_sync_error && (
                <span className="ml-2 text-red-600">
                  Last error: {conn.last_sync_error}
                </span>
              )}
            </p>
          </div>
        ) : (
          <p className="mt-3 text-sm text-zinc-500">
            Not connected. Connect to import your customer list and jobs from
            QuickBooks Online.
          </p>
        )}

        {isAdmin && (
          <div className="mt-4 flex items-center gap-3">
            <a
              href="/api/qb/connect"
              className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
            >
              {conn ? "Reconnect QuickBooks" : "Connect QuickBooks"}
            </a>
            {conn && <QbSyncButton />}
          </div>
        )}
        {!isAdmin && (
          <p className="mt-3 text-xs text-zinc-400">
            Ask an admin to connect QuickBooks or run a sync.
          </p>
        )}
      </section>

      {/* Approval thresholds */}
      <section className="rounded-xl border border-zinc-200 bg-white p-6">
        <h2 className="text-lg font-medium">Approval thresholds</h2>
        <table className="mt-3 w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="py-1.5">Range (total price)</th>
              <th className="py-1.5">Required</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {((thresholds ?? []) as ApprovalThreshold[]).map((t) => (
              <tr key={t.id}>
                <td className="py-1.5 tabular-nums">
                  {money(Number(t.min_amount))}
                  {t.max_amount !== null
                    ? ` – ${money(Number(t.max_amount))}`
                    : " and up"}
                </td>
                <td className="py-1.5">{t.label}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Users */}
      <section className="rounded-xl border border-zinc-200 bg-white p-6">
        <h2 className="text-lg font-medium">Users</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Roles: <span className="font-medium">estimator</span> creates and
          submits plans, <span className="font-medium">approver</span> reviews
          them, <span className="font-medium">admin</span> manages everything,{" "}
          <span className="font-medium">viewer</span> is read-only.
        </p>
        <table className="mt-3 w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="py-1.5">Name</th>
              <th className="py-1.5">Email</th>
              <th className="py-1.5">Role</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {((users ?? []) as Profile[]).map((u) => (
              <tr key={u.id}>
                <td className="py-1.5">{u.full_name || "—"}</td>
                <td className="py-1.5 text-zinc-600">{u.email}</td>
                <td className="py-1.5">
                  {isAdmin && u.id !== profile.id ? (
                    <RoleSelect userId={u.id} role={u.role} />
                  ) : (
                    <span className="capitalize">{u.role}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
