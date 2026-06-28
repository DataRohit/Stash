import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type PanelProps = {
  label: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
};

export function Panel({ label, meta, children, className }: PanelProps) {
  return (
    <div className={cn("glass overflow-hidden rounded-[12px]", className)}>
      <div className="flex items-center justify-between gap-4 border-hairline border-b bg-foreground/[0.025] px-5 py-3.5 sm:px-6">
        <span className="font-medium font-mono text-muted-foreground text-xs uppercase tracking-widest">
          {label}
        </span>
        {meta ? (
          <span className="shrink-0 font-mono text-muted-foreground text-xs uppercase tracking-widest">
            {meta}
          </span>
        ) : null}
      </div>
      {children}
    </div>
  );
}
