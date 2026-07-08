"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";

export function DeleteRowButton({
  action,
  confirmText,
  title = "Delete",
}: {
  action: () => Promise<{ ok: boolean; error?: string }>;
  confirmText: string;
  title?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <button
      onClick={() => {
        if (!window.confirm(confirmText)) return;
        startTransition(async () => {
          const res = await action();
          if (!res.ok) window.alert(res.error ?? "Delete failed");
          else router.refresh();
        });
      }}
      disabled={pending}
      title={title}
      className="rounded-md border border-line p-1.5 text-ink-400 transition-colors hover:border-bad-600/30 hover:bg-bad-50 hover:text-bad-600 disabled:opacity-40"
    >
      <Trash2 size={13} strokeWidth={2} />
    </button>
  );
}
