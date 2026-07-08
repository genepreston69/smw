"use client";

import { useState } from "react";
import { Unlink } from "lucide-react";
import { useRouter } from "next/navigation";

export function QbDisconnectButton({
  realmId,
  companyLabel,
}: {
  realmId: string;
  companyLabel: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function disconnect() {
    if (
      !confirm(
        `Disconnect ${companyLabel}? The app's access is revoked at Intuit and you'll need to connect it again. Imported customers and jobs are kept.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/qb/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ realmId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Disconnect failed");
      router.refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Disconnect failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        onClick={disconnect}
        disabled={busy}
        title={`Disconnect ${companyLabel}`}
        className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-ink-600 transition-colors hover:border-bad-600/30 hover:bg-bad-50 hover:text-bad-600 disabled:opacity-50"
      >
        <Unlink size={12} strokeWidth={2} />
        {busy ? "Disconnecting…" : "Disconnect"}
      </button>
      {message && <span className="text-xs text-bad-600">{message}</span>}
    </span>
  );
}
