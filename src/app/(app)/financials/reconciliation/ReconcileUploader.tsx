"use client";

import { useRef, useState, useTransition } from "react";
import {
  CheckCircle2,
  CircleAlert,
  Download,
  FileSpreadsheet,
  Loader2,
  Scale,
} from "lucide-react";
import { money, moneyWhole } from "@/lib/format";
import { monthLabel } from "@/lib/financials";
import {
  RECON_STATUS_LABELS,
  type AccountRecon,
  type ReconciliationResult,
} from "@/lib/reconciliation";
import { Alert, Card, EmptyState, StatTile, Table, Th, buttonCls } from "@/components/ui";
import { reconcileQbExport } from "./actions";

const STATUS_CLS: Record<AccountRecon["status"], string> = {
  tied: "bg-ok-50 text-ok-600 border-ok-600/25",
  variance: "bg-bad-50 text-bad-600 border-bad-600/25",
  qb_only: "bg-warn-50 text-warn-700 border-warn-700/25",
  gl_only: "bg-warn-50 text-warn-700 border-warn-700/25",
};

const shortDate = (iso: string): string => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${d}, ${y}`;
};

export function ReconcileUploader() {
  const fileInput = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReconciliationResult | null>(null);
  const [onlyDiffs, setOnlyDiffs] = useState(true);
  const [pending, startTransition] = useTransition();
  const [exporting, setExporting] = useState(false);

  const run = () => {
    const file = fileInput.current?.files?.[0];
    if (!file) {
      setError("Choose the QuickBooks Excel export first");
      return;
    }
    setError(null);
    const formData = new FormData();
    formData.set("file", file);
    startTransition(async () => {
      const res = await reconcileQbExport(formData);
      if (res.ok) {
        setResult(res.result);
        setError(null);
      } else {
        setError(res.error);
      }
    });
  };

  // The Excel export re-uploads the same file to /api/export/reconciliation,
  // which runs the identical shared pipeline — the workbook always matches
  // the tie-out on screen.
  const exportExcel = async () => {
    const file = fileInput.current?.files?.[0];
    if (!file || !result) {
      setError("Choose the QuickBooks export and reconcile first");
      return;
    }
    setExporting(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.set("file", file);
      const res = await fetch("/api/export/reconciliation", {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(data?.error ?? "Export failed");
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `reconciliation-${result.period.start}-to-${result.period.end}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting(false);
    }
  };

  const amount = (v: number, bold = false) => (
    <td
      className={`whitespace-nowrap px-4 py-2 text-right tabular-nums ${
        bold ? "font-semibold" : ""
      } ${v < -0.005 ? "text-bad-600" : "text-ink-900"}`}
    >
      {Math.abs(v) <= 0.005 ? <span className="text-ink-400">—</span> : money(v)}
    </td>
  );

  const diffCell = (v: number, bold = false) => (
    <td
      className={`whitespace-nowrap px-4 py-2 text-right tabular-nums ${
        bold ? "font-semibold" : ""
      } ${Math.abs(v) <= 0.005 ? "text-ink-400" : "text-bad-600 font-medium"}`}
    >
      {Math.abs(v) <= 0.005 ? "—" : money(v)}
    </td>
  );

  const statusPill = (status: AccountRecon["status"]) => (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_CLS[status]}`}
    >
      {status === "tied" ? (
        <CheckCircle2 size={12} strokeWidth={2} />
      ) : (
        <CircleAlert size={12} strokeWidth={2} />
      )}
      {RECON_STATUS_LABELS[status]}
    </span>
  );

  const netTied = result ? Math.abs(result.netIncome.diff) <= 0.005 : false;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <label
            className={`${buttonCls("secondary")} cursor-pointer`}
            htmlFor="qb-pl-file"
          >
            <FileSpreadsheet size={15} strokeWidth={2} />
            {fileName ?? "Choose QuickBooks export…"}
          </label>
          <input
            id="qb-pl-file"
            ref={fileInput}
            type="file"
            accept=".xlsx"
            className="sr-only"
            onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
          />
          <button
            type="button"
            onClick={run}
            disabled={pending}
            className={buttonCls("primary")}
          >
            {pending ? (
              <Loader2 size={15} strokeWidth={2} className="animate-spin" />
            ) : (
              <Scale size={15} strokeWidth={2} />
            )}
            {pending ? "Reconciling…" : "Reconcile"}
          </button>
          {result && (
            <button
              type="button"
              onClick={exportExcel}
              disabled={exporting}
              className={buttonCls("secondary")}
            >
              {exporting ? (
                <Loader2 size={15} strokeWidth={2} className="animate-spin" />
              ) : (
                <Download size={15} strokeWidth={2} />
              )}
              {exporting ? "Exporting…" : "Export Excel"}
            </button>
          )}
          <p className="text-sm text-ink-600">
            In QuickBooks, run <span className="font-medium">Reports → Profit
            and Loss</span> (the consolidated view across all companies),
            display columns by <span className="font-medium">month</span>, and
            export to Excel. Upload that file here unchanged. Reconciliation
            runs through the last complete month — a current-month column in
            the export is excluded automatically.
          </p>
        </div>
        {error && (
          <div className="mt-3">
            <Alert tone="bad">{error}</Alert>
          </div>
        )}
      </Card>

      {result && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile
              label="QuickBooks net income"
              value={moneyWhole(result.netIncome.qb)}
              hint={`${shortDate(result.period.start)} – ${shortDate(result.period.end)}`}
            />
            <StatTile
              label="Imported GL net income"
              value={moneyWhole(result.netIncome.gl)}
              hint="From gl_lines for the same period"
            />
            <StatTile
              label="Difference"
              value={
                <span className={netTied ? "text-ok-600" : "text-bad-600"}>
                  {netTied ? "$0" : money(result.netIncome.diff)}
                </span>
              }
              hint={netTied ? "Ties to QuickBooks" : "QuickBooks minus imported GL"}
              icon={netTied ? CheckCircle2 : CircleAlert}
            />
            <StatTile
              label="Accounts"
              value={`${result.summary.tied} / ${
                result.summary.tied +
                result.summary.variance +
                result.summary.qbOnly +
                result.summary.glOnly
              }`}
              hint={`tied · ${result.summary.variance} with variances · ${
                result.summary.qbOnly + result.summary.glOnly
              } unmatched`}
            />
          </div>

          {result.warnings.length > 0 && (
            <Alert tone="info">
              <ul className="list-disc pl-4">
                {result.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Alert>
          )}

          <Card pad={false}>
            <div className="flex items-center justify-between border-b border-line/70 px-4 py-2.5">
              <p className="text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
                Account tie-out by section
              </p>
              <label className="flex items-center gap-2 text-sm text-ink-600">
                <input
                  type="checkbox"
                  checked={onlyDiffs}
                  onChange={(e) => setOnlyDiffs(e.target.checked)}
                  className="h-4 w-4 rounded border-line accent-brand-600"
                />
                Only differences
              </label>
            </div>
            {onlyDiffs &&
            result.sections.every((s) =>
              s.rows.every((r) => r.status === "tied"),
            ) ? (
              <EmptyState icon={CheckCircle2} title="Everything ties">
                Every account in the export matches the imported general
                ledger to the cent.
              </EmptyState>
            ) : (
              <Table
                head={
                  <tr>
                    <Th>Account</Th>
                    <Th right>QuickBooks</Th>
                    <Th right>Imported GL</Th>
                    <Th right>Difference</Th>
                    <Th className="pl-6">Status</Th>
                  </tr>
                }
              >
                {result.sections.map((section) => {
                  const rows = onlyDiffs
                    ? section.rows.filter((r) => r.status !== "tied")
                    : section.rows;
                  if (rows.length === 0) return null;
                  return (
                    <SectionRows
                      key={section.label}
                      section={{ ...section, rows }}
                      amount={amount}
                      diffCell={diffCell}
                      statusPill={statusPill}
                    />
                  );
                })}
                <tr className="bg-surface">
                  <td className="px-4 py-2 font-semibold text-ink-900">
                    Net income
                  </td>
                  {amount(result.netIncome.qb, true)}
                  {amount(result.netIncome.gl, true)}
                  {diffCell(result.netIncome.diff, true)}
                  <td className="px-4 py-2 pl-6">
                    {statusPill(netTied ? "tied" : "variance")}
                  </td>
                </tr>
              </Table>
            )}
          </Card>
          <p className="text-xs text-ink-400">
            Amounts follow the QuickBooks Profit and Loss convention: income
            and expenses both positive, difference = QuickBooks − imported GL.
            &ldquo;Missing from GL&rdquo; accounts are in the export but have
            no imported ledger activity for the period; &ldquo;Not in
            export&rdquo; is the reverse. If recent months don&rsquo;t tie,
            run a QuickBooks sync in Settings first — the ledger here is only
            as fresh as the last import.
          </p>
        </>
      )}
    </div>
  );
}

function SectionRows({
  section,
  amount,
  diffCell,
  statusPill,
}: {
  section: {
    label: string;
    rows: AccountRecon[];
    qbTotal: number;
    glTotal: number;
    diff: number;
  };
  amount: (v: number, bold?: boolean) => React.ReactNode;
  diffCell: (v: number, bold?: boolean) => React.ReactNode;
  statusPill: (status: AccountRecon["status"]) => React.ReactNode;
}) {
  return (
    <>
      <tr className="bg-surface/50">
        <td
          colSpan={5}
          className="px-4 py-1.5 text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-ink-400"
        >
          {section.label}
        </td>
      </tr>
      {section.rows.map((r) => (
        <FragmentRow
          key={`${section.label}|${r.account}|${r.status}`}
          row={r}
          amount={amount}
          diffCell={diffCell}
          statusPill={statusPill}
        />
      ))}
      <tr className="bg-surface/30">
        <td className="px-4 py-2 font-medium text-ink-700">
          Total {section.label}
        </td>
        {amount(section.qbTotal, true)}
        {amount(section.glTotal, true)}
        {diffCell(section.diff, true)}
        <td />
      </tr>
    </>
  );
}

function FragmentRow({
  row,
  amount,
  diffCell,
  statusPill,
}: {
  row: AccountRecon;
  amount: (v: number, bold?: boolean) => React.ReactNode;
  diffCell: (v: number, bold?: boolean) => React.ReactNode;
  statusPill: (status: AccountRecon["status"]) => React.ReactNode;
}) {
  return (
    <>
      <tr className="hover:bg-surface/50">
        <td className="max-w-[26rem] truncate px-4 py-2 text-ink-900" title={row.account}>
          {row.account}
        </td>
        {amount(row.qbTotal)}
        {amount(row.glTotal)}
        {diffCell(row.diff)}
        <td className="whitespace-nowrap px-4 py-2 pl-6">{statusPill(row.status)}</td>
      </tr>
      {row.monthDiffs.length > 0 && (
        <tr className="bg-bad-50/40">
          <td colSpan={5} className="px-4 pb-2.5 pt-0.5">
            <div className="flex flex-wrap gap-1.5 pl-4">
              {row.monthDiffs.map((m) => (
                <span
                  key={m.key}
                  className="inline-flex items-center gap-1.5 rounded-md border border-line bg-white px-2 py-1 text-xs tabular-nums text-ink-600"
                >
                  <span className="font-medium text-ink-900">
                    {monthLabel(m.key)}
                  </span>
                  QB {money(m.qb)} · GL {money(m.gl)} ·{" "}
                  <span className="font-medium text-bad-600">
                    Δ {money(m.diff)}
                  </span>
                </span>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
