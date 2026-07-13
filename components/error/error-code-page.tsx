"use client";

import { ArrowLeft, ArrowRight, RotateCcw } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ErrorCodePageProps = {
  code: string;
  title: string;
  description: string;
  onRetry?: () => void;
  retryLabel?: string;
  showDashboard?: boolean;
};

export function ErrorCodePage({
  code,
  title,
  description,
  onRetry,
  retryLabel = "Try again",
  showDashboard = true,
}: ErrorCodePageProps) {
  return (
    <main className="aurora isolate flex min-h-screen items-center justify-center overflow-hidden px-6 py-20">
      <section className="glass-strong w-full max-w-3xl overflow-hidden rounded-lg">
        <div className="border-hairline border-b bg-foreground/[0.025] px-5 py-3.5 sm:px-6">
          <span className="font-medium font-mono text-muted-foreground text-xs uppercase tracking-widest">
            Error code
          </span>
        </div>
        <div className="p-6 sm:p-9">
          <Badge variant="surface">
            <span className="live-dot size-1.5" aria-hidden="true" />
            {code}
          </Badge>
          <h1 className="mt-7 max-w-2xl font-serif text-5xl leading-[0.98] tracking-display sm:text-6xl">
            {title}
          </h1>
          <p className="mt-5 max-w-xl text-base text-muted-foreground leading-relaxed">
            {description}
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link href="/" className={cn(buttonVariants({ size: "lg" }), "group")}>
              <ArrowLeft className="size-4" />
              Go home
            </Link>
            {showDashboard ? (
              <Link
                href="/dashboard"
                className={cn(buttonVariants({ variant: "secondary", size: "lg" }), "group")}
              >
                Dashboard
                <ArrowRight className="cta-arrow size-4" />
              </Link>
            ) : null}
            {onRetry ? (
              <button
                type="button"
                onClick={onRetry}
                className={cn(buttonVariants({ variant: "secondary", size: "lg" }))}
              >
                <RotateCcw className="size-4" />
                {retryLabel}
              </button>
            ) : null}
          </div>
        </div>
      </section>
    </main>
  );
}
