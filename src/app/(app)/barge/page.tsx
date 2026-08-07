import Link from "next/link";
import { Anchor, BookOpen, Calculator, ChevronDown, Plus } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { moneyWhole, shortDate } from "@/lib/format";
import { StatusBadge } from "@/components/StatusBadge";
import { DeleteRowButton } from "@/components/DeleteRowButton";
import { BargeProgramPlanner } from "@/components/barge/BargeProgramPlanner";
import {
  createBargeQuote,
  createBargeQuoteFromSavedConfig,
  deleteBargeConfig,
  deleteBargeQuote,
} from "./actions";
import {
  Card,
  CardTitle,
  EmptyState,
  PageHeader,
  Table,
  Th,
  buttonCls,
} from "@/components/ui";
import { BARGE_TEMPLATES, type BargeConfig, type BargeQuoteTotals } from "@/lib/barge";
import type { PlanStatus } from "@/lib/types";

interface QuoteRow {
  id: string;
  name: string;
  status: PlanStatus;
  version: number;
  updated_at: string;
  created_by: string;
  customer: { display_name: string } | null;
  creator: { full_name: string | null; email: string | null } | null;
}

export default async function BargeProgramPage() {
  const { supabase, profile } = await requireUser();
  const isAdmin = profile.role === "admin";

  const [{ data: quoteRows }, { data: configRows }] = await Promise.all([
    supabase
      .from("barge_quotes")
      .select(
        "id, name, status, version, updated_at, created_by, customer:customers(display_name), creator:profiles!barge_quotes_created_by_fkey(full_name, email)",
      )
      .order("updated_at", { ascending: false }),
    supabase
      .from("barge_configs")
      .select("*")
      .order("updated_at", { ascending: false }),
  ]);

  const quotes = (quoteRows ?? []) as unknown as QuoteRow[];
  const configs = (configRows ?? []) as BargeConfig[];

  const quoteIds = quotes.map((q) => q.id);
  const { data: totalsRows } = quoteIds.length
    ? await supabase
        .from("barge_quote_totals")
        .select("*")
        .in("quote_id", quoteIds)
    : { data: [] };
  const totals = new Map(
    (totalsRows ?? []).map((t) => [t.quote_id as string, t as BargeQuoteTotals]),
  );

  const marginTone = (pct: number) =>
    pct < 0
      ? "border-bad-600/25 bg-bad-50 text-bad-600"
      : pct < 0.1
        ? "border-warn-700/25 bg-warn-50 text-warn-700"
        : "border-ok-600/25 bg-ok-50 text-ok-600";

  return (
    <div>
      <PageHeader
        title="Barge Program"
        subtitle="Component-level takeoff quotes for new-build deck barges, with the same approval workflow as job plans. Margins shown are direct contribution."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/barge/manual"
              title="Printable instruction manual for the Barge Program"
              className={buttonCls("secondary")}
            >
              <BookOpen size={16} strokeWidth={2} />
              Instruction manual
            </Link>
            <Link href="/barge/rough" className={buttonCls("secondary")}>
              <Calculator size={16} strokeWidth={2} />
              Rough quote builder
            </Link>
            <details className="group relative">
              <summary className={`${buttonCls("primary")} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}>
                <Plus size={16} strokeWidth={2} />
                New quote
                <ChevronDown size={14} strokeWidth={2} />
              </summary>
              <div className="absolute right-0 z-20 mt-2 max-h-[70vh] w-80 overflow-y-auto rounded-xl border border-line bg-white p-2 shadow-lg">
                {BARGE_TEMPLATES.map((t) => (
                  <form key={t.key} action={createBargeQuote}>
                    <input type="hidden" name="template" value={t.key} />
                    <button
                      type="submit"
                      className="w-full rounded-lg px-3 py-2 text-left transition-colors hover:bg-surface"
                    >
                      <span className="block text-sm font-medium text-ink-900">
                        {t.name}
                      </span>
                      <span className="mt-0.5 block text-xs text-ink-600">
                        {t.description}
                      </span>
                    </button>
                  </form>
                ))}
                {configs.length > 0 && (
                  <div className="mt-1 border-t border-line pt-1">
                    <p className="px-3 py-1.5 text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
                      From saved configuration
                    </p>
                    {configs.map((c) => (
                      <form key={c.id} action={createBargeQuoteFromSavedConfig}>
                        <input type="hidden" name="config_id" value={c.id} />
                        <button
                          type="submit"
                          className="w-full rounded-lg px-3 py-2 text-left transition-colors hover:bg-surface"
                        >
                          <span className="block text-sm font-medium text-ink-900">
                            {c.name}
                          </span>
                          <span className="mt-0.5 block text-xs tabular-nums text-ink-600">
                            {Number(c.length_ft)}&prime; × {Number(c.beam_ft)}
                            &prime; × {Number(c.depth_ft)}&prime; ·{" "}
                            {c.spud_wells} wells · $
                            {Number(c.steel_per_lb).toFixed(2)}/lb ·{" "}
                            {Number(c.hours_per_ton)} hrs/ton
                          </span>
                        </button>
                      </form>
                    ))}
                  </div>
                )}
              </div>
            </details>
          </div>
        }
      />

      <Card pad={false} className="mb-6">
        {quotes.length === 0 ? (
          <EmptyState icon={Anchor} title="No barge quotes yet">
            Start from the rough quote builder, or create one from the engineer
            or yard reference takeoffs.
          </EmptyState>
        ) : (
          <Table
            head={
              <tr>
                <Th>Quote</Th>
                <Th>Customer</Th>
                <Th>Status</Th>
                <Th right>Net tons</Th>
                <Th right>Hours</Th>
                <Th right>Direct cost</Th>
                <Th right>Price</Th>
                <Th right>Margin</Th>
                <Th right>Updated</Th>
                <Th right />
              </tr>
            }
          >
            {quotes.map((q) => {
              const t = totals.get(q.id);
              const marginPct = Number(t?.direct_margin_pct ?? 0);
              return (
                <tr key={q.id} className="transition-colors hover:bg-surface/60">
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-2">
                      <Link
                        href={`/barge/${q.id}`}
                        className="font-medium text-ink-900 hover:text-brand-600"
                      >
                        {q.name}
                      </Link>
                      {q.version > 1 && (
                        <span className="text-xs text-ink-400">v{q.version}</span>
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-ink-600">
                    {q.customer?.display_name ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={q.status} />
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {Number(t?.net_tons ?? 0).toFixed(0)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {Number(t?.total_hours ?? 0).toLocaleString("en-US")}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {moneyWhole(Number(t?.direct_cost ?? 0))}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {moneyWhole(Number(t?.sales_price ?? 0))}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span
                      className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium tabular-nums ${marginTone(marginPct)}`}
                    >
                      {(marginPct * 100).toFixed(1)}%
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-ink-400">
                    {shortDate(q.updated_at)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {(isAdmin ||
                      (q.created_by === profile.id && q.status === "draft")) && (
                      <DeleteRowButton
                        action={deleteBargeQuote.bind(null, q.id)}
                        confirmText={`Delete "${q.name}"? This permanently removes the quote, its takeoff, and its approval history.`}
                        title="Delete quote"
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card pad={false} clip={false}>
          <div className="flex items-start justify-between px-6 pt-6">
            <CardTitle>Saved configurations</CardTitle>
            <Link href="/barge/rough" className={buttonCls("secondary", "sm")}>
              <Plus size={13} strokeWidth={2} />
              New configuration
            </Link>
          </div>
          {configs.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-ink-600">
              Dimension &amp; rate sets saved from the configuration builder
              land here, and appear as choices under &ldquo;New quote&rdquo;.
            </p>
          ) : (
            <Table
              head={
                <tr>
                  <Th>Configuration</Th>
                  <Th>Dimensions</Th>
                  <Th right>Steel $/lb</Th>
                  <Th right>Hrs/ton</Th>
                  <Th right />
                </tr>
              }
            >
              {configs.map((c) => (
                <tr key={c.id} className="transition-colors hover:bg-surface/60">
                  <td className="px-4 py-3">
                    <Link
                      href={`/barge/rough?config=${c.id}`}
                      className="font-medium text-ink-900 hover:text-brand-600"
                    >
                      {c.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 tabular-nums text-ink-600">
                    {Number(c.length_ft)}&prime; × {Number(c.beam_ft)}&prime; ×{" "}
                    {Number(c.depth_ft)}&prime; · {c.spud_wells} wells
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-ink-600">
                    ${Number(c.steel_per_lb).toFixed(2)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-ink-600">
                    {Number(c.hours_per_ton)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {(isAdmin || c.created_by === profile.id) && (
                      <DeleteRowButton
                        action={deleteBargeConfig.bind(null, c.id)}
                        confirmText={`Delete configuration "${c.name}"?`}
                        title="Delete configuration"
                      />
                    )}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <BargeProgramPlanner
          quotes={quotes.map((q) => {
            const t = totals.get(q.id);
            return {
              id: q.id,
              name: q.name,
              status: q.status,
              hours: Number(t?.total_hours ?? 0),
              price: Number(t?.sales_price ?? 0),
              directMargin: Number(t?.direct_margin ?? 0),
              netTons: Number(t?.net_tons ?? 0),
            };
          })}
        />
      </div>
    </div>
  );
}
