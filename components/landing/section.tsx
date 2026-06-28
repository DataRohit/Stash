import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type SectionProps = {
  id?: string;
  children: ReactNode;
  className?: string;
};

export function Section({ id, children, className }: SectionProps) {
  return (
    <section id={id} className="border-hairline border-t">
      <div className={cn("mx-auto max-w-7xl px-6 py-20 sm:py-24", className)}>{children}</div>
    </section>
  );
}
