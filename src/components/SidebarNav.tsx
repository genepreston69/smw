"use client";

import { useEffect, useSyncExternalStore } from "react";
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
  Percent,
  BookOpen,
  Rows3,
  Settings,
  Ship,
  ChevronDown,
  type LucideIcon,
} from "lucide-react";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  adminOnly?: boolean;
}

interface NavSection {
  label: string;
  items: NavItem[];
}

// Dashboard and Settings stay standalone; everything else lives in a
// collapsible section.
const TOP_ITEMS: NavItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
];

const SECTIONS: NavSection[] = [
  {
    label: "Job Planning",
    items: [
      { href: "/plans", label: "Job Plans", icon: ClipboardList },
      { href: "/barge", label: "Barge Program", icon: Ship },
      { href: "/approvals", label: "Approvals", icon: Stamp },
    ],
  },
  {
    label: "Job Performance",
    items: [
      { href: "/jobs", label: "Jobs", icon: Wrench },
      { href: "/capitalized-labor", label: "Capitalized Labor", icon: HardHat },
    ],
  },
  {
    label: "Financials",
    items: [
      { href: "/financials", label: "Financials", icon: Landmark, adminOnly: true },
      {
        href: "/financials/ratios",
        label: "Income Ratios",
        icon: Percent,
        adminOnly: true,
      },
      {
        href: "/financials/statement",
        label: "Income Statement",
        icon: Rows3,
        adminOnly: true,
      },
      {
        href: "/financials/accounts",
        label: "Chart of Accounts",
        icon: BookOpen,
        adminOnly: true,
      },
    ],
  },
  {
    label: "Customers",
    items: [
      { href: "/customers", label: "Customers", icon: Users },
      { href: "/customers/summary", label: "Customer Summary", icon: PieChart },
    ],
  },
];

const BOTTOM_ITEMS: NavItem[] = [
  { href: "/settings", label: "Settings", icon: Settings },
];

/* ---------------------------------------------------------------------------
   Collapse state — a tiny localStorage-backed external store read through
   useSyncExternalStore. The server (and hydration) snapshot is all-expanded;
   the stored choices apply on the first client render after hydration, and
   every mutation persists and notifies subscribers.
--------------------------------------------------------------------------- */

const STORAGE_KEY = "smw-sidebar-collapsed";
const ALL_EXPANDED: Record<string, boolean> = {};
let collapsedState: Record<string, boolean> | null = null; // null = not loaded yet
const listeners = new Set<() => void>();

function getCollapsed(): Record<string, boolean> {
  if (collapsedState === null) {
    collapsedState = ALL_EXPANDED;
    try {
      const parsed: unknown = JSON.parse(
        window.localStorage.getItem(STORAGE_KEY) ?? "",
      );
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        collapsedState = parsed as Record<string, boolean>;
      }
    } catch {
      // nothing stored (or unreadable): stay all-expanded
    }
  }
  return collapsedState;
}

function setSectionCollapsed(label: string, value: boolean) {
  collapsedState = { ...getCollapsed(), [label]: value };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(collapsedState));
  } catch {
    // storage unavailable; collapse still works for this visit
  }
  for (const notify of listeners) notify();
}

function subscribeCollapsed(notify: () => void) {
  listeners.add(notify);
  return () => listeners.delete(notify);
}

export function SidebarNav({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  const collapsed = useSyncExternalStore(
    subscribeCollapsed,
    getCollapsed,
    () => ALL_EXPANDED,
  );

  const visible = (item: NavItem) => isAdmin || !item.adminOnly;
  const sections = SECTIONS.map((s) => ({
    ...s,
    items: s.items.filter(visible),
  })).filter((s) => s.items.length > 0);
  const allItems = [
    ...TOP_ITEMS.filter(visible),
    ...sections.flatMap((s) => s.items),
    ...BOTTOM_ITEMS.filter(visible),
  ];

  // Longest matching href wins so nested routes (/financials/ratios) light
  // up their own item, not every prefix (/financials) as well.
  const activeHref = allItems.reduce<string | null>((best, { href }) => {
    const match =
      href === "/"
        ? pathname === "/"
        : pathname === href || pathname.startsWith(`${href}/`);
    if (!match) return best;
    return !best || href.length > best.length ? href : best;
  }, null);

  // Navigating into a collapsed section expands it so the active item is
  // never hidden (a section collapsed while you're on its page stays put).
  const activeSection =
    sections.find((s) => s.items.some((i) => i.href === activeHref))?.label ??
    null;
  useEffect(() => {
    if (activeSection && getCollapsed()[activeSection]) {
      setSectionCollapsed(activeSection, false);
    }
  }, [activeSection]);

  const navLink = ({ href, label, icon: Icon }: NavItem) => {
    const active = href === activeHref;
    return (
      <Link
        key={href}
        href={href}
        className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-[0.95rem] font-medium transition-colors ${
          active
            ? "bg-white/10 text-white"
            : "text-white/60 hover:bg-white/5 hover:text-white/90"
        }`}
      >
        <Icon size={18} strokeWidth={active ? 2 : 1.75} />
        {label}
      </Link>
    );
  };

  return (
    <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-4">
      {TOP_ITEMS.filter(visible).map(navLink)}
      {sections.map((section) => {
        const isCollapsed = !!collapsed[section.label];
        const containsActive = section.label === activeSection;
        return (
          <div key={section.label}>
            <button
              type="button"
              onClick={() => setSectionCollapsed(section.label, !isCollapsed)}
              aria-expanded={!isCollapsed}
              className={`flex w-full items-center justify-between rounded-md px-3 pb-1 pt-3.5 text-left text-[0.72rem] font-semibold uppercase tracking-[0.12em] transition-colors ${
                isCollapsed && containsActive
                  ? "text-white/80"
                  : "text-white/35 hover:text-white/70"
              }`}
            >
              {section.label}
              <ChevronDown
                size={13}
                strokeWidth={2}
                className={`transition-transform ${isCollapsed ? "-rotate-90" : ""}`}
              />
            </button>
            {!isCollapsed && (
              <div className="flex flex-col gap-0.5">
                {section.items.map(navLink)}
              </div>
            )}
          </div>
        );
      })}
      <div className="pt-3.5">{BOTTOM_ITEMS.filter(visible).map(navLink)}</div>
    </nav>
  );
}
