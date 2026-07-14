"use client";

import { useMutation, useQuery } from "convex/react";
import { Bell, CheckCheck, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { DataLoader, DataState } from "@/components/ui/data-state";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export function NotificationBell() {
  const router = useRouter();
  const unreadCount = useQuery(api.comments.unreadCount);
  const notifications = useQuery(api.comments.listMine);
  const markRead = useMutation(api.comments.markRead);
  const markAllRead = useMutation(api.comments.markAllRead);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, [open]);

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
      {open ? (
        <div className="absolute top-10 right-0 z-[90] w-96 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-hairline bg-surface p-1 shadow-xl">
          <div className="flex items-center justify-between gap-2 px-2 py-1.5">
            <span className="font-medium font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
              Notifications
            </span>
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
          </div>
          {notifications === undefined ? (
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
        </div>
      ) : null}
    </div>
  );
}
