"use client";

import { useMutation, useQuery } from "convex/react";
import {
  BellOff,
  BellRing,
  Copy,
  FileClock,
  FilePlus,
  FolderInput,
  FolderPlus,
  FolderTree,
  History,
  ImageUp,
  Loader2,
  PenLine,
  RotateCcw,
  Share2,
  Trash2,
  UserRound,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DataLoader, DataState } from "@/components/ui/data-state";
import { notify } from "@/components/ui/toast";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { formatDateTime, formatRelativeTime } from "@/lib/format";

type EventRow = NonNullable<
  ReturnType<typeof useQuery<typeof api.activity.listProjectEvents>>
>[number];

const MODE_LABELS: Record<string, string> = {
  private: "Private",
  org: "Organization",
  public: "Public link",
};

const PHRASES: Record<string, { lead: string; trail?: string }> = {
  documents_imported: { lead: "imported" },
  document_duplicated: { lead: "duplicated" },
  node_renamed: { lead: "renamed" },
  node_moved: { lead: "moved" },
  node_trashed: { lead: "moved", trail: "to trash" },
  node_restored: { lead: "restored", trail: "from trash" },
  node_deleted: { lead: "permanently deleted" },
  checkpoint_created: { lead: "saved a checkpoint of" },
  checkpoint_deleted: { lead: "deleted a checkpoint of" },
  checkpoint_restored: { lead: "restored a checkpoint of" },
  share_changed: { lead: "changed sharing for" },
  access_granted: { lead: "granted project access to" },
  access_revoked: { lead: "revoked project access from" },
};

function modeLabel(mode: string) {
  return MODE_LABELS[mode] ?? mode;
}

function phrase(event: EventRow): { lead: string; trail?: string } {
  if (event.kind === "node_created") {
    if (event.detail === "folder") return { lead: "created the folder" };
    if (event.detail === "asset") return { lead: "uploaded" };
    if (event.detail === "template") return { lead: "created", trail: "from a template" };
    return { lead: "created" };
  }
  return PHRASES[event.kind] ?? { lead: "updated" };
}

function detailText(event: EventRow): string | null {
  if (event.kind === "node_renamed")
    return event.previousValue ? `Renamed from ${event.previousValue}` : null;
  if (event.kind === "node_moved") return event.nextValue ? `Moved to ${event.nextValue}` : null;
  if (event.kind === "document_duplicated")
    return event.previousValue ? `Copied from ${event.previousValue}` : null;
  if (event.kind === "documents_imported") return event.detail;
  if (event.kind === "share_changed")
    return event.previousValue && event.nextValue
      ? `${modeLabel(event.previousValue)} → ${modeLabel(event.nextValue)}`
      : null;
  return null;
}

function iconFor(event: EventRow) {
  const { kind } = event;
  if (kind === "node_created") {
    if (event.detail === "folder") return FolderPlus;
    if (event.detail === "asset") return ImageUp;
    return FilePlus;
  }
  if (kind === "documents_imported") return FolderInput;
  if (kind === "document_duplicated") return Copy;
  if (kind === "node_renamed") return PenLine;
  if (kind === "node_moved") return FolderTree;
  if (kind === "node_trashed" || kind === "node_deleted") return Trash2;
  if (kind === "node_restored") return RotateCcw;
  if (kind.startsWith("checkpoint")) return History;
  if (kind === "share_changed") return Share2;
  if (kind.startsWith("access")) return UserRound;
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
        <DataLoader label="Loading project activity" />
      ) : events.length === 0 ? (
        <DataState
          title="No project activity yet"
          description="Document, sharing, access, and history changes will appear here."
          icon={<FileClock className="size-6" aria-hidden="true" />}
          className="mt-5"
        />
      ) : (
        <div className="mt-5 flex flex-col gap-6">
          {[...groups.entries()].map(([day, rows]) => (
            <section key={day}>
              <h2 className="mb-2 font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
                {day}
              </h2>
              <ul className="flex flex-col">
                {rows.map((event, index) => {
                  const Icon = iconFor(event);
                  const { lead, trail } = phrase(event);
                  const detail = detailText(event);
                  const targetEmail =
                    event.targetEmail && event.targetEmail !== event.targetName ? (
                      <span className="font-normal text-muted-foreground">
                        {" "}
                        ({event.targetEmail})
                      </span>
                    ) : null;
                  const target = event.documentId ? (
                    <Link
                      href={`/dashboard/projects/${projectId}/editor?file=${event.documentId}`}
                      className="font-medium text-foreground hover:text-accent"
                    >
                      {event.targetName}
                    </Link>
                  ) : (
                    <span className="font-medium text-foreground">
                      {event.targetName}
                      {targetEmail}
                    </span>
                  );
                  const actorEmail =
                    event.actorEmail && event.actorEmail !== event.actorName ? (
                      <span className="text-muted-foreground"> ({event.actorEmail})</span>
                    ) : null;
                  return (
                    <li key={event.id} className="flex items-center gap-3">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-foreground/[0.05] text-muted-foreground">
                        <Icon className="size-4" />
                      </span>
                      <div
                        className={`flex min-w-0 flex-1 items-start justify-between gap-3 py-3 ${
                          index > 0 ? "border-hairline border-t" : ""
                        }`}
                      >
                        <div className="min-w-0">
                          <p className="text-sm">
                            <span className="font-medium">{event.actorName}</span>
                            {actorEmail} {lead} {target}
                            {trail ? ` ${trail}` : null}
                          </p>
                          {detail ? (
                            <p className="mt-1 truncate text-muted-foreground text-xs">{detail}</p>
                          ) : null}
                        </div>
                        <time
                          dateTime={new Date(event.createdAt).toISOString()}
                          title={formatDateTime(event.createdAt)}
                          className="mt-0.5 shrink-0 text-[10px] text-muted-foreground"
                        >
                          {formatRelativeTime(event.createdAt)}
                        </time>
                      </div>
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
