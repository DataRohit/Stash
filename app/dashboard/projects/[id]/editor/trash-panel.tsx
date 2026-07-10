"use client";

import { useMutation, useQuery } from "convex/react";
import {
  FileCode,
  FileText,
  FileType,
  Folder,
  Image as ImageIcon,
  Loader2,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef } from "react";
import {
  formatBytes,
  formatHistoryTime,
  mapDocError,
} from "@/app/dashboard/projects/[id]/editor/lib/editor-format";
import { notify } from "@/components/ui/toast";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

type TrashItem = {
  id: string;
  kind: "folder" | "file" | "asset";
  name: string;
  fileType: "md" | "html" | "doc" | null;
  size: number;
  trashedAt: number;
};

type TrashPanelProps = {
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
  if (item.fileType === "doc") {
    return <FileType className="size-4 shrink-0 text-info" aria-hidden="true" />;
  }
  return <FileText className="size-4 shrink-0 text-accent" aria-hidden="true" />;
}

export function TrashPanel({ projectId, isAdmin, onClose }: TrashPanelProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const itemsData = useQuery(api.documents.listTrash, { projectId });
  const restore = useMutation(api.documents.restoreDocument);
  const deleteForever = useMutation(api.documents.deleteForever);
  const items = (itemsData ?? []) as TrashItem[];

  useEffect(() => {
    const timer = window.setTimeout(() => closeRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const onRestore = async (item: TrashItem) => {
    try {
      await restore({ documentId: item.id as Id<"documents"> });
      notify.success(`Restored ${item.name}`);
    } catch (error) {
      notify.error("Restore failed", { description: mapDocError(error) });
    }
  };

  const onDeleteForever = async (item: TrashItem) => {
    if (!window.confirm(`Permanently delete "${item.name}"? This cannot be undone.`)) {
      return;
    }
    try {
      await deleteForever({ documentId: item.id as Id<"documents"> });
      notify.success(`Deleted ${item.name} permanently`);
    } catch (error) {
      notify.error("Delete failed", { description: mapDocError(error) });
    }
  };

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close trash"
        className="absolute inset-0 cursor-default bg-black/50"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Trash"
        className="glass relative flex max-h-[76vh] w-full max-w-lg flex-col overflow-hidden rounded-lg"
      >
        <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-hairline border-b pr-2 pl-3">
          <span className="flex min-w-0 items-center gap-1.5 font-medium font-mono text-muted-foreground text-xs uppercase tracking-widest">
            <Trash2 className="size-3.5 shrink-0" aria-hidden="true" />
            Trash
          </span>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex size-7 cursor-pointer items-center justify-center rounded-xs text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
        <div className="border-hairline border-b px-3 py-2 text-[11px] text-muted-foreground leading-relaxed">
          Trashed items are hidden from the project and permanently removed after 30 days.
        </div>
        <div className="min-h-0 flex-1 overflow-auto py-1.5">
          {itemsData === undefined ? (
            <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground text-sm">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Loading trash…
            </div>
          ) : items.length === 0 ? (
            <p className="px-3 py-6 text-center text-muted-foreground/80 text-xs">
              Trash is empty.
            </p>
          ) : (
            <ul className="flex flex-col">
              {items.map((item) => (
                <li
                  key={item.id}
                  className="group flex items-center gap-2 px-3 py-2 transition-colors hover:bg-foreground/[0.04]"
                >
                  <ItemGlyph item={item} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-foreground text-xs">{item.name}</span>
                    <span className="block font-mono text-[10px] text-muted-foreground">
                      {formatHistoryTime(item.trashedAt)}
                      {item.size > 0 ? ` · ${formatBytes(item.size)}` : ""}
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
                      onClick={() => void onDeleteForever(item)}
                      aria-label={`Delete ${item.name} forever`}
                      className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-sm border border-hairline text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
