import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/fetchAll";
import { shortDate } from "@/lib/format";

// Per-customer drill-down workbook for the Customer Summary page: a summary
// sheet plus one worksheet per job, each grouped by vendor with the vendor's
// totals and its individual cost transactions.
//
// ?customer=<customer uuid> — or "none" for jobs with no customer link.

interface CostLine {
  job_id: string;
  txn_date: string | null;
  qb_txn_type: string;
  vendor_name: string | null;
  description: string | null;
  category: string | null;
  cost_type: string | null;
  amount: number | null;
  hours: number | null;
}

const COST_TYPE_LABELS: Record<string, string> = {
  materials: "Materials",
  labor: "Direct Labor",
  other: "Contract Services",
};

// Excel sheet names: max 31 chars, no \ / * ? : [ ], unique per workbook.
function sheetNamer() {
  const used = new Set<string>();
  return (raw: string): string => {
    const base =
      raw.replace(/[\\/*?:[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31) ||
      "Job";
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) {
      const suffix = ` (${n})`;
      name = base.slice(0, 31 - suffix.length) + suffix;
    }
    used.add(name.toLowerCase());
    return name;
  };
}

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const customerKey = new URL(request.url).searchParams.get("customer");
  if (!customerKey) {
    return NextResponse.json(
      { error: "Missing customer parameter" },
      { status: 400 },
    );
  }

  let customerName = "(No customer)";
  if (customerKey !== "none") {
    const { data: cust } = await supabase
      .from("customers")
      .select("display_name")
      .eq("id", customerKey)
      .maybeSingle();
    if (!cust) {
      return NextResponse.json({ error: "Customer not found" }, { status: 404 });
    }
    customerName = cust.display_name as string;
  }

  const jobs = (await fetchAllRows((from, to) => {
    const q = supabase.from("jobs").select("id, name");
    return (
      customerKey === "none"
        ? q.is("customer_id", null)
        : q.eq("customer_id", customerKey)
    )
      .order("name")
      .order("id")
      .range(from, to);
  })) as { id: string; name: string }[];

  // Cost lines and invoice totals for these jobs, fetched in id chunks to
  // keep the filter within URL length limits; each chunk pages past the
  // 1000-row cap.
  const jobIds = jobs.map((j) => j.id);
  const lines: CostLine[] = [];
  const invoicedByJob = new Map<string, number>();
  for (let i = 0; i < jobIds.length; i += 100) {
    const chunk = jobIds.slice(i, i + 100);
    const [chunkLines, chunkInvoices] = await Promise.all([
      fetchAllRows((from, to) =>
        supabase
          .from("job_costs")
          .select(
            "job_id, txn_date, qb_txn_type, vendor_name, description, category, cost_type, amount, hours",
          )
          .in("job_id", chunk)
          .order("id")
          .range(from, to),
      ),
      fetchAllRows((from, to) =>
        supabase
          .from("job_invoice_totals")
          .select("job_id, total_invoiced")
          .in("job_id", chunk)
          .order("job_id")
          .range(from, to),
      ),
    ]);
    lines.push(...(chunkLines as CostLine[]));
    for (const r of chunkInvoices as {
      job_id: string;
      total_invoiced: number | null;
    }[]) {
      invoicedByJob.set(r.job_id, Number(r.total_invoiced ?? 0));
    }
  }

  const linesByJob = new Map<string, CostLine[]>();
  for (const l of lines) {
    const list = linesByJob.get(l.job_id);
    if (list) list.push(l);
    else linesByJob.set(l.job_id, [l]);
  }

  const workbook = new ExcelJS.Workbook();
  const moneyFmt = "#,##0.00";
  const hoursFmt = "#,##0.0";
  const nameFor = sheetNamer();

  // Summary sheet mirrors the on-screen job list for this customer.
  const summary = workbook.addWorksheet(nameFor("Summary"));
  summary.columns = [
    { header: "Job", key: "job", width: 32 },
    { header: "Materials", key: "materials", width: 14, style: { numFmt: moneyFmt } },
    { header: "Direct Labor", key: "labor", width: 14, style: { numFmt: moneyFmt } },
    { header: "Contract Services", key: "contract", width: 18, style: { numFmt: moneyFmt } },
    { header: "Actual Cost", key: "cost", width: 14, style: { numFmt: moneyFmt } },
    { header: "Actual Hours", key: "hours", width: 13, style: { numFmt: hoursFmt } },
    { header: "Invoiced Revenue", key: "invoiced", width: 16, style: { numFmt: moneyFmt } },
    { header: "Net", key: "net", width: 14, style: { numFmt: moneyFmt } },
  ];
  summary.getRow(1).font = { bold: true };
  summary.views = [{ state: "frozen", ySplit: 1 }];

  const bucket = (l: CostLine) =>
    l.cost_type === "materials" || l.cost_type === "labor"
      ? l.cost_type
      : "other";

  const grand = { materials: 0, labor: 0, other: 0, hours: 0, invoiced: 0 };
  for (const job of jobs) {
    const jobLines = linesByJob.get(job.id) ?? [];
    const sums = { materials: 0, labor: 0, other: 0, hours: 0 };
    for (const l of jobLines) {
      sums[bucket(l)] += Number(l.amount ?? 0);
      sums.hours += Number(l.hours ?? 0);
    }
    const invoiced = invoicedByJob.get(job.id) ?? 0;
    const cost = sums.materials + sums.labor + sums.other;
    summary.addRow({
      job: job.name,
      materials: sums.materials,
      labor: sums.labor,
      contract: sums.other,
      cost,
      hours: sums.hours > 0 ? sums.hours : null,
      invoiced,
      net: invoiced - cost,
    });
    grand.materials += sums.materials;
    grand.labor += sums.labor;
    grand.other += sums.other;
    grand.hours += sums.hours;
    grand.invoiced += invoiced;
  }
  const grandCost = grand.materials + grand.labor + grand.other;
  const totalRow = summary.addRow({
    job: "Total",
    materials: grand.materials,
    labor: grand.labor,
    contract: grand.other,
    cost: grandCost,
    hours: grand.hours > 0 ? grand.hours : null,
    invoiced: grand.invoiced,
    net: grand.invoiced - grandCost,
  });
  totalRow.font = { bold: true };

  // One sheet per job: vendor sections (bold vendor row with totals, then
  // that vendor's transactions), matching the page's drill-down.
  for (const job of jobs) {
    const sheet = workbook.addWorksheet(nameFor(job.name));
    sheet.columns = [
      { header: "Vendor / Date", key: "a", width: 30 },
      { header: "Type", key: "type", width: 10 },
      { header: "Description", key: "desc", width: 50 },
      { header: "Category", key: "category", width: 26 },
      { header: "Cost Type", key: "costType", width: 17 },
      { header: "Hours", key: "hours", width: 10, style: { numFmt: hoursFmt } },
      { header: "Amount", key: "amount", width: 14, style: { numFmt: moneyFmt } },
    ];
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: "frozen", ySplit: 1 }];

    const jobLines = linesByJob.get(job.id) ?? [];
    if (jobLines.length === 0) {
      sheet.addRow({ a: "No cost transactions since Jan 1, 2023." });
      continue;
    }

    // Group by vendor, largest total first; transactions newest first.
    const byVendor = new Map<string, CostLine[]>();
    for (const l of jobLines) {
      const key = l.vendor_name ?? "(No vendor)";
      const list = byVendor.get(key);
      if (list) list.push(l);
      else byVendor.set(key, [l]);
    }
    const vendors = [...byVendor.entries()]
      .map(([vendor, vLines]) => ({
        vendor,
        lines: [...vLines].sort((a, b) =>
          (b.txn_date ?? "").localeCompare(a.txn_date ?? ""),
        ),
        total: vLines.reduce((s, l) => s + Number(l.amount ?? 0), 0),
        hours: vLines.reduce((s, l) => s + Number(l.hours ?? 0), 0),
      }))
      .sort(
        (a, b) => b.total - a.total || a.vendor.localeCompare(b.vendor),
      );

    let jobTotal = 0;
    let jobHours = 0;
    for (const v of vendors) {
      const vendorRow = sheet.addRow({
        a: v.vendor,
        hours: v.hours > 0 ? v.hours : null,
        amount: v.total,
      });
      vendorRow.font = { bold: true };
      for (const l of v.lines) {
        sheet.addRow({
          a: l.txn_date ? shortDate(l.txn_date) : "—",
          type:
            l.qb_txn_type === "TimeActivity"
              ? "Time"
              : l.qb_txn_type === "JournalEntry"
                ? "Journal"
                : l.qb_txn_type,
          desc: l.description ?? "",
          category: l.category ?? "",
          costType: COST_TYPE_LABELS[l.cost_type ?? "other"] ?? "Contract Services",
          hours: l.hours != null && l.hours > 0 ? Number(l.hours) : null,
          amount: Number(l.amount ?? 0),
        });
      }
      sheet.addRow({});
      jobTotal += v.total;
      jobHours += v.hours;
    }

    const jobTotalRow = sheet.addRow({
      a: "Job total",
      hours: jobHours > 0 ? jobHours : null,
      amount: jobTotal,
    });
    jobTotalRow.font = { bold: true };
    const invoiced = invoicedByJob.get(job.id) ?? 0;
    sheet.addRow({ a: "Invoiced revenue", amount: invoiced });
    sheet.addRow({ a: "Net", amount: invoiced - jobTotal }).font = {
      bold: true,
    };
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const fileBase =
    customerName.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") ||
    "customer";
  return new Response(Buffer.from(buffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${fileBase}-jobs.xlsx"`,
    },
  });
}
