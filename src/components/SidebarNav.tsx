"use client";

import { useEffect, useRef, useState } from "react";
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
  Archive,
  Package,
  Landmark,
  Percent,
  BookOpen,
  Rows3,
  Scale,
  Columns2,
  HeartPulse,
  Wallet,
  Settings,
  Ship,
  ChevronRight,
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
  icon: LucideIcon;
  items: NavItem[];
}

// Dashboard and Settings stay standalone; everything else lives in a
// section whose pages open in a flyout panel to the right of the sidebar.
const TOP_ITEMS: NavItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
];

const SECTIONS: NavSection[] = [
  {
    label: "Job Planning",
    icon: ClipboardList,
    items: [
      { href: "/plans", label: "Job Plans", icon: ClipboardList },
      { href: "/barge", label: "Barge Program", icon: Ship },
      { href: "/approvals", label: "Approvals", icon: Stamp },
    ],
  },
  {
    label: "Job Performance",
    icon: Wrench,
    items: [{ href: "/jobs", label: "Jobs", icon: Wrench }],
  },
  {
    label: "Capitalized Labor",
    icon: HardHat,
    items: [
      { href: "/capitalized-labor", label: "Capitalized Labor", icon: HardHat },
      {
        // Built from the general ledger, so admin-only like Financials.
        href: "/capitalized-labor/already-capitalized",
        label: "Already Capitalized",
        icon: Archive,
        adminOnly: true,
      },
      {
        // Everything expensed on non-billable jobs, every QB company.
        href: "/capitalized-materials",
        label: "Capitalized Materials",
        icon: Package,
      },
    ],
  },
  {
    label: "Financials",
    icon: Landmark,
    items: [
      { href: "/financials", label: "Financials", icon: Landmark, adminOnly: true },
      {
        href: "/financials/ratios",
        label: "Financial Ratios",
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
        href: "/financials/balance-sheet",
        label: "Balance Sheet",
        icon: Columns2,
        adminOnly: true,
      },
      {
        // Employee Benefits ÷ labor (710 + 935 + 934), from the ledger.
        href: "/financials/benefits",
        label: "Cost of Benefits",
        icon: HeartPulse,
        adminOnly: true,
      },
      {
        href: "/financials/accounts",
        label: "Chart of Accounts",
        icon: BookOpen,
        adminOnly: true,
      },
      {
        href: "/financials/reconciliation",
        label: "Reconciliation with QB",
        icon: Scale,
        adminOnly: true,
      },
    ],
  },
  {
    label: "Budget and Forecast",
    icon: Wallet,
    items: [
      {
        href: "/financials/budget",
        label: "Budget",
        icon: Wallet,
        adminOnly: true,
      },
    ],
  },
  {
    label: "Customers",
    icon: Users,
    items: [
      { href: "/customers", label: "Customers", icon: Users },
      { href: "/customers/summary", label: "Customer Summary", icon: PieChart },
    ],
  },
];

const BOTTOM_ITEMS: NavItem[] = [
  { href: "/settings", label: "Settings", icon: Settings },
];

const ITEM_CLASS =
  "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[0.95rem] font-medium transition-colors";
const ACTIVE_CLASS = "bg-white/10 text-white";
const IDLE_CLASS = "text-white/60 hover:bg-white/5 hover:text-white/90";

export function SidebarNav({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  const navRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // The open flyout remembers the page it was opened on, so arriving on a new
  // page closes it without an effect.
  const [open, setOpen] = useState<{ label: string; pathname: string } | null>(
    null,
  );
  const openLabel = open && open.pathname === pathname ? open.label : null;

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

  const activeSection =
    sections.find((s) => s.items.some((i) => i.href === activeHref))?.label ??
    null;
  const openSection = sections.find((s) => s.label === openLabel) ?? null;

  // While a flyout is open: Esc or a click anywhere outside the nav closes
  // it, and focus starts on its first page.
  useEffect(() => {
    if (!openLabel) return;
    panelRef.current?.querySelector("a")?.focus();
    const onPointerDown = (e: PointerEvent) => {
      if (!navRef.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(null);
      navRef.current
        ?.querySelector<HTMLButtonElement>('button[aria-expanded="true"]')
        ?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openLabel]);

  const navLink = (
    { href, label, icon: Icon }: NavItem,
    // A one-page section shows as a plain link under the section's name.
    sectionLabel?: string,
  ) => {
    const active = href === activeHref;
    return (
      <Link
        key={href}
        href={href}
        onClick={() => setOpen(null)}
        className={`${ITEM_CLASS} ${active ? ACTIVE_CLASS : IDLE_CLASS}`}
      >
        <Icon size={18} strokeWidth={active ? 2 : 1.75} className="shrink-0" />
        {sectionLabel ?? label}
      </Link>
    );
  };

  return (
    <nav
      ref={navRef}
      className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-4"
    >
      {TOP_ITEMS.filter(visible).map((item) => navLink(item))}
      {sections.map((section) => {
        // Nothing to choose between: go straight to the page.
        if (section.items.length === 1) {
          return navLink(section.items[0], section.label);
        }
        const isOpen = section.label === openLabel;
        const highlighted = isOpen || section.label === activeSection;
        const Icon = section.icon;
        return (
          <button
            key={section.label}
            type="button"
            onClick={() =>
              setOpen(isOpen ? null : { label: section.label, pathname })
            }
            aria-expanded={isOpen}
            aria-haspopup="true"
            className={`${ITEM_CLASS} ${highlighted ? ACTIVE_CLASS : IDLE_CLASS}`}
          >
            <Icon
              size={18}
              strokeWidth={highlighted ? 2 : 1.75}
              className="shrink-0"
            />
            <span className="min-w-0 flex-1">{section.label}</span>
            <ChevronRight
              size={14}
              strokeWidth={2}
              className={`shrink-0 ${isOpen ? "text-white/80" : "text-white/35"}`}
            />
          </button>
        );
      })}
      {BOTTOM_ITEMS.filter(visible).map((item) => navLink(item))}

      {/* Flyout: the open section's pages, floating over the page content
          just right of the sidebar (the sidebar is w-56). */}
      {openSection && (
        <div
          ref={panelRef}
          role="group"
          aria-label={openSection.label}
          className="fixed inset-y-0 left-56 flex w-60 flex-col gap-0.5 overflow-y-auto border-l border-white/10 bg-navy-900 px-2 pb-4 pt-6 shadow-2xl"
        >
          <p className="px-3 pb-3 text-[0.72rem] font-semibold uppercase tracking-[0.12em] text-white/40">
            {openSection.label}
          </p>
          {openSection.items.map((item) => navLink(item))}
        </div>
      )}
    </nav>
  );
}
