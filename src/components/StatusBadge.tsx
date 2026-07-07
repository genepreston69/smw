import { STATUS_LABELS, STATUS_STYLES } from "@/lib/format";

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[status] ?? "bg-zinc-100 text-zinc-700 border-zinc-200"}`}
    >
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}
