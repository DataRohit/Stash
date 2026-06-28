"use client";

import { Show } from "@clerk/nextjs";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type AuthEntryButtonProps = {
  className?: string;
  signedOutLabel: string;
  signedInLabel: string;
};

export function AuthEntryButton({
  className,
  signedOutLabel,
  signedInLabel,
}: AuthEntryButtonProps) {
  return (
    <>
      <Show when="signed-out">
        <Link href="/sign-up" className={cn(buttonVariants({ size: "lg" }), "group", className)}>
          {signedOutLabel}
          <ArrowRight className="cta-arrow size-4" />
        </Link>
      </Show>
      <Show when="signed-in">
        <Link href="/dashboard" className={cn(buttonVariants({ size: "lg" }), "group", className)}>
          {signedInLabel}
          <ArrowRight className="cta-arrow size-4" />
        </Link>
      </Show>
    </>
  );
}
