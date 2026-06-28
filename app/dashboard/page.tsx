import { UserButton } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { GridBackground } from "@/components/landing/grid-background";
import { ThemeToggle } from "@/components/landing/theme-toggle";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  title: "Dashboard",
};

export default async function DashboardPage() {
  const { isAuthenticated } = await auth();

  if (!isAuthenticated) {
    redirect("/sign-in");
  }

  return (
    <div className="aurora isolate min-h-screen overflow-hidden">
      <div className="pointer-events-none absolute inset-0 -z-10" aria-hidden="true">
        <GridBackground ripples={false} />
      </div>
      <header className="fixed top-3 right-0 left-0 z-50 w-full px-3 sm:px-6">
        <div className="glass mx-auto flex h-14 max-w-7xl items-center justify-between rounded-[12px] bg-surface/80 px-3 sm:px-4">
          <Link href="/dashboard" className="flex items-center gap-2.5">
            <span className="flex size-7 items-center justify-center rounded-[6px] border border-hairline bg-foreground font-bold font-mono text-background text-sm">
              S
            </span>
            <span className="font-semibold text-sm tracking-display">{site.name}</span>
          </Link>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <UserButton
              appearance={{
                elements: {
                  userButtonAvatarBox: "rounded-[6px]",
                },
              }}
            />
          </div>
        </div>
      </header>
    </div>
  );
}
