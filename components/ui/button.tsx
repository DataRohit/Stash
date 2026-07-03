import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  "inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-[6px] font-medium font-mono text-xs outline-none transition-all duration-200 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "larry-shadow bg-foreground text-background hover:bg-foreground/90",
        secondary:
          "press-shadow hairline bg-surface/45 text-foreground backdrop-blur hover:bg-foreground/[0.05]",
        ghost:
          "bg-transparent text-muted-foreground shadow-none hover:bg-foreground/[0.05] hover:text-foreground",
        destructive:
          "press-shadow hairline bg-surface/45 text-destructive backdrop-blur hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive",
        success:
          "press-shadow hairline bg-surface/45 text-success backdrop-blur hover:border-success/40 hover:bg-success/10 hover:text-success",
        upgrade:
          "gold-surface gold-glow border border-signal/60 font-semibold text-signal-foreground hover:brightness-[1.06]",
      },
      size: {
        default: "h-9 px-4",
        sm: "h-8 px-3",
        lg: "h-11 px-5",
        icon: "size-9",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  },
);

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, type = "button", ...props }: ButtonProps) {
  return (
    <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  );
}
