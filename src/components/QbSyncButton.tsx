"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

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
      setMessage(`Imported ${json.customers} customers and ${json.jobs} jobs.`);
      router.refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="flex items-center gap-3">
      <button
        onClick={sync}
        disabled={busy}
        className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50"
      >
        {busy ? "Syncing…" : "Sync customers & jobs"}
      </button>
      {message && <span className="text-sm text-zinc-600">{message}</span>}
    </span>
  );
}
