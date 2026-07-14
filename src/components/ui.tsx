import Link from "next/link";
import type { LucideIcon } from "lucide-react";

/* ---------------------------------------------------------------------------
   Shared UI primitives — the SMW design system in component form.
--------------------------------------------------------------------------- */

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-[1.6rem] font-semibold tracking-tight text-ink-900">
          {title}
        </h1>
        {subtitle && <p className="mt-1 text-sm text-ink-600">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function Card({
  children,
  className = "",
  pad = true,
  clip = true,
}: {
  children: React.ReactNode;
  className?: string;
  pad?: boolean;
  /**
   * Unpadded cards clip children to the rounded border. Turn off for
   * sticky-header tables — an overflow-hidden ancestor keeps
   * position: sticky from ever sticking.
   */
  clip?: boolean;
}) {
  return (
    <section
      className={`rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(13,36,56,0.05)] ${pad ? "p-6" : clip ? "overflow-hidden" : ""} ${className}`}
    >
      {children}
    </section>
  );
}

export function CardTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-4 text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
      {children}
    </h2>
  );
}

export function StatTile({
  label,
  value,
  hint,
  href,
  icon: Icon,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  href?: string;
  icon?: LucideIcon;
}) {
  const body = (
    <div className="flex items-start justify-between">
      <div>
        <p className="text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
          {label}
        </p>
        <p className="mt-2 text-[2rem] font-semibold leading-none tracking-tight tabular-nums text-ink-900">
          {value}
        </p>
        {hint && <p className="mt-2 text-sm text-ink-600">{hint}</p>}
      </div>
      {Icon && (
        <span className="rounded-lg bg-brand-50 p-2 text-brand-600">
          <Icon size={18} strokeWidth={1.75} />
        </span>
      )}
    </div>
  );
  if (href) {
    return (
      <Link
        href={href}
        className="rounded-xl border border-line bg-white p-5 shadow-[0_1px_2px_rgba(13,36,56,0.05)] transition-colors hover:border-brand-500/40"
      >
        {body}
      </Link>
    );
  }
  return (
    <div className="rounded-xl border border-line bg-white p-5 shadow-[0_1px_2px_rgba(13,36,56,0.05)]">
      {body}
    </div>
  );
}

const BUTTON_VARIANTS = {
  primary:
    "bg-brand-600 text-white hover:bg-brand-700 disabled:hover:bg-brand-600",
  dark: "bg-navy-900 text-white hover:bg-navy-700 disabled:hover:bg-navy-900",
  secondary:
    "border border-line bg-white text-ink-900 hover:bg-surface disabled:hover:bg-white",
  success: "bg-ok-600 text-white hover:opacity-90",
  danger: "bg-bad-600 text-white hover:opacity-90",
  warn: "bg-warn-700 text-white hover:opacity-90",
} as const;

export function buttonCls(
  variant: keyof typeof BUTTON_VARIANTS = "primary",
  size: "sm" | "md" = "md",
) {
  return `inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:opacity-45 disabled:cursor-not-allowed ${
    size === "sm" ? "px-3 py-1.5 text-xs" : "px-4 py-2 text-sm"
  } ${BUTTON_VARIANTS[variant]}`;
}

export function Table({
  head,
  children,
  minWidth,
  stickyHeader,
}: {
  head: React.ReactNode;
  children: React.ReactNode;
  minWidth?: string;
  /**
   * Freeze the header row to the top of the viewport while the page
   * scrolls (Excel freeze panes). Requires an unclipped ancestor chain
   * (Card clip={false}), so the sticky variant drops the overflow-x
   * wrapper — that wrapper would become the scroll container and the
   * header would never stick. The stuck header needs an opaque
   * background, and its border-bottom is drawn as a shadow because
   * collapsed table borders don't travel with a sticky header.
   */
  stickyHeader?: boolean;
}) {
  const table = (
    <table className={`w-full text-sm ${minWidth ?? ""}`}>
      <thead
        className={`text-left text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-ink-400 ${
          stickyHeader
            ? "sticky top-0 z-10 bg-surface shadow-[0_1px_0_0_var(--color-line)] [&_th:first-child]:rounded-tl-xl [&_th:last-child]:rounded-tr-xl"
            : "border-b border-line bg-surface/70"
        }`}
      >
        {head}
      </thead>
      <tbody className="divide-y divide-line/70">{children}</tbody>
    </table>
  );
  return stickyHeader ? table : <div className="overflow-x-auto">{table}</div>;
}

export function Th({
  children,
  right,
  className = "",
}: {
  children?: React.ReactNode;
  right?: boolean;
  className?: string;
}) {
  return (
    <th className={`px-4 py-2.5 ${right ? "text-right" : ""} ${className}`}>
      {children}
    </th>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  children,
}: {
  icon?: LucideIcon;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
      {Icon && (
        <span className="mb-1 rounded-full bg-surface p-3 text-ink-400">
          <Icon size={22} strokeWidth={1.5} />
        </span>
      )}
      <p className="text-sm font-medium text-ink-900">{title}</p>
      {children && <div className="text-sm text-ink-600">{children}</div>}
    </div>
  );
}

export function Alert({
  tone,
  children,
}: {
  tone: "ok" | "bad" | "info";
  children: React.ReactNode;
}) {
  const cls =
    tone === "ok"
      ? "border-ok-600/25 bg-ok-50 text-ok-600"
      : tone === "bad"
        ? "border-bad-600/25 bg-bad-50 text-bad-600"
        : "border-brand-500/25 bg-brand-50 text-brand-700";
  return (
    <div className={`rounded-lg border px-4 py-2.5 text-sm ${cls}`}>
      {children}
    </div>
  );
}
