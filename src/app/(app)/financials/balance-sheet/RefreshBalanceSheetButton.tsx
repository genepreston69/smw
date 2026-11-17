"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { buttonCls } from "@/components/ui";
import { refreshBalanceSheet } from "./actions";

/** Pulls the prior month end's balance sheet from QuickBooks now, for every
    connected company, then shows it. */
export function RefreshBalanceSheetButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    setError(null);
    startTransition(async () => {
      const result = await refreshBalanceSheet();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push("/financials/balance-sheet");
      router.refresh();
    });
  };

  return (
    <div className="flex items-center gap-3">
      {error && (
        <span role="status" className="max-w-md text-sm text-bad-600">
          {error}
        </span>
      )}
      <button
        type="button"
        onClick={refresh}
        disabled={pending}
        className={buttonCls("secondary")}
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
