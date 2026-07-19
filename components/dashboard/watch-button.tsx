"use client";

import { useMutation } from "convex/react";
import { Eye } from "lucide-react";
import { useState } from "react";
import { notify } from "@/components/ui/toast";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { cn } from "@/lib/utils";

export function WatchButton({
  documentId,
  watching,
  compact = false,
  menu = false,
  disabled = false,
  onToggled,
}: {
  documentId: string;
  watching: boolean;
  compact?: boolean;
  menu?: boolean;
  disabled?: boolean;
  onToggled?: () => void;
}) {
  const update = useMutation(api.watches.setWatching);
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const active = optimistic ?? watching;
  return (
    <button
      type="button"
      {...(menu
        ? { role: "menuitemcheckbox" as const, "aria-checked": active }
        : { "aria-pressed": active })}
      aria-label={active ? "Stop watching document" : "Watch document"}
      title={
        disabled
          ? "Watching is unavailable while offline"
          : active
            ? "Watching new comments"
            : "Notify me about new comments"
      }
      disabled={busy || disabled}
      onClick={async () => {
        if (disabled) return;
        const next = !active;
        setOptimistic(next);
        setBusy(true);
        try {
          await update({ documentId: documentId as Id<"documents">, watching: next });
          notify.success(next ? "Watching document" : "Stopped watching document");
        } catch {
          setOptimistic(null);
          notify.error("Couldn’t update watch", { description: "Please try again." });
        } finally {
          setBusy(false);
          onToggled?.();
          window.setTimeout(() => setOptimistic(null), 250);
        }
      }}
      className={cn(
        "flex shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
        menu ? "h-8 w-full gap-2 px-2 text-left text-xs" : compact ? "size-8" : "size-11",
        active && "text-info",
      )}
    >
      <Eye className={cn("size-4", active && "fill-current/20")} aria-hidden="true" />
      {menu ? <span className="flex-1">{active ? "Stop watching" : "Watch document"}</span> : null}
    </button>
  );
}
