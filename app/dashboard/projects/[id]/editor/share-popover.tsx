"use client";

import { Building2, Copy, ExternalLink, Globe2, Loader2, LockKeyhole } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export type ShareMode = "private" | "org" | "public";

export type ShareState = {
  mode: ShareMode;
  token: string | null;
  updatedByName: string | null;
  updatedAt: number | null;
  canPublish: boolean;
  events: {
    id: string;
    actorName: string;
    previousMode: ShareMode;
    nextMode: ShareMode;
    createdAt: number;
  }[];
};

type SharePopoverProps = {
  open: boolean;
  onClose: () => void;
  state: ShareState | null | undefined;
  origin: string;
  onSetMode: (mode: ShareMode) => Promise<void>;
  onCopy: (url: string) => Promise<void>;
};

const MODES = [
  {
    mode: "private" as const,
    icon: LockKeyhole,
    label: "Private",
    description: "Only project members can open this file in Stash.",
  },
  {
    mode: "org" as const,
    icon: Building2,
    label: "Organization",
    description: "Anyone in this organization can view the link after signing in.",
  },
  {
    mode: "public" as const,
    icon: Globe2,
    label: "Public read",
    description: "Anyone with the link can view a read-only preview.",
  },
];

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString([], {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  });
}

function modeLabel(mode: ShareMode): string {
  if (mode === "public") {
    return "Public read";
  }
  if (mode === "org") {
    return "Organization";
  }
  return "Private";
}

export function SharePopover({
  open,
  onClose,
  state,
  origin,
  onSetMode,
  onCopy,
}: SharePopoverProps) {
  const [busyMode, setBusyMode] = useState<ShareMode | null>(null);
  const [copying, setCopying] = useState(false);
  const shareUrl = state?.token ? `${origin}/share/${state.token}` : null;

  const setMode = async (mode: ShareMode) => {
    setBusyMode(mode);
    try {
      await onSetMode(mode);
    } catch {
    } finally {
      setBusyMode(null);
    }
  };

  const copy = async () => {
    if (!shareUrl) {
      return;
    }
    setCopying(true);
    try {
      await onCopy(shareUrl);
    } catch {
    } finally {
      setCopying(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Share document"
      icon={<Globe2 className="size-3.5" aria-hidden="true" />}
      description="Choose who can open this document and manage its read-only link."
      className="max-w-md"
    >
      <div className="p-2">
        <div className="flex items-center justify-between gap-2 px-2 py-1.5">
          <span className="font-medium text-muted-foreground text-xs">Access</span>
          {state === undefined ? (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden="true" />
          ) : null}
        </div>

        <div className="space-y-1 p-1">
          {MODES.map(({ mode, icon: Icon, label, description }) => {
            const active = state?.mode === mode;
            const disabled =
              state === undefined || (mode === "public" && state?.canPublish === false);
            return (
              <button
                key={mode}
                type="button"
                disabled={disabled || busyMode !== null}
                onClick={() => void setMode(mode)}
                className={cn(
                  "flex w-full cursor-pointer items-start gap-2 rounded-md border px-2.5 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-55",
                  active
                    ? "border-accent/45 bg-accent/10"
                    : "border-transparent hover:bg-foreground/[0.05]",
                )}
              >
                {busyMode === mode ? (
                  <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />
                ) : (
                  <Icon
                    className={cn(
                      "mt-0.5 size-4 shrink-0",
                      active ? "text-accent" : "text-muted-foreground",
                    )}
                    aria-hidden="true"
                  />
                )}
                <span className="min-w-0">
                  <span className="block font-medium text-xs">{label}</span>
                  <span className="block text-[11px] text-muted-foreground leading-relaxed">
                    {description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="border-hairline border-t p-2">
          {shareUrl ? (
            <div className="flex gap-1.5">
              <input
                readOnly
                value={shareUrl}
                className="h-8 min-w-0 flex-1 rounded-sm border border-hairline bg-[var(--editor-control)] px-2 font-mono text-[11px] text-muted-foreground outline-none"
              />
              <button
                type="button"
                onClick={() => void copy()}
                disabled={copying}
                className="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-sm border border-hairline px-2.5 font-medium text-muted-foreground text-xs transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
              >
                {copying ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Copy className="size-3.5" aria-hidden="true" />
                )}
                Copy
              </button>
              <Link
                href={shareUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex h-8 shrink-0 cursor-pointer items-center justify-center rounded-sm border border-hairline px-2.5 text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
                aria-label="Open share link"
              >
                <ExternalLink className="size-3.5" aria-hidden="true" />
              </Link>
            </div>
          ) : (
            <p className="rounded-sm bg-foreground/[0.04] px-2 py-2 text-[11px] text-muted-foreground leading-relaxed">
              Set Organization or Public Read to create a share link. Switching back to Private
              revokes the link.
            </p>
          )}
        </div>

        {state?.events.length ? (
          <div className="border-hairline border-t px-2 py-2">
            <p className="mb-1.5 font-medium font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
              Recent activity
            </p>
            <ul className="space-y-1">
              {state.events.map((event) => (
                <li key={event.id} className="text-[11px] text-muted-foreground leading-relaxed">
                  <span className="text-foreground">{event.actorName}</span> changed{" "}
                  {modeLabel(event.previousMode)} to {modeLabel(event.nextMode)} /{" "}
                  {formatTime(event.createdAt)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
