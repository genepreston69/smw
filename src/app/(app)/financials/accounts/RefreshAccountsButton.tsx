"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { buttonCls } from "@/components/ui";
import { refreshChartOfAccounts } from "./actions";

/**
 * Pulls the chart of accounts from QuickBooks (accounts only), then switches
 * the page to its New accounts view so additions can be categorized.
 */
export function RefreshAccountsButton({ newHref }: { newHref: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  const refresh = () => {
    setMessage(null);
    startTransition(async () => {
      const result = await refreshChartOfAccounts();
      if (!result.ok) {
        setMessage({ ok: false, text: result.error });
        return;
      }
      setMessage({
        ok: true,
        text:
          result.added === 0
            ? "No new accounts in QuickBooks."
            : `${result.added} new account${result.added === 1 ? "" : "s"} added.`,
      });
      router.push(newHref);
      router.refresh();
    });
  };

  return (
    <div className="flex items-center gap-3">
      {message && (
        <span
          role="status"
          className={`text-sm ${message.ok ? "text-ink-600" : "text-bad-600"}`}
        >
          {message.text}
        </span>
      )}
      <button
        type="button"
        onClick={refresh}
        disabled={pending}
        className={buttonCls("primary")}
      >
        <RefreshCw
          size={15}
          strokeWidth={2}
          className={pending ? "animate-spin" : undefined}
        />
        {pending ? "Refreshing…" : "Refresh from QuickBooks"}
      </button>
    </div>
  );
}
