"use client"; // Error boundaries must be Client Components

import { useEffect } from "react";
import Link from "next/link";
import { RotateCw, TriangleAlert } from "lucide-react";
import { buttonCls } from "@/components/ui";

// The error card shown when a page throws: a query that failed or timed out,
// or anything unexpected. Without it the user gets the framework's bare error
// screen — or, worse, a page that swallowed the failure and rendered as if
// there were no data. Used by both error boundaries: src/app/(app)/error.tsx
// (inside the app shell, sidebar stays) and src/app/error.tsx (when the shell
// itself can't load, e.g. the signed-in user's profile read failed).
export function PageError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto mt-16 max-w-lg rounded-xl border border-line bg-white p-8 text-center shadow-[0_1px_2px_rgba(13,36,56,0.05)]">
      <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-bad-50 text-bad-600">
        <TriangleAlert size={20} strokeWidth={2} />
      </span>
      <h1 className="mt-4 text-lg font-semibold text-ink-900">
        This page couldn&rsquo;t load
      </h1>
      <p className="mt-2 text-sm text-ink-600">
        The data behind it didn&rsquo;t come back, so nothing is shown rather
        than numbers that might be incomplete. Nothing was changed or lost.
        This is usually temporary — try again, and narrow the date range if a
        large report keeps timing out.
      </p>
      <div className="mt-6 flex items-center justify-center gap-3">
        <button onClick={() => unstable_retry()} className={buttonCls("primary")}>
          <RotateCw size={15} strokeWidth={2} />
          Try again
        </button>
        <Link href="/" className={buttonCls("secondary")}>
          Go to Dashboard
        </Link>
      </div>
      {error.digest && (
        <p className="mt-6 text-xs text-ink-400">
          If it keeps happening, send this reference to support: {error.digest}
        </p>
      )}
    </div>
  );
}
