import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "press-shadow inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 font-medium text-xs uppercase tracking-wider",
  {
    variants: {
      variant: {
        outline: "border-hairline bg-surface/35 text-muted-foreground backdrop-blur",
        solid: "border-foreground bg-foreground text-background",
        surface: "border-hairline bg-surface/65 text-foreground backdrop-blur",
      },
    },
    defaultVariants: {
      variant: "outline",
    },
  },
);

type BadgeProps = HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>;

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
