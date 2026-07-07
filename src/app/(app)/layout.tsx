import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { SignOutButton } from "@/components/SignOutButton";

const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/plans", label: "Job Plans" },
  { href: "/approvals", label: "Approvals" },
  { href: "/customers", label: "Customers" },
  { href: "/jobs", label: "Jobs" },
  { href: "/settings", label: "Settings" },
];

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { profile } = await requireUser();

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4">
          <Link href="/" className="text-sm font-bold tracking-tight">
            SMW <span className="font-normal text-zinc-500">Job Plans</span>
          </Link>
          <nav className="flex flex-1 items-center gap-1">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-md px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="flex items-center gap-3 text-sm text-zinc-500">
            <span>
              {profile.full_name || profile.email}
              <span className="ml-1.5 rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-xs capitalize">
                {profile.role}
              </span>
            </span>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8">
        {children}
      </main>
    </div>
  );
}
