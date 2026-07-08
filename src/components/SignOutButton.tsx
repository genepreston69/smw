"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={async () => {
        await createClient().auth.signOut();
        router.replace("/login");
        router.refresh();
      }}
      title="Sign out"
      className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[0.68rem] font-medium text-white/50 transition-colors hover:bg-white/10 hover:text-white"
    >
      <LogOut size={13} strokeWidth={2} />
      Sign out
    </button>
  );
}
