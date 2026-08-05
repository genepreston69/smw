"use client";

import { Printer } from "lucide-react";
import { buttonCls } from "@/components/ui";

/** Opens the browser print dialog — "Save as PDF" turns the page into a PDF. */
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      title="Print this page or save it as a PDF"
      className={buttonCls("secondary")}
    >
      <Printer size={16} strokeWidth={2} />
      Print / Save PDF
    </button>
  );
}
