import { Download, PieChart } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { getCustomerSummary } from "@/lib/customerSummary";
import { money } from "@/lib/format";
import {
  Card,
  EmptyState,
  PageHeader,
  Table,
  Th,
  buttonCls,
} from "@/components/ui";
import { SummaryRows } from "./SummaryRows";

export default async function CustomerSummaryPage() {
  const { supabase } = await requireUser();
  const { rows, showCompany, totals } = await getCustomerSummary(supabase);

  return (
    <div>
      <PageHeader
        title="Customer Summary"
        subtitle="Every job's actual costs and invoiced revenue rolled up by customer, largest invoiced first. Click a customer to list their jobs. Job-level QuickBooks data only — costs tagged to a job (since Jan 1, 2023) and invoices billed to a job. Contract services covers all non-labor, non-materials direct costs (account-based expense lines)."
        action={
          <a
            href="/api/export/customer-summary"
            className={buttonCls("secondary")}
          >
            <Download size={15} strokeWidth={2} />
            Export to Excel
          </a>
        }
      />

      {/* clip off so the sticky header can escape the card while scrolling */}
      <Card pad={false} clip={false}>
        {rows.length === 0 ? (
          <EmptyState icon={PieChart} title="No jobs yet">
            Connect QuickBooks in Settings and run a sync.
          </EmptyState>
        ) : (
          <Table
            stickyHeader
            head={
              <tr>
                <Th>Customer</Th>
                {showCompany && <Th>QB Company</Th>}
                <Th>Intercompany</Th>
                <Th right>Jobs</Th>
                <Th right>Materials</Th>
                <Th right>Direct labor</Th>
                <Th right>Contract services</Th>
                <Th right>Actual cost</Th>
                <Th right>Invoiced</Th>
                <Th right>Net</Th>
              </tr>
            }
          >
            <SummaryRows rows={rows} showCompany={showCompany} />
            <tr className="border-t-2 border-line bg-surface/40 font-semibold text-ink-900">
              <td className="px-4 py-3">
                Total ({rows.length} customer{rows.length === 1 ? "" : "s"})
              </td>
              {showCompany && <td className="px-4 py-3" />}
              <td className="px-4 py-3" />
              <td className="px-4 py-3 text-right tabular-nums">
                {totals.jobs}
              </td>
              <td className="px-4 py-3 text-right tabular-nums">
                {money(totals.materials)}
              </td>
              <td className="px-4 py-3 text-right tabular-nums">
                {money(totals.labor)}
              </td>
              <td className="px-4 py-3 text-right tabular-nums">
                {money(totals.other)}
              </td>
              <td className="px-4 py-3 text-right tabular-nums">
                {money(totals.cost)}
              </td>
              <td className="px-4 py-3 text-right tabular-nums">
                {money(totals.invoiced)}
              </td>
              <td
                className={`px-4 py-3 text-right tabular-nums ${
                  totals.net < 0 ? "text-bad-600" : ""
                }`}
              >
                {money(totals.net)}
              </td>
            </tr>
          </Table>
        )}
      </Card>
    </div>
  );
}
