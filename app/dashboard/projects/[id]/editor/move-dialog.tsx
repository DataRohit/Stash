"use client";

import { CornerDownRight, Folder, FolderTree } from "lucide-react";
import { useMemo, useRef } from "react";
import { sortNodes, type TreeNode } from "@/app/dashboard/projects/[id]/editor/tree-utils";
import { Dialog } from "@/components/ui/dialog";

type MoveDialogProps = {
  node: TreeNode;
  nodes: TreeNode[];
  onMove: (parentId: string | null) => Promise<void>;
  onClose: () => void;
};

type Destination = { id: string | null; name: string; depth: number };

export function MoveDialog({ node, nodes, onMove, onClose }: MoveDialogProps) {
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

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Move ${node.name}`}
      icon={<FolderTree className="size-3.5" aria-hidden="true" />}
      description="Choose a folder to move this item into."
      className="max-w-md"
      initialFocusRef={firstOptionRef}
    >
      <div className="py-2">
        {destinations.length === 0 ? (
          <p className="px-3 py-4 text-muted-foreground/80 text-xs">
            No other folder can hold this item.
          </p>
        ) : (
          <ul className="flex flex-col gap-1 px-2">
            {destinations.map((destination, index) => (
              <li key={destination.id ?? "__root__"}>
                <button
                  ref={index === 0 ? firstOptionRef : undefined}
                  type="button"
                  onClick={() => {
                    void onMove(destination.id);
                    onClose();
                  }}
                  className="flex h-8 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md pr-3 text-left text-muted-foreground text-xs transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
                  style={{ paddingLeft: `${12 + destination.depth * 14}px` }}
                >
                  {destination.id === null ? (
                    <FolderTree
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                  ) : (
                    <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
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
    </Dialog>
  );
}
