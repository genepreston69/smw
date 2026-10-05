/* ---------------------------------------------------------------------------
   Already Capitalized (/capitalized-labor/already-capitalized): the schedule
   of journal entries that moved direct labor to an asset account. Which
   entries and lines count is decided in SQL by capitalized_labor_entries
   (migration 0032): an entry that debits a Fixed Asset / Other Asset account
   and, net, credits labor (wages or the employer's share of payroll taxes —
   cap_labor_account). This module only shapes those lines into the
   schedule, so the page and its Excel export
   (src/app/api/export/already-capitalized/) always agree.
--------------------------------------------------------------------------- */

export type CapEntryLineKind = "asset" | "labor" | "other";

export const CAP_LINE_KIND_LABELS: Record<CapEntryLineKind, string> = {
  asset: "Asset",
  labor: "Labor",
  other: "Other",
};

/** One ledger line of a capitalization entry. Amounts are natural-signed:
    an asset debit is positive, a labor credit negative. */
export interface CapEntryLine {
  realmId: string;
  qbTxnId: string;
  date: string;
  docNumber: string | null;
  account: string;
  accountType: string | null;
  classification: string | null;
  kind: CapEntryLineKind;
  customer: string | null;
  memo: string | null;
  amount: number;
}

export interface CapEntry {
  key: string;
  realmId: string;
  qbTxnId: string;
  date: string;
  docNumber: string | null;
  memo: string | null;
  /** Jobs (customers) on the entry's labor lines, else on any line. */
  jobs: string[];
  /** Asset accounts debited, largest first. */
  assets: { account: string; amount: number }[];
  /** Labor capitalized per labor account (positive = moved off labor). */
  laborAccounts: { account: string; amount: number }[];
  /** Net labor capitalized by the entry (positive). */
  labor: number;
  /** Total debited to capital assets. */
  assetDebit: number;
  lines: CapEntryLine[];
}

export interface CapByAsset {
  realmId: string;
  account: string;
  entries: number;
  /** Labor capitalized into this asset (pro-rata when an entry debits
      several assets). */
  labor: number;
}

export interface CapSchedule {
  entries: CapEntry[];
  byAsset: CapByAsset[];
  total: number;
  jobCount: number;
}

/** The compact JSON lines capitalized_labor_entries returns. */
export function parseCapLines(json: unknown): CapEntryLine[] {
  const rows =
    ((json ?? {}) as { lines?: unknown[][] }).lines ?? [];
  return rows.map((r) => ({
    realmId: String(r[0]),
    qbTxnId: String(r[1]),
    date: String(r[2]),
    docNumber: (r[3] as string | null) ?? null,
    account: String(r[4] ?? ""),
    accountType: (r[5] as string | null) ?? null,
    classification: (r[10] as string | null) ?? null,
    kind: (r[6] as CapEntryLineKind) ?? "other",
    customer: (r[7] as string | null) || null,
    memo: (r[8] as string | null) || null,
    amount: Number(r[9] ?? 0),
  }));
}

/**
 * Debit or credit for a natural-signed ledger amount: positive increases the
 * account in its normal direction, which is a debit for assets and expenses
 * and a credit for liabilities, equity and revenue. Lines whose account has
 * no classification are read as debit-normal.
 */
export function capLineSide(l: Pick<CapEntryLine, "classification" | "amount">): {
  debit: number;
  credit: number;
} {
  const creditNormal = ["Liability", "Equity", "Revenue"].includes(l.classification ?? "");
  const isDebit = creditNormal ? l.amount < 0 : l.amount > 0;
  const abs = Math.abs(l.amount);
  return isDebit ? { debit: abs, credit: 0 } : { debit: 0, credit: abs };
}

const sumBy = (rows: { account: string; amount: number }[]) => {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.account, (m.get(r.account) ?? 0) + r.amount);
  return [...m].map(([account, amount]) => ({ account, amount }));
};

/**
 * Groups lines into entries (newest first, as the SQL orders them) and rolls
 * the labor up by asset account. An entry that debits several assets splits
 * its labor across them in proportion to each asset's debit — the ledger
 * doesn't say which credit funded which debit.
 */
export function assembleCapSchedule(lines: CapEntryLine[]): CapSchedule {
  const byKey = new Map<string, CapEntryLine[]>();
  for (const l of lines) {
    const key = `${l.realmId}:${l.qbTxnId}`;
    const group = byKey.get(key);
    if (group) group.push(l);
    else byKey.set(key, [l]);
  }

  const entries: CapEntry[] = [];
  for (const [key, group] of byKey) {
    const first = group[0];
    const assets = sumBy(
      group.filter((l) => l.kind === "asset" && l.amount > 0),
    ).sort((a, b) => b.amount - a.amount);
    const laborAccounts = sumBy(
      group
        .filter((l) => l.kind === "labor")
        .map((l) => ({ account: l.account, amount: -l.amount })),
    ).sort((a, b) => b.amount - a.amount);
    const laborJobs = group.filter((l) => l.kind === "labor" && l.customer);
    const jobs = [
      ...new Set((laborJobs.length ? laborJobs : group).map((l) => l.customer).filter(Boolean)),
    ] as string[];
    entries.push({
      key,
      realmId: first.realmId,
      qbTxnId: first.qbTxnId,
      date: first.date,
      docNumber: first.docNumber,
      memo: group.find((l) => l.memo)?.memo ?? null,
      jobs,
      assets,
      laborAccounts,
      labor: laborAccounts.reduce((s, a) => s + a.amount, 0),
      assetDebit: assets.reduce((s, a) => s + a.amount, 0),
      lines: group,
    });
  }

  const assetMap = new Map<string, CapByAsset>();
  for (const e of entries) {
    for (const a of e.assets) {
      const k = `${e.realmId}:${a.account}`;
      let row = assetMap.get(k);
      if (!row) {
        row = { realmId: e.realmId, account: a.account, entries: 0, labor: 0 };
        assetMap.set(k, row);
      }
      row.entries += 1;
      row.labor += e.assetDebit > 0 ? (e.labor * a.amount) / e.assetDebit : 0;
    }
  }
  const byAsset = [...assetMap.values()].sort(
    (a, b) => b.labor - a.labor || a.account.localeCompare(b.account),
  );

  return {
    entries,
    byAsset,
    total: entries.reduce((s, e) => s + e.labor, 0),
    jobCount: new Set(entries.flatMap((e) => e.jobs)).size,
  };
}

/* ---------------------------------------------------------------------------
   Years. The ledger reaches back to Jan 1 2023 (frozen audited history,
   migration 0020); the current year runs through today. Dates are UTC like
   the database.
--------------------------------------------------------------------------- */

export const ALREADY_CAPITALIZED_FIRST_YEAR = 2023;

export function capScheduleYears(now: Date = new Date()): number[] {
  const last = now.getUTCFullYear();
  return Array.from(
    { length: last - ALREADY_CAPITALIZED_FIRST_YEAR + 1 },
    (_, i) => last - i,
  );
}

export function capScheduleWindow(
  year: number,
  now: Date = new Date(),
): { year: number; from: string; to: string; label: string } {
  const current = year === now.getUTCFullYear();
  return {
    year,
    from: `${year}-01-01`,
    to: current ? now.toISOString().slice(0, 10) : `${year}-12-31`,
    label: current ? `${year} year to date` : String(year),
  };
}

/** The year a request asked for, if it is one the schedule covers; else
    the current year. */
export function capScheduleYear(param: string | undefined, now: Date = new Date()): number {
  const y = Number(param);
  return capScheduleYears(now).includes(y) ? y : now.getUTCFullYear();
}
