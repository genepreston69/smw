"use client";

import { useState } from "react";
import { Unlink } from "lucide-react";
import { useRouter } from "next/navigation";
import { buttonCls } from "@/components/ui";

export function QbDisconnectButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function disconnect() {
    if (
      !confirm(
        "Disconnect QuickBooks? The app's access is revoked at Intuit and you'll need to connect again. Imported customers and jobs are kept.",
      )
    ) {
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/qb/disconnect", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Disconnect failed");
      setMessage("Disconnected. You can now connect fresh.");
      router.refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Disconnect failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="flex items-center gap-3">
      <button
        onClick={disconnect}
        disabled={busy}
        className={buttonCls("secondary")}
      >
        <Unlink size={15} strokeWidth={2} />
        {busy ? "Disconnecting…" : "Disconnect"}
      </button>
      {message && <span className="text-sm text-ink-600">{message}</span>}
    </span>
  );
}
