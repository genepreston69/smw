"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  ClipboardList,
  Stamp,
  Users,
  PieChart,
  Wrench,
  HardHat,
  Landmark,
  Settings,
  type LucideIcon,
} from "lucide-react";

const ALL_NAV: {
  href: string;
  label: string;
  icon: LucideIcon;
  adminOnly?: boolean;
}[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/plans", label: "Job Plans", icon: ClipboardList },
  { href: "/approvals", label: "Approvals", icon: Stamp },
  { href: "/customers", label: "Customers", icon: Users },
  { href: "/customers/summary", label: "Customer Summary", icon: PieChart },
  { href: "/jobs", label: "Jobs", icon: Wrench },
  { href: "/capitalized-labor", label: "Capitalized Labor", icon: HardHat },
  { href: "/financials", label: "Financials", icon: Landmark, adminOnly: true },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function SidebarNav({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  const NAV = ALL_NAV.filter((item) => isAdmin || !item.adminOnly);

  // Longest matching href wins so nested routes (/customers/summary) light
  // up their own item, not every prefix (/customers) as well.
  const activeHref = NAV.reduce<string | null>((best, { href }) => {
    const match =
      href === "/"
        ? pathname === "/"
        : pathname === href || pathname.startsWith(`${href}/`);
    if (!match) return best;
    return !best || href.length > best.length ? href : best;
  }, null);

  return (
    <nav className="flex flex-col gap-0.5 px-2">
      {NAV.map(({ href, label, icon: Icon }) => {
        const active = href === activeHref;
        return (
          <Link
            key={href}
            href={href}
            className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-[0.84rem] font-medium transition-colors ${
              active
                ? "bg-white/10 text-white"
                : "text-white/60 hover:bg-white/5 hover:text-white/90"
            }`}
          >
            <Icon size={16} strokeWidth={active ? 2 : 1.75} />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
