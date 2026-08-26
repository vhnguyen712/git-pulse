"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  GitBranch,
  LayoutGrid,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { TerminalDock } from "@/components/terminal-panel";

const NAV_ITEMS = [
  { href: "/", label: "Overview", icon: LayoutGrid },
  { href: "/settings", label: "Settings", icon: Settings },
];

function Brand({ collapsed }: { collapsed?: boolean }) {
  return (
    <div className="flex items-center gap-2 px-1">
      <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-on-primary">
        <GitBranch className="size-4" />
      </div>
      {!collapsed && (
        <span className="font-heading text-sm font-semibold tracking-tight text-on-surface">
          GitPulse AI
        </span>
      )}
    </div>
  );
}

function NavLinks({ collapsed }: { collapsed?: boolean }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-0.5">
      {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
        const active = pathname === href;
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex items-center gap-2 rounded-md py-1.5 text-sm transition-colors",
              collapsed ? "justify-center px-0" : "px-2",
              active
                ? "bg-surface-container text-on-surface"
                : "text-on-surface-variant hover:bg-white/5 hover:text-on-surface",
            )}
            title={collapsed ? label : undefined}
          >
            <Icon className="size-4 shrink-0" />
            {!collapsed && <span>{label}</span>}
          </Link>
        );
      })}
    </nav>
  );
}

const SIDEBAR_COLLAPSED_KEY = "sidebar-collapsed";

export function AppShell({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
    if (stored !== null) setCollapsed(stored === "true");
  }, []);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
  }, [collapsed]);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-surface">
      {/* Desktop / tablet sidebar — user-toggleable collapse */}
      <aside
        className={cn(
          "hidden shrink-0 flex-col gap-4 overflow-y-auto border-r border-outline-variant bg-surface-container-low p-2 transition-[width] duration-200 md:flex",
          collapsed ? "md:w-14" : "md:w-56 md:p-3",
        )}
      >
        <div
          className={cn(
            "flex items-center gap-2",
            collapsed ? "flex-col" : "justify-between",
          )}
        >
          <Brand collapsed={collapsed} />
          <button
            type="button"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => setCollapsed((v) => !v)}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-on-surface-variant hover:bg-white/5 hover:text-on-surface"
          >
            {collapsed ? (
              <PanelLeftOpen className="size-4" />
            ) : (
              <PanelLeftClose className="size-4" />
            )}
          </button>
        </div>
        <NavLinks collapsed={collapsed} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile topbar + drawer trigger */}
        <header className="flex items-center gap-2 border-b border-outline-variant bg-surface-container-low px-3 py-2 md:hidden">
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger
              aria-label="Open navigation"
              className="flex size-8 items-center justify-center rounded-md text-on-surface-variant hover:bg-white/5 hover:text-on-surface"
            >
              <Menu className="size-4" />
            </SheetTrigger>
            <SheetContent side="left" className="bg-surface-container-low p-3">
              <SheetHeader className="px-0">
                <SheetTitle>
                  <Brand />
                </SheetTitle>
              </SheetHeader>
              <div className="mt-4" onClick={() => setMobileOpen(false)}>
                <NavLinks />
              </div>
            </SheetContent>
          </Sheet>
          <Brand />
        </header>

        <main className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">{children}</main>
        <TerminalDock />
      </div>
    </div>
  );
}
