"use client";

import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";
import { Plus, Search } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NotificationBell } from "@/components/dashboard/notification-bell";
import { PlanBadge } from "@/components/dashboard/plan-badge";
import { OPEN_QUICK_SEARCH } from "@/components/dashboard/quick-open";
import { ThemeToggle } from "@/components/landing/theme-toggle";
import { buttonVariants } from "@/components/ui/button";
import { site } from "@/lib/site";
import { cn } from "@/lib/utils";

type DashboardHeaderProps = {
  isPro: boolean;
  planPeriod: "month" | "year" | null;
  periodEnd: number | null;
  canceled: boolean;
};

const NAV_ITEMS = [
  { label: "Overview", href: "/dashboard" },
  { label: "Projects", href: "/dashboard/projects" },
  { label: "Search", href: "/dashboard/search" },
];

function isActive(pathname: string, href: string): boolean {
  return href === "/dashboard" ? pathname === "/dashboard" : pathname.startsWith(href);
}

export function DashboardHeader({ isPro, planPeriod, periodEnd, canceled }: DashboardHeaderProps) {
  const pathname = usePathname();

  const tabClass = (href: string, full: boolean) =>
    cn(
      "rounded-sm px-2.5 py-1.5 font-medium font-mono text-xs uppercase tracking-widest transition-colors",
      full && "flex-1 text-center",
      isActive(pathname, href)
        ? "bg-foreground/[0.06] text-foreground"
        : "text-muted-foreground hover:text-foreground",
    );

  return (
    <header className="fixed top-3 right-0 left-0 z-50 w-full px-3 sm:px-6">
      <div className="mx-auto flex max-w-7xl flex-col gap-2">
        <div className="glass flex h-14 items-center justify-between gap-2 rounded-lg bg-surface/80 px-3 sm:px-4">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <Link href="/dashboard" className="flex shrink-0 items-center gap-2.5">
              <span className="flex size-7 items-center justify-center rounded-sm border border-hairline bg-foreground font-bold font-mono text-background text-sm">
                S
              </span>
              <span className="hidden font-semibold text-sm tracking-display lg:inline">
                {site.name}
              </span>
            </Link>
            <span className="hidden h-5 w-px shrink-0 bg-hairline sm:block" aria-hidden="true" />
            <div className="min-w-0 overflow-hidden">
              <OrganizationSwitcher
                hidePersonal
                afterSelectOrganizationUrl="/dashboard"
                afterLeaveOrganizationUrl="/onboarding"
                appearance={{
                  elements: {
                    organizationSwitcherTrigger: "rounded-sm",
                  },
                }}
              />
            </div>
            <span className="hidden h-5 w-px shrink-0 bg-hairline lg:block" aria-hidden="true" />
            <nav className="hidden shrink-0 items-center gap-1 lg:flex">
              {NAV_ITEMS.map((item) => (
                <Link key={item.href} href={item.href} className={tabClass(item.href, false)}>
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => window.dispatchEvent(new Event(OPEN_QUICK_SEARCH))}
              aria-label="Search workspace, Control or Command K"
              className="flex h-8 cursor-pointer items-center gap-2 rounded-sm px-2 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
            >
              <Search className="size-4" aria-hidden="true" />
              <span className="hidden font-mono text-[10px] lg:inline">⌘K</span>
            </button>
            <PlanBadge
              isPro={isPro}
              planPeriod={planPeriod}
              periodEnd={periodEnd}
              canceled={canceled}
            />
            <NotificationBell />
            <span className="hidden h-5 w-px shrink-0 bg-hairline sm:block" aria-hidden="true" />
            <Link
              href="/onboarding"
              aria-label="New organization"
              className={cn(buttonVariants({ variant: "secondary" }), "text-xs max-lg:px-2.5")}
            >
              <Plus className="size-4" aria-hidden="true" />
              <span className="hidden lg:inline">New organization</span>
            </Link>
            <ThemeToggle />
            <UserButton
              appearance={{
                elements: {
                  userButtonAvatarBox: "rounded-sm",
                },
              }}
            />
          </div>
        </div>

        <nav className="glass flex items-center gap-1 rounded-lg bg-surface/80 p-1 lg:hidden">
          {NAV_ITEMS.map((item) => (
            <Link key={item.href} href={item.href} className={tabClass(item.href, true)}>
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
