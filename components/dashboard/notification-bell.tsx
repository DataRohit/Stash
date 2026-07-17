"use client";

import { useOrganization } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import { ArrowLeft, Bell, CheckCheck, Loader2, Settings2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DataLoader, DataState } from "@/components/ui/data-state";
import { useAnchoredPosition, useOutsideClose } from "@/components/ui/floating";
import { notify } from "@/components/ui/toast";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export function NotificationBell() {
  const router = useRouter();
  const { organization } = useOrganization();
  const clerkOrgId = organization?.id;
  const unreadCount = useQuery(api.comments.unreadCount);
  const notifications = useQuery(api.comments.listMine);
  const markRead = useMutation(api.comments.markRead);
  const markAllRead = useMutation(api.comments.markAllRead);
  const emailPreferences = useQuery(api.email.getPreferences, clerkOrgId ? { clerkOrgId } : "skip");
  const watchPreferences = useQuery(
    api.watches.getPreferences,
    clerkOrgId ? { clerkOrgId } : "skip",
  );
  const setEmailPreferences = useMutation(api.email.setPreferences);
  const setAutoWatch = useMutation(api.watches.setAutoWatch);
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const floatingRef = useRef<HTMLDivElement>(null);
  const ref = useOutsideClose(() => setOpen(false), floatingRef);
  const position = useAnchoredPosition({
    open,
    anchorRef: ref,
    floatingRef,
    estimatedHeight: 440,
    requestedWidth: 384,
    align: "end",
  });

  const openNotification = async (notification: NonNullable<typeof notifications>[number]) => {
    await markRead({ notificationId: notification.id as Id<"notifications"> });
    setOpen(false);
    router.push(
      `/dashboard/projects/${notification.projectId}/editor?file=${notification.documentId}&thread=${notification.commentId}`,
    );
  };

  const clearAll = async () => {
    setBusy(true);
    try {
      await markAllRead({});
    } finally {
      setBusy(false);
    }
  };

  const updateEmail = async (
    kind: "mention" | "reply" | "resolved" | "reopened" | "watching",
    choice: "immediate" | "digest" | "off",
  ) => {
    if (!clerkOrgId || !emailPreferences) return;
    try {
      await setEmailPreferences({ ...emailPreferences, [kind]: choice, clerkOrgId });
      notify.success("Email preference updated");
    } catch {
      notify.error("Couldn’t update email preference", { description: "Please try again." });
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label="Notifications"
        aria-expanded={open}
        className={cn(
          "relative flex size-8 cursor-pointer items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground",
          open && "bg-foreground/[0.08] text-foreground",
        )}
      >
        <Bell className="size-4" aria-hidden="true" />
        {unreadCount ? (
          <span className="absolute -top-1 -right-1 flex min-w-4 items-center justify-center rounded-full bg-accent px-1 font-mono text-[9px] text-background">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        ) : null}
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={floatingRef}
              className="fixed z-[180] overflow-hidden rounded-lg border border-hairline bg-surface p-1 shadow-xl"
              style={position}
            >
              <div className="flex items-center justify-between gap-2 px-2 py-1.5">
                <button
                  type="button"
                  onClick={() => setSettings(false)}
                  className="inline-flex h-7 items-center gap-1 rounded-xs px-2 font-medium font-mono text-[10px] text-muted-foreground uppercase tracking-widest hover:bg-foreground/[0.06] hover:text-foreground"
                >
                  {settings ? <ArrowLeft className="size-3" aria-hidden="true" /> : null}
                  {settings ? "Notifications" : "Notifications"}
                </button>
                <div className="flex items-center gap-1">
                  {!settings ? (
                    <button
                      type="button"
                      onClick={() => setSettings(true)}
                      aria-label="Notification settings"
                      className="flex size-7 items-center justify-center rounded-xs text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
                    >
                      <Settings2 className="size-3.5" aria-hidden="true" />
                    </button>
                  ) : null}
                  {!settings ? (
                    <button
                      type="button"
                      onClick={clearAll}
                      disabled={busy || !unreadCount}
                      className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-xs px-2 text-muted-foreground text-xs transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {busy ? (
                        <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                      ) : (
                        <CheckCheck className="size-3" aria-hidden="true" />
                      )}
                      Mark read
                    </button>
                  ) : null}
                </div>
              </div>
              {settings ? (
                emailPreferences === undefined || watchPreferences === undefined ? (
                  <DataLoader label="Loading notification settings" compact />
                ) : emailPreferences && watchPreferences ? (
                  <div className="thin-scrollbar max-h-96 space-y-4 overflow-auto p-3">
                    <div>
                      <h3 className="font-medium text-sm">Email delivery</h3>
                      <p className="mt-1 text-muted-foreground text-xs">
                        Immediate messages wait briefly and are skipped if you read them in Stash.
                        Digest messages arrive once daily.
                      </p>
                    </div>
                    {(
                      [
                        ["mention", "Mentions"],
                        ["reply", "Replies"],
                        ["resolved", "Resolutions"],
                        ["reopened", "Reopened threads"],
                        ["watching", "Watched documents"],
                      ] as const
                    ).map(([kind, label]) => (
                      <label key={kind} className="flex items-center justify-between gap-4 text-xs">
                        <span>{label}</span>
                        <select
                          value={emailPreferences[kind]}
                          onChange={(event) =>
                            void updateEmail(
                              kind,
                              event.target.value as "immediate" | "digest" | "off",
                            )
                          }
                          className="h-8 rounded-sm border border-hairline bg-surface px-2 text-xs"
                        >
                          <option value="immediate">Immediate</option>
                          <option value="digest">Daily digest</option>
                          <option value="off">Off</option>
                        </select>
                      </label>
                    ))}
                    <label className="flex items-start gap-3 rounded-md border border-hairline p-3 text-xs">
                      <input
                        type="checkbox"
                        checked={watchPreferences.autoWatch}
                        onChange={async (event) => {
                          if (!clerkOrgId) return;
                          try {
                            await setAutoWatch({ clerkOrgId, autoWatch: event.target.checked });
                            notify.success("Watch preference updated");
                          } catch {
                            notify.error("Couldn’t update watch preference");
                          }
                        }}
                        className="mt-0.5 size-4"
                      />
                      <span>
                        <strong className="block font-medium">
                          Watch my documents automatically
                        </strong>
                        <span className="mt-1 block text-muted-foreground">
                          New documents and documents you comment on are watched by default.
                        </span>
                      </span>
                    </label>
                    <div className="rounded-md bg-foreground/[0.04] p-3 text-xs">
                      <p className="font-medium">Example</p>
                      <p className="mt-1 text-muted-foreground">
                        “A teammate mentioned you in Project brief” with one button that opens the
                        thread.
                      </p>
                    </div>
                  </div>
                ) : (
                  <DataState
                    kind="error"
                    title="Settings unavailable"
                    description="Refresh and try again."
                    compact
                  />
                )
              ) : notifications === undefined ? (
                <DataLoader label="Loading notifications" compact />
              ) : notifications.length === 0 ? (
                <DataState
                  title="No notifications"
                  description="Mentions, replies, and thread updates will appear here."
                  compact
                  className="m-2"
                />
              ) : (
                <ul className="thin-scrollbar max-h-96 overflow-auto">
                  {notifications.map((notification) => (
                    <li key={notification.id}>
                      <button
                        type="button"
                        onClick={() => void openNotification(notification)}
                        className="flex w-full cursor-pointer flex-col gap-1 rounded-md px-2 py-2 text-left transition-colors hover:bg-foreground/[0.05]"
                      >
                        <span className="flex items-center justify-between gap-2">
                          <span className="min-w-0 truncate text-xs">
                            {notification.actorName}{" "}
                            {notification.kind === "reply"
                              ? "replied to a thread"
                              : notification.kind === "resolved"
                                ? "resolved a thread"
                                : notification.kind === "reopened"
                                  ? "reopened a thread"
                                  : notification.kind === "watching"
                                    ? "commented on a document you watch"
                                    : "mentioned you"}
                          </span>
                          <time
                            dateTime={new Date(notification.createdAt).toISOString()}
                            title={formatDateTime(notification.createdAt)}
                            className="shrink-0 text-[10px] text-muted-foreground"
                          >
                            {formatRelativeTime(notification.createdAt)}
                          </time>
                        </span>
                        <span className="truncate text-[11px] text-muted-foreground">
                          {notification.projectTitle} / {notification.documentName}
                        </span>
                        <span className="line-clamp-2 text-[11px] text-muted-foreground/90 leading-relaxed">
                          {notification.bodySnippet}
                        </span>
                        {notification.readAt === null ? (
                          <span className="mt-0.5 size-1.5 rounded-full bg-accent" />
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
