const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

const usdWhole = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

export function money(n: number | null | undefined): string {
  return usd.format(n ?? 0);
}

export function moneyWhole(n: number | null | undefined): string {
  return usdWhole.format(n ?? 0);
}

export function pct(n: number | null | undefined): string {
  return `${(((n ?? 0) as number) * 100).toFixed(1)}%`;
}

export function hours(n: number | null | undefined): string {
  return `${Number(n ?? 0).toLocaleString("en-US", { maximumFractionDigits: 1 })} hrs`;
}

export function shortDate(d: string | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  submitted: "Submitted",
  approved: "Approved",
  rejected: "Rejected",
  changes_requested: "Changes requested",
};

export const STATUS_STYLES: Record<string, string> = {
  draft: "bg-zinc-100 text-zinc-700 border-zinc-200",
  submitted: "bg-blue-50 text-blue-700 border-blue-200",
  approved: "bg-emerald-50 text-emerald-700 border-emerald-200",
  rejected: "bg-red-50 text-red-700 border-red-200",
  changes_requested: "bg-amber-50 text-amber-700 border-amber-200",
};

/**
 * Date + time in an explicit IANA timezone. Server components otherwise render
 * timestamps in the server's timezone (UTC on Vercel), which reads wrong for
 * anything scheduled in local time.
 */
export function dateTimeIn(
  d: string | null | undefined,
  timeZone: string,
): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
