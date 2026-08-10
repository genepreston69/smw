"use client";

import { useState } from "react";
import { Landmark, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { buttonCls } from "@/components/ui";

// Two separate sync sessions: customers/jobs/costs/invoices in one request,
// and the general-ledger import one company at a time (one invocation for
// everything exceeds Vercel's function window). Separate buttons keep each
// run short and let a failed ledger import be retried without redoing the
// main sync. They still share one busy flag: every sync refreshes the
// QuickBooks OAuth tokens and QBO rotates refresh tokens, so two runs at
// once could race the refresh and strand a connection.

export interface SyncCompany {
  realmId: string;
  label: string;
}

export function QbSyncButtons({ companies }: { companies: SyncCompany[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | "jobs" | "ledger">(null);
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

  async function syncJobs() {
    setBusy("jobs");
    setMessage("Importing customers, jobs, costs, and invoices…");
    try {
      const main = await post("/api/qb/sync");
      setMessage(
        `QuickBooks returned ${main.customers} customers and ${main.jobs} jobs across ${main.companies} ${main.companies === 1 ? "company" : "companies"}; Supabase now holds ${main.dbCustomers ?? main.customers} customers and ${main.dbJobs ?? main.jobs} jobs. Imported ${main.costLines ?? 0} cost lines and ${main.invoices ?? 0} invoices.`,
      );
      router.refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setBusy(null);
    }
  }

  async function syncLedger() {
    setBusy("ledger");
    setMessage(null);
    let glAccounts = 0;
    let glLines = 0;
    // One request per company; a failure skips to the next company instead
    // of aborting, so one slow ledger can't block the rest.
    const failed: string[] = [];
    for (const [i, c] of companies.entries()) {
      setMessage(
        `Importing general ledger: ${c.label} (${i + 1} of ${companies.length})…`,
      );
      try {
        const ledger = await post("/api/qb/sync-ledger", { realmId: c.realmId });
        glAccounts += ledger.glAccounts ?? 0;
        glLines += ledger.glLines ?? 0;
      } catch (e) {
        failed.push(`${c.label} — ${e instanceof Error ? e.message : "failed"}`);
      }
    }
    setMessage(
      `Imported ${glLines} ledger lines across ${glAccounts} accounts from ${companies.length - failed.length} of ${companies.length} ${companies.length === 1 ? "company" : "companies"}.${
        failed.length > 0
          ? ` Failed: ${failed.join("; ")}. Run "Sync general ledger" again to retry.`
          : ""
      }`,
    );
    router.refresh();
    setBusy(null);
  }

  return (
    <span className="flex flex-wrap items-center gap-3">
      <button
        onClick={syncJobs}
        disabled={busy !== null}
        className={buttonCls("secondary")}
      >
        <RefreshCw
          size={15}
          strokeWidth={2}
          className={busy === "jobs" ? "animate-spin" : undefined}
        />
        {busy === "jobs" ? "Syncing…" : "Sync customers & jobs"}
      </button>
      <button
        onClick={syncLedger}
        disabled={busy !== null}
        className={buttonCls("secondary")}
      >
        <Landmark
          size={15}
          strokeWidth={2}
          className={busy === "ledger" ? "animate-pulse" : undefined}
        />
        {busy === "ledger" ? "Importing…" : "Sync general ledger"}
      </button>
      {message && <span className="text-sm text-ink-600">{message}</span>}
    </span>
  );
}
