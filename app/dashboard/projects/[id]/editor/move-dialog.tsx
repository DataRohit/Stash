"use client";

import { CornerDownRight, Folder, FolderTree, X } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { sortNodes, type TreeNode } from "@/app/dashboard/projects/[id]/editor/tree-utils";

type MoveDialogProps = {
  node: TreeNode;
  nodes: TreeNode[];
  onMove: (parentId: string | null) => Promise<void>;
  onClose: () => void;
};

type Destination = { id: string | null; name: string; depth: number };

export function MoveDialog({ node, nodes, onMove, onClose }: MoveDialogProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const firstOptionRef = useRef<HTMLButtonElement>(null);

  const destinations = useMemo<Destination[]>(() => {
    const childrenByParent = new Map<string | null, TreeNode[]>();
    for (const item of nodes) {
      const list = childrenByParent.get(item.parentId) ?? [];
      list.push(item);
      childrenByParent.set(item.parentId, list);
    }
    const blocked = new Set<string>([node.id]);
    const queue: string[] = [node.id];
    while (queue.length > 0) {
      const id = queue.shift() as string;
      for (const child of childrenByParent.get(id) ?? []) {
        if (!blocked.has(child.id)) {
          blocked.add(child.id);
          queue.push(child.id);
        }
      }
    }
    const results: Destination[] = [];
    if (node.parentId !== null) {
      results.push({ id: null, name: "Project root", depth: 0 });
    }
    const walk = (parentId: string | null, depth: number) => {
      for (const child of sortNodes(childrenByParent.get(parentId) ?? [])) {
        if (child.kind !== "folder" || blocked.has(child.id)) {
          continue;
        }
        if (child.id !== node.parentId) {
          results.push({ id: child.id, name: child.name, depth });
        }
        walk(child.id, depth + 1);
      }
    };
    walk(null, node.parentId === null ? 0 : 1);
    return results;
  }, [node, nodes]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      (firstOptionRef.current ?? closeRef.current)?.focus();
    }, 0);
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

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close move dialog"
        className="absolute inset-0 cursor-default bg-black/50"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Move ${node.name}`}
        className="glass relative flex max-h-[70vh] w-full max-w-md flex-col overflow-hidden rounded-lg"
      >
        <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-hairline border-b pr-2 pl-3">
          <span className="flex min-w-0 items-center gap-1.5 font-medium font-mono text-muted-foreground text-xs uppercase tracking-widest">
            <FolderTree className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">Move {node.name}</span>
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
        <div className="min-h-0 flex-1 overflow-auto py-1.5">
          {destinations.length === 0 ? (
            <p className="px-3 py-4 text-muted-foreground/80 text-xs">
              No other folder can hold this item.
            </p>
          ) : (
            <ul className="flex flex-col">
              {destinations.map((destination, index) => (
                <li key={destination.id ?? "__root__"}>
                  <button
                    ref={index === 0 ? firstOptionRef : undefined}
                    type="button"
                    onClick={() => {
                      void onMove(destination.id);
                      onClose();
                    }}
                    className="flex h-8 w-full min-w-0 cursor-pointer items-center gap-1.5 pr-3 text-left text-muted-foreground text-xs transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
                    style={{ paddingLeft: `${12 + destination.depth * 14}px` }}
                  >
                    {destination.id === null ? (
                      <FolderTree
                        className="size-4 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                    ) : (
                      <Folder
                        className="size-4 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                    )}
                    <span className="min-w-0 flex-1 truncate">{destination.name}</span>
                    <CornerDownRight
                      className="size-3.5 shrink-0 text-muted-foreground/40"
                      aria-hidden="true"
                    />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
