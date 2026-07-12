import type { ReactNode } from "react";
import { DashboardHeader } from "@/components/dashboard/dashboard-header";
import { QuickOpen } from "@/components/dashboard/quick-open";
import { GridBackground } from "@/components/landing/grid-background";
import { ConvexClientProvider } from "@/components/providers/ConvexClientProvider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getUserSubscription } from "@/lib/subscription";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const subscription = await getUserSubscription();

  return (
    <ConvexClientProvider>
      <div className="app-aurora isolate min-h-screen overflow-hidden">
        <div className="pointer-events-none absolute inset-0 -z-10" aria-hidden="true">
          <GridBackground ripples={false} fade={false} />
        </div>
        <DashboardHeader
          isPro={subscription.isPro}
          planPeriod={subscription.planPeriod}
          periodEnd={subscription.periodEnd}
          canceled={subscription.canceled}
        />
        <TooltipProvider />
        <QuickOpen />
        {children}
      </div>
    </ConvexClientProvider>
  );
}
