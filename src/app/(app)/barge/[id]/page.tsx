import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { fetchAllRows } from "@/lib/supabase/fetchAll";
import { BargeQuoteWorkbench } from "@/components/barge/BargeQuoteWorkbench";
import type {
  BargeApproval,
  BargeLaborPhase,
  BargeQuote,
  BargeSteelLine,
} from "@/lib/barge";
import type { ApprovalThreshold, Customer, Profile } from "@/lib/types";
import { throwIfError } from "@/lib/supabase/throwIfError";

export default async function BargeQuotePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { supabase, profile } = await requireUser();

  const { data: quote, error: quoteError } = await supabase
    .from("barge_quotes")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  // A failed read is an error, not "no such quote".
  throwIfError("this barge quote", quoteError);

  if (!quote) notFound();

  const [
    { data: lines, error: linesError },
    { data: labor, error: laborError },
    { data: approvals, error: approvalsError },
    { data: thresholds, error: thresholdsError },
    customers,
    { data: profiles, error: profilesError },
  ] = await Promise.all([
    supabase
      .from("barge_quote_steel_lines")
      .select("*")
      .eq("quote_id", id)
      .order("sort_order"),
    supabase
      .from("barge_quote_labor_phases")
      .select("*")
      .eq("quote_id", id)
      .order("sort_order"),
    supabase
      .from("barge_quote_approvals")
      .select("*")
      .eq("quote_id", id)
      .order("created_at", { ascending: false }),
    supabase
      .from("approval_thresholds")
      .select("id, min_amount, max_amount, required_approvals, label")
      .order("min_amount"),
    // Paged read so the picker lists every customer past the 1000-row cap.
    fetchAllRows((from, to) =>
      supabase
        .from("customers")
        .select("id, display_name")
        .eq("active", true)
        .order("display_name")
        .order("id")
        .range(from, to),
    ),
    supabase.from("profiles").select("id, email, full_name, role"),
  ]);
  // The workbench saves its content wholesale, so a quote that opened with no
  // lines because a read failed would be saved back with no lines.
  throwIfError(
    "this barge quote",
    linesError,
    laborError,
    approvalsError,
    thresholdsError,
    profilesError,
  );

  return (
    <BargeQuoteWorkbench
      quote={quote as BargeQuote}
      lines={(lines ?? []) as BargeSteelLine[]}
      labor={(labor ?? []) as BargeLaborPhase[]}
      approvals={(approvals ?? []) as BargeApproval[]}
      thresholds={(thresholds ?? []) as ApprovalThreshold[]}
      customers={customers as Pick<Customer, "id" | "display_name">[]}
      profiles={(profiles ?? []) as Profile[]}
      me={profile}
    />
  );
}
