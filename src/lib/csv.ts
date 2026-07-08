// Excel-compatible CSV: UTF-8 BOM so Excel detects the encoding, CRLF line
// endings, quotes escaped per RFC 4180.
export function toCsv(
  headers: string[],
  rows: (string | number | boolean | null | undefined)[][],
): string {
  const esc = (v: string | number | boolean | null | undefined) => {
    const s = String(v ?? "");
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return (
    "\uFEFF" +
    [headers, ...rows].map((r) => r.map(esc).join(",")).join("\r\n")
  );
}

export function csvResponse(csv: string, filename: string): Response {
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
