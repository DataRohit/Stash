"use client";

import { useClerk } from "@clerk/nextjs";
import { Crown } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type PlanBadgeProps = {
  isPro: boolean;
  planPeriod: "month" | "year" | null;
  periodEnd: number | null;
  canceled: boolean;
};

const dateFormatter = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });

export function PlanBadge({ isPro, planPeriod, periodEnd, canceled }: PlanBadgeProps) {
  const clerk = useClerk();
  const router = useRouter();
  const hasMounted = useRef(false);

  useEffect(() => {
    return clerk.addListener(() => {
      if (!hasMounted.current) {
        hasMounted.current = true;
        return;
      }
      router.refresh();
    });
  }, [clerk, router]);

  const periodLabel =
    isPro && periodEnd
      ? `${canceled ? "Ends" : "Renews"} ${dateFormatter.format(new Date(periodEnd))}${
          canceled ? "" : planPeriod === "year" ? " · yearly" : " · monthly"
        }`
      : null;

  return (
    <button
      type="button"
      onClick={() => clerk.openUserProfile()}
      className="flex cursor-pointer items-center gap-2 rounded-[6px] transition-opacity hover:opacity-80"
      aria-label={isPro ? "Manage your Pro subscription" : "Upgrade to Pro"}
    >
      <Badge
        variant={isPro ? "solid" : "outline"}
        className={cn(
          isPro &&
            (canceled
              ? "border-warning/50 bg-warning/10 text-warning"
              : "gold-surface gold-glow border-signal/60 text-signal-foreground"),
        )}
      >
        {isPro ? <Crown className="size-3 shrink-0" aria-hidden="true" /> : null}
        <span>{isPro ? "Pro" : "Free"}</span>
      </Badge>
      {periodLabel ? (
        <span
          className={cn(
            "hidden font-mono text-xs sm:inline",
            canceled ? "text-warning" : "text-muted-foreground",
          )}
        >
          {periodLabel}
        </span>
      ) : null}
    </button>
  );
}
