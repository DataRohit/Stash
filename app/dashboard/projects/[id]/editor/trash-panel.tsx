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
} from "lucide-react";
import { useState } from "react";
import {
  formatBytes,
  formatHistoryTime,
  mapDocError,
} from "@/app/dashboard/projects/[id]/editor/lib/editor-format";
import { Dialog } from "@/components/ui/dialog";
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
  if (item.fileType === "doc") {
    return <FileType className="size-4 shrink-0 text-info" aria-hidden="true" />;
  }
  return <FileText className="size-4 shrink-0 text-accent" aria-hidden="true" />;
}

export function TrashPanel({ open, projectId, isAdmin, onClose }: TrashPanelProps) {
  const [confirmItem, setConfirmItem] = useState<TrashItem | null>(null);
  const itemsData = useQuery(api.documents.listTrash, open ? { projectId } : "skip");
  const restore = useMutation(api.documents.restoreDocument);
  const deleteForever = useMutation(api.documents.deleteForever);
  const items = (itemsData ?? []) as TrashItem[];

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
            <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground text-sm">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Loading trash…
            </div>
          ) : items.length === 0 ? (
            <p className="px-3 py-6 text-center text-muted-foreground/80 text-xs">
              Trash is empty.
            </p>
          ) : (
            <ul className="flex flex-col gap-1 px-2">
              {items.map((item) => (
                <li
                  key={item.id}
                  className="group flex items-center gap-2 rounded-md px-3 py-2 transition-colors hover:bg-foreground/[0.05]"
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
                      onClick={() => setConfirmItem(item)}
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
            className="h-8 rounded-sm border border-hairline px-3 text-muted-foreground text-xs hover:bg-foreground/[0.06] hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => confirmItem && void onDeleteForever(confirmItem)}
            className="h-8 rounded-sm bg-destructive px-3 font-medium text-background text-xs hover:bg-destructive/90"
          >
            Delete forever
          </button>
        </div>
      </Dialog>
    </>
  );
}
