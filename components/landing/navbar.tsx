"use client";

import { Show, UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ThemeToggle } from "@/components/landing/theme-toggle";
import { buttonVariants } from "@/components/ui/button";
import { navLinks, site } from "@/lib/site";
import { cn } from "@/lib/utils";

export function Navbar() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={cn(
        "fixed top-3 right-0 left-0 z-50 w-full px-3 transition-all duration-300 sm:px-6",
        scrolled ? "translate-y-0" : "translate-y-0",
      )}
    >
      <div
        className={cn(
          "glass mx-auto flex h-14 max-w-7xl items-center justify-between rounded-[12px] px-3 sm:px-4",
          scrolled ? "bg-surface/80" : "bg-surface/55",
        )}
      >
        <Link href="/" className="flex items-center gap-2.5">
          <span className="flex size-7 items-center justify-center rounded-[6px] border border-hairline bg-foreground font-bold font-mono text-background text-sm">
            S
          </span>
          <span className="font-semibold text-sm tracking-display">{site.name}</span>
        </Link>

        <nav className="hidden items-center gap-7 md:flex">
          {navLinks.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="rounded-[5px] px-2 py-1.5 font-medium font-mono text-muted-foreground text-xs uppercase tracking-wider transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Show when="signed-out">
            <Link href="/sign-in" className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>
              Sign in
            </Link>
            <Link
              href="/sign-up"
              className={cn(buttonVariants({ variant: "primary", size: "sm" }))}
            >
              Sign up
            </Link>
          </Show>
          <Show when="signed-in">
            <Link
              href="/dashboard"
              className={cn(buttonVariants({ variant: "secondary" }), "text-xs")}
            >
              Dashboard
            </Link>
            <UserButton />
          </Show>
        </div>
      </div>
    </header>
  );
}
