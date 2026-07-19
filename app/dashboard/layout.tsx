import type { ReactNode } from "react";
import { DashboardHeader } from "@/components/dashboard/dashboard-header";
import { QuickOpen } from "@/components/dashboard/quick-open";
import { ConvexClientProvider } from "@/components/providers/ConvexClientProvider";
import { OfflinePolicyProvider } from "@/components/providers/OfflinePolicyProvider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getUserSubscription } from "@/lib/subscription";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const subscription = await getUserSubscription();

  return (
    <ConvexClientProvider>
      <OfflinePolicyProvider />
      <div className="app-aurora isolate min-h-screen overflow-hidden">
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
