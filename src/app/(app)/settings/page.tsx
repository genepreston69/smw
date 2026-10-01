import { Link2 } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { money, shortDate } from "@/lib/format";
import { QbSyncButtons } from "@/components/QbSyncButton";
import { QbDisconnectButton } from "@/components/QbDisconnectButton";
import { QbSyncSchedule } from "@/components/QbSyncSchedule";
import { RoleSelect } from "@/components/RoleSelect";
import { Alert, Card, CardTitle, PageHeader, Table, Th, buttonCls } from "@/components/ui";
import { SYNC_HOUR, SYNC_TIMEZONE } from "@/lib/qbSyncSchedule";
import type {
  ApprovalThreshold,
  Profile,
  QbSyncRun,
  QbSyncStep,
} from "@/lib/types";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ qb_connected?: string; qb_error?: string }>;
}) {
  const sp = await searchParams;
  const { supabase, profile } = await requireUser();
  const isAdmin = profile.role === "admin";

  const [{ data: connRows }, { data: thresholds }, { data: users }] =
    await Promise.all([
      supabase.from("qb_connection_status").select("*").order("created_at"),
      supabase
        .from("approval_thresholds")
        .select("id, min_amount, max_amount, required_approvals, label")
        .order("min_amount"),
      supabase
        .from("profiles")
        .select("id, email, full_name, role")
        .order("email"),
    ]);

  // Nightly sync status: RLS restricts qb_sync_runs/qb_sync_steps to admins,
  // so non-admins get nothing back and the card is hidden for them.
  const { data: runRow } = isAdmin
    ? await supabase
        .from("qb_sync_runs")
        .select("id, trigger, local_date, timezone, status, started_at, finished_at")
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle()
    : { data: null };
  const lastRun = (runRow ?? null) as QbSyncRun | null;
  const { data: stepRows } = lastRun
    ? await supabase
        .from("qb_sync_steps")
        .select("*")
        .eq("run_id", lastRun.id)
        .order("position")
    : { data: null };

  const connections = (connRows ?? []) as Array<{
    realm_id: string;
    company_name: string | null;
    status: string;
    last_sync_at: string | null;
    last_sync_error: string | null;
  }>;

  return (
    <div className="max-w-3xl">
      <PageHeader title="Settings" />

      <div className="space-y-6">
        {sp.qb_connected && (
          <Alert tone="ok">
            QuickBooks connected. Run a sync to import customers and jobs.
          </Alert>
        )}
        {sp.qb_error && <Alert tone="bad">QuickBooks error: {sp.qb_error}</Alert>}

        {/* QuickBooks */}
        <Card>
          <CardTitle>QuickBooks Online</CardTitle>
          {connections.length > 0 ? (
            <div className="space-y-3">
              {connections.map((conn) => (
                <div
                  key={conn.realm_id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface/50 px-3 py-2.5"
                >
                  <div className="text-sm">
                    <p className="font-medium text-ink-900">
                      {conn.company_name ?? `Company ${conn.realm_id}`}
                      <span
                        className={`ml-2 text-xs font-medium ${conn.status === "connected" ? "text-ok-600" : "text-bad-600"}`}
                      >
                        {conn.status}
                      </span>
                    </p>
                    <p className="text-xs text-ink-400">
                      Realm {conn.realm_id} · Last sync:{" "}
                      {conn.last_sync_at ? shortDate(conn.last_sync_at) : "never"}
                      {conn.last_sync_error && (
                        <span className="ml-1 text-bad-600">
                          · {conn.last_sync_error}
                        </span>
                      )}
                    </p>
                  </div>
                  {isAdmin && (
                    <QbDisconnectButton
                      realmId={conn.realm_id}
                      companyLabel={conn.company_name ?? conn.realm_id}
                    />
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-ink-600">
              Not connected. Connect to import your customer list and jobs from
              QuickBooks Online.
            </p>
          )}

          {isAdmin ? (
            <div className="mt-4 flex items-center gap-3">
              <a href="/api/qb/connect" className={buttonCls("dark")}>
                <Link2 size={15} strokeWidth={2} />
                {connections.length > 0
                  ? "Connect another company"
                  : "Connect QuickBooks"}
              </a>
              {connections.length > 0 && (
                <QbSyncButtons
                  companies={connections
                    .filter((c) => c.status === "connected")
                    .map((c) => ({
                      realmId: c.realm_id,
                      label: c.company_name ?? `Company ${c.realm_id}`,
                    }))}
                />
              )}
            </div>
          ) : (
            <p className="mt-3 text-xs text-ink-400">
              Ask an admin to connect QuickBooks or run a sync.
            </p>
          )}
          <p className="mt-4 border-t border-line pt-3 text-xs text-ink-400">
            Trouble with the QuickBooks connection or anything else? Contact
            support:{" "}
            <a
              href="mailto:gene@stravisor.com?subject=SMW%20Job%20Plans%20support"
              className="text-brand-600 hover:underline"
            >
              gene@stravisor.com
            </a>
          </p>
        </Card>

        {/* Nightly QuickBooks sync */}
        {isAdmin && connections.length > 0 && (
          <QbSyncSchedule
            run={lastRun}
            steps={(stepRows ?? []) as QbSyncStep[]}
            timezone={SYNC_TIMEZONE}
            hour={SYNC_HOUR}
          />
        )}

        {/* Approval thresholds */}
        <Card>
          <CardTitle>Approval thresholds</CardTitle>
          <Table
            head={
              <tr>
                <Th className="pl-0">Range (total price)</Th>
                <Th>Required</Th>
              </tr>
            }
          >
            {((thresholds ?? []) as ApprovalThreshold[]).map((t) => (
              <tr key={t.id}>
                <td className="py-2 pr-4 tabular-nums text-ink-900">
                  {money(Number(t.min_amount))}
                  {t.max_amount !== null
                    ? ` – ${money(Number(t.max_amount))}`
                    : " and up"}
                </td>
                <td className="px-4 py-2 text-ink-600">{t.label}</td>
              </tr>
            ))}
          </Table>
        </Card>

        {/* Users */}
        <Card>
          <CardTitle>Users</CardTitle>
          <p className="mb-3 text-sm text-ink-600">
            <span className="font-medium text-ink-900">Estimators</span> create
            and submit plans, <span className="font-medium text-ink-900">approvers</span>{" "}
            review them, <span className="font-medium text-ink-900">admins</span>{" "}
            manage everything, <span className="font-medium text-ink-900">viewers</span>{" "}
            are read-only.
          </p>
          <Table
            head={
              <tr>
                <Th className="pl-0">Name</Th>
                <Th>Email</Th>
                <Th>Role</Th>
              </tr>
            }
          >
            {((users ?? []) as Profile[]).map((u) => (
              <tr key={u.id}>
                <td className="py-2 pr-4 font-medium text-ink-900">
                  {u.full_name || "—"}
                </td>
                <td className="px-4 py-2 text-ink-600">{u.email}</td>
                <td className="px-4 py-2">
                  {isAdmin && u.id !== profile.id ? (
                    <RoleSelect userId={u.id} role={u.role} />
                  ) : (
                    <span className="capitalize text-ink-600">{u.role}</span>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
    </div>
  );
}
