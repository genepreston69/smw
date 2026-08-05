import { Anchor } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { SidebarNav } from "@/components/SidebarNav";
import { SignOutButton } from "@/components/SignOutButton";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { profile } = await requireUser();

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="fixed inset-y-0 left-0 z-20 flex w-48 flex-col bg-navy-950 print:hidden">
        <div className="flex items-center gap-2.5 px-4 pb-6 pt-6">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 text-white">
            <Anchor size={18} strokeWidth={2} />
          </span>
          <div className="leading-tight">
            <p className="text-sm font-bold tracking-wide text-white">SMW</p>
            <p className="text-[0.68rem] font-medium uppercase tracking-[0.14em] text-white/45">
              Job Plans
            </p>
          </div>
        </div>

        <SidebarNav isAdmin={profile.role === "admin"} />

        <div className="mt-auto border-t border-white/10 px-4 py-4">
          <p className="truncate text-sm font-medium text-white/90">
            {profile.full_name || profile.email}
          </p>
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <span className="rounded-full border border-white/15 bg-white/5 px-2 py-0.5 text-[0.68rem] font-medium capitalize text-white/60">
              {profile.role}
            </span>
            <SignOutButton />
          </div>
        </div>
      </aside>

      {/* Main */}
      <div className="ml-48 flex min-h-screen min-w-0 flex-1 flex-col print:ml-0">
        <main className="mx-auto w-full max-w-[1480px] flex-1 px-6 py-8 print:max-w-none print:px-0 print:py-0">
          {children}
        </main>
      </div>
    </div>
  );
}
