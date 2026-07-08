import { STATUS_LABELS } from "@/lib/format";

const STYLES: Record<string, { badge: string; dot: string }> = {
  draft: { badge: "bg-surface text-ink-600 border-line", dot: "bg-ink-400" },
  submitted: {
    badge: "bg-brand-50 text-brand-700 border-brand-500/25",
    dot: "bg-brand-500",
  },
  approved: {
    badge: "bg-ok-50 text-ok-600 border-ok-600/25",
    dot: "bg-ok-600",
  },
  rejected: {
    badge: "bg-bad-50 text-bad-600 border-bad-600/25",
    dot: "bg-bad-600",
  },
  changes_requested: {
    badge: "bg-warn-50 text-warn-700 border-warn-700/25",
    dot: "bg-warn-700",
  },
};

export function StatusBadge({ status }: { status: string }) {
  const s = STYLES[status] ?? STYLES.draft;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${s.badge}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

export function TbdBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="inline-flex items-center rounded-full border border-warn-700/25 bg-warn-50 px-2 py-0.5 text-xs font-medium text-warn-700">
      {count} TBD
    </span>
  );
}
