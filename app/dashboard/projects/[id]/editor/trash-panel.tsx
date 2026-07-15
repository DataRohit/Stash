"use client";

import { useMutation, useQuery } from "convex/react";
import { FileCode, FileText, Folder, Image as ImageIcon, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { mapDocError } from "@/app/dashboard/projects/[id]/editor/lib/editor-format";
import { DataLoader, DataState } from "@/components/ui/data-state";
import { Dialog } from "@/components/ui/dialog";
import { notify } from "@/components/ui/toast";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { formatBytes, formatDateTime, formatRelativeTime } from "@/lib/format";
import { TRASH_RETENTION_MS } from "@/lib/lifecycle";

const DAY_MS = 24 * 60 * 60 * 1000;
const TRASH_IMMINENT_MS = 3 * DAY_MS;

type TrashItem = {
  id: string;
  kind: "folder" | "file" | "asset";
  name: string;
  fileType: "md" | "html" | null;
  size: number;
  trashedAt: number;
};

type TrashPanelProps = {
  open: boolean;
  projectId: Id<"projects">;
  isAdmin: boolean;
  onClose: () => void;
};

function ItemGlyph({ item }: { item: TrashItem }) {
  if (item.kind === "folder") {
    return <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />;
  }
  if (item.kind === "asset") {
    return <ImageIcon className="size-4 shrink-0 text-info" aria-hidden="true" />;
  }
  if (item.fileType === "html") {
    return <FileCode className="size-4 shrink-0 text-warning" aria-hidden="true" />;
  }
  return <FileText className="size-4 shrink-0 text-accent" aria-hidden="true" />;
}

function retentionLabel(trashedAt: number, now: number): { label: string; imminent: boolean } {
  const remaining = trashedAt + TRASH_RETENTION_MS - now;
  if (remaining <= 0) {
    return { label: "Auto-delete pending", imminent: true };
  }
  if (remaining < DAY_MS) {
    return { label: "Auto-deletes in less than a day", imminent: true };
  }
  const days = Math.ceil(remaining / DAY_MS);
  return {
    label: `Auto-deletes in ${days} ${days === 1 ? "day" : "days"}`,
    imminent: remaining < TRASH_IMMINENT_MS,
  };
}

export function TrashPanel({ open, projectId, isAdmin, onClose }: TrashPanelProps) {
  const [confirmItem, setConfirmItem] = useState<TrashItem | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const itemsData = useQuery(api.documents.listTrash, open ? { projectId } : "skip");
  const restore = useMutation(api.documents.restoreDocument);
  const deleteForever = useMutation(api.documents.deleteForever);
  const items = (itemsData ?? []) as TrashItem[];

  useEffect(() => {
    if (!open) {
      return;
    }
    const timeout = window.setTimeout(() => setNow(Date.now()), 0);
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => {
      window.clearTimeout(timeout);
      window.clearInterval(interval);
    };
  }, [open]);

  const onRestore = async (item: TrashItem) => {
    try {
      await restore({ documentId: item.id as Id<"documents"> });
      notify.success(`Restored ${item.name}`);
    } catch (error) {
      notify.error("Restore failed", { description: mapDocError(error) });
    }
  };

  const onDeleteForever = async (item: TrashItem) => {
    try {
      await deleteForever({ documentId: item.id as Id<"documents"> });
      notify.success(`Deleted ${item.name} permanently`);
      setConfirmItem(null);
    } catch (error) {
      notify.error("Delete failed", { description: mapDocError(error) });
    }
  };

  return (
    <>
      <Dialog
        open={open && confirmItem === null}
        onClose={onClose}
        title="Trash"
        icon={<Trash2 className="size-3.5" aria-hidden="true" />}
        description="Trashed items are hidden from the project and permanently removed after 30 days."
        className="max-w-lg"
      >
        <div className="py-2">
          {itemsData === undefined ? (
            <DataLoader label="Loading trash" compact />
          ) : items.length === 0 ? (
            <DataState
              title="Trash is empty"
              description="Deleted project items will remain here until restored or permanently removed."
              compact
              className="m-2"
            />
          ) : (
            <ul className="flex flex-col gap-1 px-2">
              {items.map((item) => {
                const retention = retentionLabel(item.trashedAt, now);
                return (
                  <li
                    key={item.id}
                    className={`group flex items-center gap-2 rounded-md px-3 py-2 transition-colors hover:bg-foreground/[0.05] ${retention.imminent ? "bg-destructive/5" : ""}`}
                  >
                    <ItemGlyph item={item} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-foreground text-xs">{item.name}</span>
                      <span className="block font-mono text-[10px] text-muted-foreground">
                        <time
                          dateTime={new Date(item.trashedAt).toISOString()}
                          title={formatDateTime(item.trashedAt)}
                        >
                          {formatRelativeTime(item.trashedAt, now)}
                        </time>
                        {item.size > 0 ? ` · ${formatBytes(item.size)}` : ""}
                      </span>
                      <span
                        className={`block font-mono text-[10px] ${retention.imminent ? "text-destructive" : "text-muted-foreground"}`}
                      >
                        {retention.label}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => void onRestore(item)}
                      className="flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-sm border border-hairline px-2 font-medium text-[11px] text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
                    >
                      <RotateCcw className="size-3.5" aria-hidden="true" />
                      Restore
                    </button>
                    {isAdmin ? (
                      <button
                        type="button"
                        onClick={() => setConfirmItem(item)}
                        aria-label={`Delete ${item.name} forever`}
                        className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-sm border border-hairline text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Trash2 className="size-3.5" aria-hidden="true" />
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Dialog>
      <Dialog
        open={confirmItem !== null}
        onClose={() => setConfirmItem(null)}
        title="Delete forever"
        icon={<Trash2 className="size-3.5 text-destructive" aria-hidden="true" />}
        description={
          confirmItem
            ? `Permanently delete “${confirmItem.name}”? This cannot be undone.`
            : undefined
        }
        className="max-w-sm"
      >
        <div className="flex justify-end gap-2 p-3">
          <button
            type="button"
            onClick={() => setConfirmItem(null)}
            className="h-8 cursor-pointer rounded-sm border border-hairline px-3 text-muted-foreground text-xs hover:bg-foreground/[0.06] hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => confirmItem && void onDeleteForever(confirmItem)}
            className="h-8 cursor-pointer rounded-sm bg-destructive px-3 font-medium text-background text-xs hover:bg-destructive/90"
          >
            Delete forever
          </button>
        </div>
      </Dialog>
    </>
  );
}
