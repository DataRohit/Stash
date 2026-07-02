"use client";

import { useClerk } from "@clerk/nextjs";
import { Crown } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";

type UpgradeButtonProps = {
  label: string;
  highlight: boolean;
};

export function UpgradeButton({ label, highlight }: UpgradeButtonProps) {
  const clerk = useClerk();
  const router = useRouter();
  const wasProRef = useRef<boolean | null>(null);

  useEffect(() => {
    const evaluate = () => {
      const isPro = clerk.session?.checkAuthorization({ plan: "pro_user" }) ?? false;
      if (wasProRef.current === null) {
        wasProRef.current = isPro;
        return;
      }
      if (isPro !== wasProRef.current) {
        wasProRef.current = isPro;
        router.refresh();
      }
    };

    evaluate();
    return clerk.addListener(evaluate);
  }, [clerk, router]);

  return (
    <Button
      variant={highlight ? "upgrade" : "secondary"}
      className="w-full"
      onClick={() => clerk.openUserProfile()}
    >
      {highlight ? <Crown className="size-4" aria-hidden="true" /> : null}
      {label}
    </Button>
  );
}
