"use client";

import { useMutation } from "convex/react";
import { Star } from "lucide-react";
import { useState } from "react";
import { notify } from "@/components/ui/toast";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { cn } from "@/lib/utils";

export function FavoriteButton({
  projectId,
  documentId,
  favorite,
  className,
}: {
  projectId: string;
  documentId?: string;
  favorite: boolean;
  className?: string;
}) {
  const setFavorite = useMutation(api.navigation.toggleFavorite);
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const active = optimistic ?? favorite;
  const toggle = async () => {
    if (busy) return;
    const next = !active;
    setOptimistic(next);
    setBusy(true);
    try {
      await setFavorite({
        projectId: projectId as Id<"projects">,
        ...(documentId ? { documentId: documentId as Id<"documents"> } : {}),
        favorite: next,
      });
      notify.success(next ? "Added to favorites" : "Removed from favorites");
    } catch (error) {
      setOptimistic(null);
      notify.error("Couldn’t update favorite", {
        description:
          error instanceof Error && error.message.includes("favorite-limit-reached")
            ? "You can keep up to 200 favorites in an organization."
            : "Please try again.",
      });
    } finally {
      setBusy(false);
      window.setTimeout(() => setOptimistic(null), 250);
    }
  };
  return (
    <button
      type="button"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void toggle();
      }}
      disabled={busy}
      aria-pressed={active}
      aria-label={active ? "Remove from favorites" : "Add to favorites"}
      className={cn(
        "flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-transform hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 motion-safe:active:scale-90",
        active && "text-signal",
        className,
      )}
    >
      <Star
        className={cn(
          "size-4 transition-transform",
          active && "fill-current motion-safe:scale-110",
        )}
        aria-hidden="true"
      />
    </button>
  );
}
