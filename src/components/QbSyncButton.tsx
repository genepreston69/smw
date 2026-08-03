"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { buttonCls } from "@/components/ui";

// The sync runs as several requests because one invocation for everything
// exceeds Vercel's function window: first the main sync (customers, jobs,
// costs, invoices), then the general-ledger import one company at a time.
export function QbSyncButton({ realmIds }: { realmIds: string[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function post(url: string, body?: unknown) {
    const res = await fetch(url, {
      method: "POST",
      ...(body !== undefined
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
    });
    // A gateway timeout returns HTML, not JSON — don't let parsing mask it.
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        json.error ?? `Sync failed (${res.status}${res.status === 504 ? " — timed out" : ""})`,
      );
    }
    return json;
  }

  async function sync() {
    setBusy(true);
    setMessage(null);
    try {
      setMessage("Importing customers, jobs, costs, and invoices…");
      const main = await post("/api/qb/sync");

      let glAccounts = 0;
      let glLines = 0;
      for (const [i, realmId] of realmIds.entries()) {
        setMessage(
          `Importing general ledger (company ${i + 1} of ${realmIds.length})…`,
        );
        const ledger = await post("/api/qb/sync-ledger", { realmId });
        glAccounts += ledger.glAccounts ?? 0;
        glLines += ledger.glLines ?? 0;
      }

      setMessage(
        `QuickBooks returned ${main.customers} customers and ${main.jobs} jobs across ${main.companies} ${main.companies === 1 ? "company" : "companies"}; Supabase now holds ${main.dbCustomers ?? main.customers} customers and ${main.dbJobs ?? main.jobs} jobs. Imported ${main.costLines ?? 0} cost lines, ${main.invoices ?? 0} invoices, and ${glLines} ledger lines across ${glAccounts} accounts.`,
      );
      router.refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="flex items-center gap-3">
      <button onClick={sync} disabled={busy} className={buttonCls("secondary")}>
        <RefreshCw
          size={15}
          strokeWidth={2}
          className={busy ? "animate-spin" : undefined}
        />
        {busy ? "Syncing…" : "Sync customers & jobs"}
      </button>
      {message && <span className="text-sm text-ink-600">{message}</span>}
    </span>
  );
}
