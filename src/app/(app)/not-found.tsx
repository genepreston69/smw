import Link from "next/link";
import { SearchX } from "lucide-react";
import { buttonCls } from "@/components/ui";

// Shown inside the app shell for a missing record (a deleted plan or quote, a
// mistyped link) instead of the framework's bare 404.
export default function AppNotFound() {
  return (
    <div className="mx-auto mt-16 max-w-lg rounded-xl border border-line bg-white p-8 text-center shadow-[0_1px_2px_rgba(13,36,56,0.05)]">
      <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-surface text-ink-600">
        <SearchX size={20} strokeWidth={2} />
      </span>
      <h1 className="mt-4 text-lg font-semibold text-ink-900">Not found</h1>
      <p className="mt-2 text-sm text-ink-600">
        This page or record doesn&rsquo;t exist. It may have been deleted, or
        the link may be wrong.
      </p>
      <div className="mt-6">
        <Link href="/" className={buttonCls("primary")}>
          Go to Dashboard
        </Link>
      </div>
    </div>
  );
}
