import JSZip from "jszip";
import {
  budgetExportContext,
  budgetFileStem,
  buildBudgetWorkbook,
} from "@/lib/budgetWorkbook";

// Every class's budget workbook at once, as a zip — for handing each class
// its budget (/financials/budget's Export a class… → Every class). Same
// params as /api/export/budget; each workbook in the zip is exactly what
// that class's own Export Excel downloads, all built from one ledger read.
export async function GET(request: Request) {
  const result = await budgetExportContext(request);
  if ("error" in result) return result.error;
  const { ctx } = result;

  const zip = new JSZip();
  for (const cls of ctx.classes) {
    const { workbook, filename } = buildBudgetWorkbook(ctx, cls);
    zip.file(filename, await workbook.xlsx.writeBuffer());
  }
  const bytes = await zip.generateAsync({ type: "uint8array" });
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${budgetFileStem(ctx, { classes: true })}.zip"`,
    },
  });
}
