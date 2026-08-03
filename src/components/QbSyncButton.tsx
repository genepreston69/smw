"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { buttonCls } from "@/components/ui";

export function QbSyncButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function sync() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/qb/sync", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Sync failed");
      setMessage(
        `QuickBooks returned ${json.customers} customers and ${json.jobs} jobs across ${json.companies} ${json.companies === 1 ? "company" : "companies"}; Supabase now holds ${json.dbCustomers ?? json.customers} customers and ${json.dbJobs ?? json.jobs} jobs. Imported ${json.costLines ?? 0} cost lines, ${json.invoices ?? 0} invoices, and ${json.glLines ?? 0} ledger lines across ${json.glAccounts ?? 0} accounts.`,
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
