"use client";

import { useMutation, useQuery } from "convex/react";
import {
  BellOff,
  BellRing,
  FileClock,
  FolderTree,
  History,
  Loader2,
  Share2,
  UserRound,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { notify } from "@/components/ui/toast";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

type EventRow = NonNullable<
  ReturnType<typeof useQuery<typeof api.activity.listProjectEvents>>
>[number];

function description(event: EventRow) {
  const actions: Record<string, string> = {
    node_created: "created",
    documents_imported: "imported",
    document_duplicated: "duplicated",
    node_renamed: "renamed",
    node_moved: "moved",
    node_trashed: "moved to trash",
    node_restored: "restored",
    node_deleted: "permanently deleted",
    checkpoint_created: "created a checkpoint for",
    checkpoint_deleted: "deleted a checkpoint for",
    checkpoint_restored: "restored a checkpoint for",
    share_changed: "changed sharing for",
    access_granted: "granted access to",
    access_revoked: "revoked access from",
  };
  return actions[event.kind] ?? "updated";
}

function detailText(event: EventRow) {
  if (event.kind === "node_renamed")
    return event.previousValue && event.nextValue
      ? `${event.previousValue} → ${event.nextValue}`
      : null;
  if (event.kind === "node_moved") return event.nextValue ? `Moved to ${event.nextValue}` : null;
  if (event.kind === "document_duplicated")
    return event.previousValue ? `Copied from ${event.previousValue}` : null;
  if (event.kind === "share_changed")
    return event.previousValue && event.nextValue
      ? `${event.previousValue} → ${event.nextValue}`
      : null;
  return event.detail ?? null;
}

function iconFor(kind: string) {
  if (kind.startsWith("checkpoint")) return History;
  if (kind === "share_changed") return Share2;
  if (kind.startsWith("access")) return UserRound;
  if (kind === "node_moved" || kind === "documents_imported") return FolderTree;
  return FileClock;
}

function dayLabel(timestamp: number) {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString([], { dateStyle: "medium" });
}

export function ProjectActivity({ projectId }: { projectId: Id<"projects"> }) {
  const events = useQuery(api.activity.listProjectEvents, { projectId });
  const preference = useQuery(api.activity.getPreference, { projectId });
  const setMuted = useMutation(api.activity.setMuted);
  const [saving, setSaving] = useState(false);
  const toggle = async () => {
    if (!preference) return;
    setSaving(true);
    try {
      await setMuted({ projectId, muted: !preference.muted });
      notify.success(preference.muted ? "Notifications enabled" : "Project muted");
    } catch {
      notify.error("Couldn’t update notifications", { description: "Please try again." });
    } finally {
      setSaving(false);
    }
  };
  const groups = new Map<string, NonNullable<typeof events>>();
  for (const event of events ?? []) {
    const key = dayLabel(event.createdAt);
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }
  return (
    <section className="glass w-full rounded-lg p-5 sm:p-8">
      <div className="flex flex-col gap-4 border-hairline border-b pb-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-serif text-3xl tracking-display">Activity</h1>
          <p className="mt-1 text-muted-foreground text-sm">
            The latest changes across this project.
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={toggle}
          disabled={saving || preference === undefined || preference === null}
          className="sm:w-44"
        >
          {saving ? (
            <Loader2 className="size-4 animate-spin" />
          ) : preference?.muted ? (
            <BellOff className="size-4" />
          ) : (
            <BellRing className="size-4" />
          )}
          {preference?.muted ? "Unmute project" : "Mute project"}
        </Button>
      </div>
      <p className="border-hairline border-b py-3 text-muted-foreground text-xs">
        Muting stops future mentions, replies, and thread updates. Existing notifications and
        activity remain visible.
      </p>
      {events === undefined ? (
        <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground text-sm">
          <Loader2 className="size-4 animate-spin" />
          Loading activity…
        </div>
      ) : events.length === 0 ? (
        <div className="py-16 text-center">
          <FileClock className="mx-auto size-8 text-muted-foreground/50" />
          <p className="mt-3 text-muted-foreground text-sm">No project activity yet.</p>
        </div>
      ) : (
        <div className="mt-5 flex flex-col gap-6">
          {[...groups.entries()].map(([day, rows]) => (
            <section key={day}>
              <h2 className="mb-2 font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
                {day}
              </h2>
              <ul className="flex flex-col divide-y divide-hairline">
                {rows.map((event) => {
                  const Icon = iconFor(event.kind);
                  const target = event.documentId ? (
                    <Link
                      href={`/dashboard/projects/${projectId}/editor?file=${event.documentId}`}
                      className="font-medium text-foreground hover:text-accent"
                    >
                      {event.targetName}
                    </Link>
                  ) : (
                    <span className="font-medium text-foreground">{event.targetName}</span>
                  );
                  return (
                    <li key={event.id} className="flex gap-3 py-3">
                      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-foreground/[0.05] text-muted-foreground">
                        <Icon className="size-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm">
                          <span className="font-medium">{event.actorName}</span>{" "}
                          {description(event)} {target}
                        </p>
                        {detailText(event) ? (
                          <p className="mt-1 truncate text-muted-foreground text-xs">
                            {detailText(event)}
                          </p>
                        ) : null}
                      </div>
                      <time
                        title={new Date(event.createdAt).toLocaleString()}
                        className="shrink-0 text-[10px] text-muted-foreground"
                      >
                        {new Date(event.createdAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </time>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
