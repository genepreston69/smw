"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { AppRole } from "@/lib/types";

const ROLES: AppRole[] = ["admin", "estimator", "approver", "viewer"];

export function RoleSelect({ userId, role }: { userId: string; role: AppRole }) {
  const router = useRouter();
  const [value, setValue] = useState<AppRole>(role);
  const [busy, setBusy] = useState(false);

  async function change(next: AppRole) {
    setBusy(true);
    const prev = value;
    setValue(next);
    const { error } = await createClient()
      .from("profiles")
      .update({ role: next })
      .eq("id", userId);
    if (error) {
      setValue(prev);
      alert(error.message);
    } else {
      router.refresh();
    }
    setBusy(false);
  }

  return (
    <select
      value={value}
      disabled={busy}
      onChange={(e) => change(e.target.value as AppRole)}
      className="rounded border border-zinc-300 px-2 py-1 text-sm capitalize focus:border-blue-500 focus:outline-none"
    >
      {ROLES.map((r) => (
        <option key={r} value={r}>
          {r}
        </option>
      ))}
    </select>
  );
}
