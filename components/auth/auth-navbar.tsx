"use client";

import { Show, UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { ThemeToggle } from "@/components/landing/theme-toggle";
import { buttonVariants } from "@/components/ui/button";
import { site } from "@/lib/site";
import { cn } from "@/lib/utils";

export function AuthNavbar() {
  return (
    <header className="fixed top-3 right-0 left-0 z-50 w-full px-3 sm:px-6">
      <div className="glass mx-auto flex h-14 max-w-7xl items-center justify-between rounded-lg bg-surface/55 px-3 sm:px-4">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="flex size-7 items-center justify-center rounded-sm border border-hairline bg-foreground font-bold font-mono text-background text-sm">
            S
          </span>
          <span className="font-semibold text-sm tracking-display">{site.name}</span>
        </Link>

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
            <Link href="/dashboard" className={cn(buttonVariants({ variant: "secondary" }))}>
              Dashboard
            </Link>
            <UserButton />
          </Show>
        </div>
      </div>
    </header>
  );
}
