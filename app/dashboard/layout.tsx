import type { ReactNode } from "react";
import { DashboardHeader } from "@/components/dashboard/dashboard-header";
import { GridBackground } from "@/components/landing/grid-background";
import { getUserSubscription } from "@/lib/subscription";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const subscription = await getUserSubscription();

  return (
    <div className="aurora isolate min-h-screen overflow-hidden">
      <div className="pointer-events-none absolute inset-0 -z-10" aria-hidden="true">
        <GridBackground ripples={false} />
      </div>
      <DashboardHeader
        isPro={subscription.isPro}
        planPeriod={subscription.planPeriod}
        periodEnd={subscription.periodEnd}
        canceled={subscription.canceled}
      />
      {children}
    </div>
  );
}
