"use client";

import {
  Building2,
  Clock,
  Copy,
  ExternalLink,
  Globe2,
  Loader2,
  LockKeyhole,
  RotateCw,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export type ShareMode = "private" | "org" | "public";

export type ShareState = {
  mode: ShareMode;
  token: string | null;
  expiresAt: number | null;
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
  onSetMode: (mode: ShareMode, expiresAt?: number | null) => Promise<void>;
  onRotate: () => Promise<void>;
  onCopy: (url: string) => Promise<void>;
};

const DAY_MS = 24 * 60 * 60 * 1000;

const EXPIRY_PRESETS = [
  { label: "24h", ms: DAY_MS },
  { label: "7d", ms: 7 * DAY_MS },
  { label: "30d", ms: 30 * DAY_MS },
];

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

function modeLabel(mode: ShareMode): string {
  if (mode === "public") {
    return "Public read";
  }
  if (mode === "org") {
    return "Organization";
  }
  return "Private";
}

function expiryHint(expiresAt: number | null): string {
  if (!expiresAt) {
    return "Link never expires.";
  }
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) {
    return "This link has expired.";
  }
  const days = Math.floor(remaining / DAY_MS);
  if (days >= 1) {
    return `Expires in ${days} ${days === 1 ? "day" : "days"}.`;
  }
  const hours = Math.max(1, Math.ceil(remaining / (60 * 60 * 1000)));
  return `Expires in ${hours} ${hours === 1 ? "hour" : "hours"}.`;
}

export function SharePopover({
  open,
  onClose,
  state,
  origin,
  onSetMode,
  onRotate,
  onCopy,
}: SharePopoverProps) {
  const [busyMode, setBusyMode] = useState<ShareMode | null>(null);
  const [copying, setCopying] = useState(false);
  const [busyExpiry, setBusyExpiry] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
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

  const setExpiry = async (expiresAt: number | null) => {
    if (!state || state.mode === "private") {
      return;
    }
    setBusyExpiry(true);
    try {
      await onSetMode(state.mode, expiresAt);
    } catch {
    } finally {
      setBusyExpiry(false);
    }
  };

  const rotate = async () => {
    setRotating(true);
    try {
      await onRotate();
      setConfirmRotate(false);
    } catch {
    } finally {
      setRotating(false);
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
                aria-label="Share link"
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

        {shareUrl && state ? (
          <div className="flex flex-col gap-2 border-hairline border-t p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 font-medium text-muted-foreground text-xs">
                <Clock className="size-3.5" aria-hidden="true" />
                Expiry
              </span>
              <span className="font-mono text-[10px] text-muted-foreground">
                {expiryHint(state.expiresAt)}
              </span>
            </div>
            <fieldset className="flex items-center gap-1">
              <legend className="sr-only">Link expiry</legend>
              <button
                type="button"
                disabled={busyExpiry}
                aria-pressed={!state.expiresAt}
                onClick={() => void setExpiry(null)}
                className={cn(
                  "flex h-7 flex-1 cursor-pointer items-center justify-center rounded-sm border font-medium text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                  state.expiresAt
                    ? "border-hairline text-muted-foreground hover:bg-foreground/[0.05]"
                    : "border-accent/45 bg-accent/10 text-foreground",
                )}
              >
                None
              </button>
              {EXPIRY_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  disabled={busyExpiry}
                  onClick={() => void setExpiry(Date.now() + preset.ms)}
                  className="flex h-7 flex-1 cursor-pointer items-center justify-center rounded-sm border border-hairline font-medium text-[11px] text-muted-foreground transition-colors hover:bg-foreground/[0.05] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {preset.label}
                </button>
              ))}
            </fieldset>
            {confirmRotate ? (
              <div className="flex items-center justify-between gap-2 rounded-sm bg-foreground/[0.04] px-2 py-1.5">
                <span className="text-[11px] text-muted-foreground leading-relaxed">
                  Rotating breaks the current link immediately.
                </span>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => void rotate()}
                    disabled={rotating}
                    className="flex h-7 cursor-pointer items-center gap-1 rounded-sm bg-destructive px-2 font-medium text-[11px] text-background transition-colors hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {rotating ? (
                      <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                    ) : null}
                    Rotate
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmRotate(false)}
                    disabled={rotating}
                    className="flex h-7 cursor-pointer items-center rounded-sm border border-hairline px-2 font-medium text-[11px] text-muted-foreground transition-colors hover:bg-foreground/[0.06]"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmRotate(true)}
                className="flex h-7 cursor-pointer items-center gap-1.5 self-start rounded-sm px-1.5 font-medium text-[11px] text-muted-foreground transition-colors hover:text-foreground"
              >
                <RotateCw className="size-3.5" aria-hidden="true" />
                Rotate link
              </button>
            )}
          </div>
        ) : null}

        {state?.events.length ? (
          <div className="border-hairline border-t px-2 py-2">
            <p className="mb-1.5 font-medium font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
              Recent activity
            </p>
            <ul className="space-y-1">
              {state.events.map((event) => (
                <li key={event.id} className="text-[11px] text-muted-foreground leading-relaxed">
                  <span className="text-foreground">{event.actorName}</span>{" "}
                  {event.previousMode === event.nextMode
                    ? `rotated the ${modeLabel(event.nextMode)} link`
                    : `changed ${modeLabel(event.previousMode)} to ${modeLabel(event.nextMode)}`}{" "}
                  /{" "}
                  <time
                    dateTime={new Date(event.createdAt).toISOString()}
                    title={formatDateTime(event.createdAt)}
                  >
                    {formatRelativeTime(event.createdAt)}
                  </time>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
