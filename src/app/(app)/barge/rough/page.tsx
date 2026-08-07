import { requireUser } from "@/lib/auth";
import { RoughQuoteBuilder } from "@/components/barge/RoughQuoteBuilder";
import type { BargeConfig } from "@/lib/barge";

export default async function RoughQuotePage({
  searchParams,
}: {
  searchParams: Promise<{ config?: string }>;
}) {
  const { config } = await searchParams;
  const { supabase, profile } = await requireUser();

  const { data } = await supabase
    .from("barge_configs")
    .select("*")
    .order("updated_at", { ascending: false });

  const configs = (data ?? []) as BargeConfig[];
  const canEdit = profile.role === "estimator" || profile.role === "admin";

  return (
    <RoughQuoteBuilder
      configs={configs}
      initialConfigId={config ?? null}
      canEdit={canEdit}
    />
  );
}
