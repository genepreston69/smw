import { buildBudgetWorkbook, budgetExportContext } from "@/lib/budgetWorkbook";

// Excel export of /financials/budget: the page's selection — company, class,
// view, columns, and the growth rates on screen, saved or not — as one
// workbook (built by buildBudgetWorkbook, shared with the per-class zip
// export, so the file always matches the screen).
export async function GET(request: Request) {
  const result = await budgetExportContext(request);
  if ("error" in result) return result.error;
  const { ctx } = result;

  const { workbook, filename } = buildBudgetWorkbook(ctx, ctx.cls);
  const buffer = await workbook.xlsx.writeBuffer();
  return new Response(Buffer.from(buffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
