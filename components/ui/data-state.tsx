import { AlertTriangle, Inbox } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const SKELETON_KEYS = ["one", "two", "three", "four", "five", "six", "seven", "eight"];

type DataStateProps = {
  title: string;
  description?: string;
  icon?: ReactNode;
  kind?: "empty" | "error";
  compact?: boolean;
  className?: string;
};

export function DataState({
  title,
  description,
  icon,
  kind = "empty",
  compact = false,
  className,
}: DataStateProps) {
  const fallbackIcon =
    kind === "error" ? (
      <AlertTriangle className="size-5" aria-hidden="true" />
    ) : (
      <Inbox className="size-5" aria-hidden="true" />
    );
  return (
    <div
      role={kind === "error" ? "alert" : "status"}
      className={cn(
        "flex flex-col items-center justify-center rounded-md border border-hairline border-dashed text-center",
        compact ? "px-4 py-6" : "px-6 py-10",
        kind === "error" ? "text-destructive" : "text-muted-foreground",
        className,
      )}
    >
      {icon ?? fallbackIcon}
      <p className="mt-2 font-medium text-foreground text-sm">{title}</p>
      {description ? (
        <p className="mt-1 max-w-md text-muted-foreground text-xs leading-relaxed">{description}</p>
      ) : null}
    </div>
  );
}

export function DataSkeleton({
  label,
  rows = 3,
  compact = false,
  className,
}: {
  label: string;
  rows?: number;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-label={label}
      className={cn("flex animate-pulse flex-col gap-2", compact ? "p-3" : "p-5", className)}
    >
      {SKELETON_KEYS.slice(0, rows).map((key, index) => (
        <span
          key={key}
          className={cn(
            "h-10 rounded-md bg-foreground/[0.05]",
            index === rows - 1 && rows > 1 ? "w-2/3" : "w-full",
          )}
        />
      ))}
      <span className="sr-only">{label}</span>
    </div>
  );
}
