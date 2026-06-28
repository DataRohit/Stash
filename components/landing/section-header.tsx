import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type SectionHeaderProps = {
  kicker: string;
  title: ReactNode;
  description?: string;
  className?: string;
};

export function SectionHeader({ kicker, title, description, className }: SectionHeaderProps) {
  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <span className="font-medium font-mono text-muted-foreground text-xs uppercase tracking-widest">
        — {kicker}
      </span>
      <h2 className="max-w-2xl font-serif text-4xl leading-tight tracking-display sm:text-5xl">
        {title}
      </h2>
      {description ? (
        <p className="max-w-2xl text-muted-foreground text-sm leading-relaxed sm:text-base">
          {description}
        </p>
      ) : null}
    </div>
  );
}
