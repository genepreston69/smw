import { Download, PieChart } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { getCustomerSummary } from "@/lib/customerSummary";
import { Card, EmptyState, PageHeader, buttonCls } from "@/components/ui";
import { SummaryTable } from "./SummaryRows";

export default async function CustomerSummaryPage() {
  const { supabase } = await requireUser();
  const { rows, showCompany, totals } = await getCustomerSummary(supabase);

  return (
    <div>
      <PageHeader
        title="Customer Summary"
        subtitle="Every job's actual costs and invoiced revenue rolled up by customer, largest invoiced first — click any column header to re-sort. Click a customer to list their jobs, a job to break its costs down by vendor, and a vendor to see the individual transactions. Customers with no transaction activity since Jan 1, 2025 are hidden. Job-level QuickBooks data only — costs tagged to a job (since Jan 1, 2023) and invoices billed to a job. Contract services covers all non-labor, non-materials direct costs (account-based expense lines)."
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
          <SummaryTable
            rows={rows}
            totals={totals}
            showCompany={showCompany}
          />
        )}
      </Card>
    </div>
  );
}
