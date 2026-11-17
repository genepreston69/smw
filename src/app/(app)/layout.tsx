import Link from "next/link";
import { Anchor, TriangleAlert } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { dateTimeIn } from "@/lib/format";
import { loadSyncHealth } from "@/lib/syncHealth";
import { loadSchemaStatus } from "@/lib/schemaStatus";
import { SidebarNav } from "@/components/SidebarNav";
import { SignOutButton } from "@/components/SignOutButton";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { profile } = await requireUser();
  const isAdmin = profile.role === "admin";
  // Freshness stamp for everyone; what's wrong with the sync for admins only.
  const [sync, schema] = await Promise.all([
    loadSyncHealth(),
    // Admins also hear when the database is behind the code (a migration that
    // hasn't been applied yet) — the cause of "function not found" failures.
    isAdmin ? loadSchemaStatus() : null,
  ]);
  const missing = schema?.missing ?? [];
  const problems = isAdmin
    ? [
        ...(missing.length > 0
          ? [
              `The database is missing ${missing.length === 1 ? "a migration" : `${missing.length} migrations`} this version of the app needs (${missing.join(", ")}) — apply ${missing.length === 1 ? "it" : "them in order"} in the Supabase SQL editor.`,
            ]
          : []),
        ...(sync?.problems ?? []),
      ]
    : [];

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="fixed inset-y-0 left-0 z-20 flex w-56 flex-col bg-navy-950 print:hidden">
        <div className="flex items-center gap-2.5 px-4 pb-6 pt-6">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 text-white">
            <Anchor size={18} strokeWidth={2} />
          </span>
          <div className="leading-tight">
            <p className="text-sm font-bold tracking-wide text-white">SMW</p>
            <p className="text-[0.68rem] font-medium uppercase tracking-[0.14em] text-white/45">
              Job Plans
            </p>
          </div>
        </div>

        <SidebarNav isAdmin={isAdmin} />

        {sync && (
          <div className="mt-auto border-t border-white/10 px-4 py-3 text-[0.7rem] leading-relaxed text-white/50">
            <p className="font-semibold uppercase tracking-[0.1em] text-white/40">
              QuickBooks data as of
            </p>
            <p className={sync.costsStale ? "text-amber-300" : undefined}>
              Jobs &amp; costs:{" "}
              {sync.costsAsOf ? dateTimeIn(sync.costsAsOf, sync.timezone) : "not yet imported"}
            </p>
            {isAdmin && (
              <p>
                Ledger:{" "}
                {sync.ledgerAsOf
                  ? dateTimeIn(sync.ledgerAsOf, sync.timezone)
                  : "not yet imported"}
              </p>
            )}
          </div>
        )}

        <div className={`${sync ? "" : "mt-auto "}border-t border-white/10 px-4 py-4`}>
          <p className="truncate text-sm font-medium text-white/90">
            {profile.full_name || profile.email}
          </p>
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <span className="rounded-full border border-white/15 bg-white/5 px-2 py-0.5 text-[0.68rem] font-medium capitalize text-white/60">
              {profile.role}
            </span>
            <SignOutButton />
          </div>
        </div>
      </aside>

      {/* Main */}
      <div className="ml-56 flex min-h-screen min-w-0 flex-1 flex-col print:ml-0">
        <main className="mx-auto w-full max-w-[1480px] flex-1 px-6 py-8 print:max-w-none print:px-0 print:py-0">
          {problems.length > 0 && (
            <div
              role="alert"
              className="mb-6 flex gap-3 rounded-xl border border-warn-700/30 bg-warn-50 px-4 py-3 text-sm text-warn-700 print:hidden"
            >
              <TriangleAlert size={18} strokeWidth={2} className="mt-0.5 shrink-0" />
              <div className="min-w-0">
                <p className="font-semibold">
                  {(sync?.problems.length ?? 0) > 0
                    ? "QuickBooks sync needs attention — some numbers may be out of date"
                    : "The database needs an update"}
                </p>
                <ul className="mt-1 space-y-0.5">
                  {problems.map((p) => (
                    <li key={p} className="break-words">
                      {p}
                    </li>
                  ))}
                </ul>
                <Link href="/settings" className="mt-1 inline-block font-medium underline">
                  Open Settings
                </Link>
              </div>
            </div>
          )}
          {children}
        </main>
      </div>
    </div>
  );
}
