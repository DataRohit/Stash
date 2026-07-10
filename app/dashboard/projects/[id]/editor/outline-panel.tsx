"use client";

import { List, X } from "lucide-react";
import type { OutlineItem } from "@/app/dashboard/projects/[id]/editor/lib/outline";
import { cn } from "@/lib/utils";

type OutlinePanelProps = {
  items: OutlineItem[];
  onSelect: (item: OutlineItem) => void;
  onClose: () => void;
};

export function OutlinePanel({ items, onSelect, onClose }: OutlinePanelProps) {
  return (
    <aside
      aria-label="Document outline"
      className="glass ml-3 hidden w-64 shrink-0 flex-col overflow-hidden rounded-lg sm:flex"
    >
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-hairline border-b pr-2 pl-3">
        <span className="flex items-center gap-1.5 font-medium font-mono text-muted-foreground text-xs uppercase tracking-widest">
          <List className="size-3.5 shrink-0" aria-hidden="true" />
          Outline
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close outline"
          className="flex size-7 cursor-pointer items-center justify-center rounded-xs text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1.5">
        {items.length === 0 ? (
          <p className="px-3 py-4 text-muted-foreground/80 text-xs leading-relaxed">
            No headings yet. Add headings to build an outline.
          </p>
        ) : (
          <ul className="flex flex-col">
            {items.map((item) => (
              <li key={`${item.index}-${item.offset}`}>
                <button
                  type="button"
                  onClick={() => onSelect(item)}
                  className={cn(
                    "flex h-7 w-full min-w-0 cursor-pointer items-center pr-2 text-left text-muted-foreground text-xs transition-colors hover:bg-foreground/[0.05] hover:text-foreground",
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
    </aside>
  );
}
