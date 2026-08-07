import Link from "next/link";
import { ArrowLeft, ReceiptText } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchAllRows } from "@/lib/supabase/fetchAll";
import { money, shortDate } from "@/lib/format";
import {
  ROW_DIMS,
  SCOPES,
  SCOPE_CLASSIFICATIONS,
  financialsHref,
  lastDayOfMonth,
  linesHref,
  monthLabel,
  resolveFinancialsState,
} from "@/lib/financials";
import { Card, EmptyState, PageHeader, Table, Th, buttonCls } from "@/components/ui";

// Drill-down for one Financials pivot cell: the raw ledger lines behind the
// amount that was clicked. gl_lines_detail applies the same dimension
// filters gl_pivot groups by, so this list always reconciles with the cell.

const PAGE_SIZE = 500;

interface LineRow {
  id: string;
  realm_id: string;
  account_full_name: string | null;
  classification: string | null;
  txn_date: string;
  txn_type: string | null;
  doc_number: string | null;
  entity_name: string | null;
  customer_name: string | null;
  vendor_name: string | null;
  memo: string | null;
  split_account: string | null;
  class_name: string | null;
  department_name: string | null;
  amount: number | string;
}

interface PivotRow {
  classification: string | null;
  row_key: string;
  col_key: string;
  amount: number | string;
}

export default async function FinancialLinesPage({
  searchParams,
}: {
  searchParams: Promise<{
    company?: string;
    from?: string;
    to?: string;
    rows?: string;
    cols?: string;
    scope?: string;
    display?: string;
    rowkey?: string;
    colkey?: string;
    page?: string;
  }>;
}) {
  const sp = await searchParams;
  const rowKey = sp.rowkey ?? null;
  const colKey = sp.colkey ?? null;
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);

  // Financials are admin-only. requireAdmin() verifies the caller; the reads
  // below then go through the service-role client because the admin RLS qual
  // on the gl_* tables pushes queries this size past the statement timeout.
  // RLS still guards those tables against direct API access.
  await requireAdmin();
  const supabase = createServiceClient();
  const { data: connRows } = await supabase
    .from("qb_connection_status")
    .select("realm_id, company_name")
    .order("created_at");
  const companies = (connRows ?? []) as {
    realm_id: string;
    company_name: string | null;
  }[];
  const companyByRealm = new Map(
    companies.map((c) => [c.realm_id, c.company_name ?? `Company ${c.realm_id}`]),
  );
  const state = resolveFinancialsState(sp, new Set(companyByRealm.keys()));
  const { company, from, to, rows: rowDim, cols: colDim, scope } = state;

  const filterArgs = {
    p_start: `${from}-01`,
    p_end: lastDayOfMonth(to),
    p_realm_id: company === "all" ? null : company,
    p_classifications: SCOPE_CLASSIFICATIONS[scope],
  };

  const {
    data: lineData,
    error,
    count,
  } = await supabase
    .rpc(
      "gl_lines_detail",
      {
        ...filterArgs,
        p_row_dim: rowDim,
        p_row_key: rowKey,
        p_col_dim: colDim,
        p_col_key: colKey,
      },
      { count: "exact" },
    )
    .order("txn_date", { ascending: false })
    .order("id")
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  if (error) throw new Error(error.message);
  const lines = (lineData ?? []) as LineRow[];
  const totalLines = count ?? lines.length;
  const pageCount = Math.max(1, Math.ceil(totalLines / PAGE_SIZE));

  // The exact total for this slice comes from the same aggregation the pivot
  // showed, with the same sign convention, so the header always matches the
  // cell that was clicked.
  const pivotCells = (await fetchAllRows((fromRow, toRow) =>
    supabase
      .rpc("gl_pivot", {
        ...filterArgs,
        p_row_dim: rowDim,
        p_col_dim: colDim,
      })
      .order("row_key")
      .order("col_key")
      .order("classification")
      .order("account_type")
      .range(fromRow, toRow),
  )) as PivotRow[];
  const total = pivotCells
    .filter(
      (c) =>
        (rowKey === null || c.row_key === rowKey) &&
        (colKey === null || c.col_key === colKey),
    )
    .reduce((sum, c) => {
      const amount = Number(c.amount);
      const flip =
        rowDim !== "account" && scope === "pl" && c.classification === "Expense";
      return sum + (flip ? -amount : amount);
    }, 0);

  const colKeyLabel =
    colKey === null
      ? null
      : colDim === "month"
        ? monthLabel(colKey)
        : colDim === "company"
          ? (companyByRealm.get(colKey) ?? colKey)
          : colDim === "total"
            ? null
            : colKey;
  const slice = [
    rowKey !== null
      ? `${ROW_DIMS.find((d) => d.key === rowDim)!.label}: ${rowDim === "month" ? monthLabel(rowKey) : rowKey}`
      : null,
    colKeyLabel,
    company !== "all" ? companyByRealm.get(company) : null,
    SCOPES.find((s) => s.key === scope)!.label,
    `${monthLabel(from)} – ${monthLabel(to)}`,
  ]
    .filter(Boolean)
    .join(" · ");

  const showCompany = company === "all" && companies.length > 1;
  const nf = new Intl.NumberFormat("en-US");

  return (
    <div>
      <PageHeader
        title="Ledger lines"
        subtitle={
          <>
            {slice} — {nf.format(totalLines)} {totalLines === 1 ? "line" : "lines"},{" "}
            <span className={Number(total) < 0 ? "text-bad-600" : ""}>
              {money(total)}
            </span>
          </>
        }
        action={
          <Link href={financialsHref(state)} className={buttonCls("secondary")}>
            <ArrowLeft size={15} strokeWidth={2} />
            Back to Financials
          </Link>
        }
      />

      <Card pad={false} clip={false}>
        {lines.length === 0 ? (
          <EmptyState icon={ReceiptText} title="No ledger lines for this slice">
            Widen the period or filters on the Financials page.
          </EmptyState>
        ) : (
          <Table
            stickyHeader
            head={
              <tr>
                <Th>Date</Th>
                <Th>Type</Th>
                <Th>Doc #</Th>
                {showCompany && <Th>Company</Th>}
                <Th>Account</Th>
                <Th>Name</Th>
                <Th>Class</Th>
                <Th>Memo</Th>
                <Th>Split</Th>
                <Th right>Amount</Th>
              </tr>
            }
          >
            {lines.map((l) => {
              const amount = Number(l.amount);
              return (
                <tr key={l.id} className="hover:bg-surface/50">
                  <td className="whitespace-nowrap px-4 py-2 text-ink-900">
                    {shortDate(l.txn_date)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-ink-600">
                    {l.txn_type ?? "—"}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-ink-600">
                    {l.doc_number ?? "—"}
                  </td>
                  {showCompany && (
                    <td className="whitespace-nowrap px-4 py-2 text-ink-600">
                      {companyByRealm.get(l.realm_id) ?? l.realm_id}
                    </td>
                  )}
                  <td
                    className="max-w-[18rem] truncate px-4 py-2 text-ink-900"
                    title={l.account_full_name ?? undefined}
                  >
                    {l.account_full_name ?? "—"}
                  </td>
                  <td
                    className="max-w-[14rem] truncate px-4 py-2 text-ink-600"
                    title={l.customer_name ?? l.entity_name ?? l.vendor_name ?? undefined}
                  >
                    {l.customer_name ?? l.entity_name ?? l.vendor_name ?? "—"}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-ink-600">
                    {l.class_name ?? "—"}
                  </td>
                  <td
                    className="max-w-[20rem] truncate px-4 py-2 text-ink-600"
                    title={l.memo ?? undefined}
                  >
                    {l.memo ?? "—"}
                  </td>
                  <td
                    className="max-w-[12rem] truncate px-4 py-2 text-ink-600"
                    title={l.split_account ?? undefined}
                  >
                    {l.split_account ?? "—"}
                  </td>
                  <td
                    className={`whitespace-nowrap px-4 py-2 text-right tabular-nums ${
                      amount < 0 ? "text-bad-600" : "text-ink-900"
                    }`}
                  >
                    {money(amount)}
                  </td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>

      {pageCount > 1 && (
        <div className="mt-4 flex items-center gap-3">
          {page > 1 && (
            <Link
              href={linesHref(state, rowKey, colKey, page - 1)}
              className={buttonCls("secondary", "sm")}
            >
              Previous
            </Link>
          )}
          <span className="text-sm text-ink-600">
            Page {page} of {pageCount}
          </span>
          {page < pageCount && (
            <Link
              href={linesHref(state, rowKey, colKey, page + 1)}
              className={buttonCls("secondary", "sm")}
            >
              Next
            </Link>
          )}
        </div>
      )}
      <p className="mt-3 text-xs text-ink-400">
        Line amounts are natural signed ledger activity. The header total uses
        the same convention as the Financials cell you clicked
        {rowDim !== "account" && scope === "pl"
          ? " (income minus expenses)"
          : ""}
        .
      </p>
    </div>
  );
}
