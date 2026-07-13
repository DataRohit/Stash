"use client";

import { List } from "lucide-react";
import type { OutlineItem } from "@/app/dashboard/projects/[id]/editor/lib/outline";
import { DataState } from "@/components/ui/data-state";
import { Dialog } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type OutlinePanelProps = {
  open: boolean;
  items: OutlineItem[];
  onSelect: (item: OutlineItem) => void;
  onClose: () => void;
};

export function OutlinePanel({ open, items, onSelect, onClose }: OutlinePanelProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Document outline"
      icon={<List className="size-3.5" aria-hidden="true" />}
      description="Jump to a heading in the editor and preview."
      className="max-w-md"
      mobileSheet
    >
      <div className="py-2">
        {items.length === 0 ? (
          <DataState
            title="No headings yet"
            description="Add headings to this document to build an outline."
            compact
            className="m-2"
          />
        ) : (
          <ul className="flex flex-col gap-1 px-2">
            {items.map((item) => (
              <li key={`${item.index}-${item.offset}`}>
                <button
                  type="button"
                  onClick={() => onSelect(item)}
                  className={cn(
                    "flex h-8 w-full min-w-0 cursor-pointer items-center rounded-md pr-2 text-left text-muted-foreground text-xs transition-colors hover:bg-foreground/[0.05] hover:text-foreground",
                    item.level <= 1 && "font-medium text-foreground",
                  )}
                  style={{ paddingLeft: `${10 + (item.level - 1) * 14}px` }}
                >
                  <span className="min-w-0 flex-1 truncate">{item.text}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
