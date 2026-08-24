"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { GitBranch, LayoutGrid, Menu, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

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
              "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
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

export function AppShell({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex min-h-screen w-full bg-surface">
      {/* Desktop / tablet sidebar — icon rail 768–1280px, full sidebar >1280px */}
      <aside className="hidden shrink-0 border-r border-outline-variant bg-surface-container-low md:flex md:w-14 md:flex-col md:gap-4 md:p-2 xl:w-56 xl:p-3">
        <Brand collapsed />
        <div className="hidden xl:block">
          <Brand />
        </div>
        <div className="xl:hidden">
          <NavLinks collapsed />
        </div>
        <div className="hidden xl:block">
          <NavLinks />
        </div>
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

        <main className="flex-1 overflow-x-hidden">{children}</main>
      </div>
    </div>
  );
}
