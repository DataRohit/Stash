"use client";

import { useQuery } from "convex/react";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FilePlus,
  Files,
  FolderInput,
  FolderPlus,
  Pencil,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { MoveDialog } from "@/app/dashboard/projects/[id]/editor/move-dialog";
import { sortNodes, type TreeNode } from "@/app/dashboard/projects/[id]/editor/tree-utils";
import { FavoriteButton } from "@/components/dashboard/favorite-button";
import { FileIcon } from "@/components/file-icon";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ASSET_ACCEPT } from "@/lib/asset-formats";
import { cn } from "@/lib/utils";

type FileTreeProps = {
  nodes: TreeNode[];
  projectId: string;
  clerkOrgId: string;
  selectedId: string | null;
  canEdit: boolean;
  onSelect: (node: TreeNode) => void;
  onCreateFolder: (parentId: string | null, name: string) => Promise<void>;
  onCreateFile: (parentId: string | null, name: string) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
  onRemove: (node: TreeNode) => Promise<void>;
  onUpload: (
    parentId: string | null,
    files: File[],
    update: (index: number, progress: number, status: UploadStatus, error?: string) => void,
  ) => Promise<void>;
  onMove: (id: string, parentId: string | null) => Promise<void>;
  onDuplicate: (node: TreeNode) => Promise<void>;
  onBulkMove: (ids: string[], parentId: string | null) => Promise<void>;
  onBulkRemove: (nodes: TreeNode[]) => Promise<void>;
  onBulkDuplicate: (nodes: TreeNode[]) => Promise<void>;
  onBulkExport: (nodes: TreeNode[]) => Promise<void>;
  onOpenTrash: () => void;
  onOpenDocumentDialog: (parentId: string | null) => void;
};

type UploadStatus = "uploading" | "complete" | "failed";
type UploadItem = {
  id: string;
  name: string;
  progress: number;
  status: UploadStatus;
  error?: string;
};

type DraftKind = "folder" | "file";
type Draft = { kind: DraftKind; parentId: string | null };
type VisibleRow = { node: TreeNode; depth: number };
type VirtualEntry =
  | { type: "node"; node: TreeNode; depth: number }
  | { type: "draft"; depth: number };

const NODE_MIME = "application/x-stash-node";
const ROOT_TARGET = "__root__";
const INDENT = 12;
const PAD_BASE = 8;
const VIRTUALIZE_ROWS_THRESHOLD = 500;
const VIRTUAL_ROW_HEIGHT = 30;
const VIRTUAL_OVERSCAN = 8;
const TREE_INPUT =
  "h-6 min-w-0 flex-1 rounded-sm border border-hairline bg-surface/65 px-2 text-foreground text-xs caret-accent outline-none transition-colors placeholder:text-muted-foreground/45 focus-visible:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60";

function rowPadding(depth: number) {
  return `${PAD_BASE + depth * INDENT}px`;
}

function NodeGlyph({ node }: { node: TreeNode }) {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center">
      <FileIcon kind={node.kind} fileType={node.fileType} mimeType={node.mimeType} />
    </span>
  );
}

function StaticNodeGlyph({ node }: { node: TreeNode }) {
  return <FileIcon kind={node.kind} fileType={node.fileType} mimeType={node.mimeType} />;
}

function DraftGlyph({ kind }: { kind: DraftKind }) {
  if (kind === "folder") {
    return <FileIcon kind="folder" />;
  }
  return <FileIcon kind="file" fileType="md" />;
}

function IndentGuides({ depth }: { depth: number }) {
  if (depth === 0) {
    return null;
  }
  const offsets = Array.from({ length: depth }, (_, level) => PAD_BASE + level * INDENT + 8);
  return offsets.map((left) => (
    <span
      key={left}
      aria-hidden="true"
      className="absolute inset-y-0 z-[1] w-px bg-hairline/70"
      style={{ left: `${left}px` }}
    />
  ));
}

function ActionButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        onClick();
      }}
      aria-label={label}
      className={cn(
        "pointer-events-auto flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-xs text-muted-foreground outline-none transition-colors focus-visible:ring-1 focus-visible:ring-accent/70 focus-visible:ring-inset",
        danger
          ? "hover:bg-destructive/10 hover:text-destructive"
          : "hover:bg-foreground/10 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

export function FileTree({
  nodes,
  projectId,
  clerkOrgId,
  selectedId,
  canEdit,
  onSelect,
  onCreateFolder,
  onCreateFile,
  onRename,
  onRemove,
  onUpload,
  onMove,
  onDuplicate,
  onBulkMove,
  onBulkRemove,
  onBulkDuplicate,
  onBulkExport,
  onOpenTrash,
  onOpenDocumentDialog,
}: FileTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftName, setDraftName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const [dragNodeId, setDragNodeId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [movingNode, setMovingNode] = useState<TreeNode | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const treeRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingFocusRef = useRef<string | null>(null);
  const draftRef = useRef<HTMLInputElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const selectionAnchorRef = useRef<string | null>(null);
  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressedRef = useRef(false);
  const uploadClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (uploadClearRef.current) clearTimeout(uploadClearRef.current);
    },
    [],
  );

  useEffect(() => {
    if (draft) {
      draftRef.current?.focus();
    }
  }, [draft]);

  useEffect(() => {
    if (renaming) {
      renameRef.current?.focus();
      renameRef.current?.select();
    }
  }, [renaming]);

  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) {
      return;
    }
    const update = () => setViewportHeight(viewport.clientHeight);
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    const frame = requestAnimationFrame(update);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  const { childrenByParent, nodeById } = useMemo(() => {
    const byParent = new Map<string | null, TreeNode[]>();
    const byId = new Map<string, TreeNode>();
    for (const node of nodes) {
      byId.set(node.id, node);
      const list = byParent.get(node.parentId) ?? [];
      list.push(node);
      byParent.set(node.parentId, list);
    }
    return { childrenByParent: byParent, nodeById: byId };
  }, [nodes]);

  const sortedChildrenByParent = useMemo(() => {
    const map = new Map<string | null, TreeNode[]>();
    for (const [parentId, list] of childrenByParent) {
      map.set(parentId, sortNodes(list));
    }
    return map;
  }, [childrenByParent]);

  const selectedAncestorIds = useMemo(() => {
    const ids = new Set<string>();
    let selectedNode = selectedId ? nodeById.get(selectedId) : undefined;
    while (selectedNode?.parentId) {
      ids.add(selectedNode.parentId);
      selectedNode = nodeById.get(selectedNode.parentId);
    }
    return ids;
  }, [nodeById, selectedId]);

  const isExpanded = (id: string) => expanded.has(id) || selectedAncestorIds.has(id);

  const sortedChildren = (parentId: string | null) => sortedChildrenByParent.get(parentId) ?? [];

  const visibleRows = useMemo(() => {
    const rows: VisibleRow[] = [];
    const collect = (parentId: string | null, depth: number) => {
      for (const node of sortedChildrenByParent.get(parentId) ?? []) {
        rows.push({ node, depth });
        if (node.kind === "folder" && (expanded.has(node.id) || selectedAncestorIds.has(node.id))) {
          collect(node.id, depth + 1);
        }
      }
    };
    collect(null, 0);
    return rows;
  }, [expanded, selectedAncestorIds, sortedChildrenByParent]);
  const visibleIds = useMemo(() => visibleRows.map((row) => row.node.id), [visibleRows]);
  const favorites = useQuery(api.navigation.listFavorites, { clerkOrgId });
  const unread = useQuery(api.watches.listUnread, {
    projectId: projectId as Id<"projects">,
    documentIds: visibleIds.slice(0, 200) as Id<"documents">[],
  });
  const favoriteIds = useMemo(
    () =>
      new Set<string>(
        favorites?.flatMap((item) => (item.documentId ? [item.documentId] : [])) ?? [],
      ),
    [favorites],
  );
  const unreadIds = useMemo(() => new Set(unread?.documentIds ?? []), [unread]);
  const virtualEntries = useMemo<VirtualEntry[]>(() => {
    const entries: VirtualEntry[] = visibleRows.map((row) => ({ type: "node", ...row }));
    if (!draft) {
      return entries;
    }
    const parentIndex = draft.parentId
      ? visibleRows.findIndex((row) => row.node.id === draft.parentId)
      : -1;
    const depth = parentIndex >= 0 ? (visibleRows[parentIndex]?.depth ?? -1) + 1 : 0;
    entries.splice(parentIndex + 1, 0, { type: "draft", depth });
    return entries;
  }, [draft, visibleRows]);
  const virtualized = virtualEntries.length > VIRTUALIZE_ROWS_THRESHOLD;
  const containRows = visibleRows.length > VIRTUALIZE_ROWS_THRESHOLD;
  const virtualStart = virtualized
    ? Math.max(0, Math.floor(scrollTop / VIRTUAL_ROW_HEIGHT) - VIRTUAL_OVERSCAN)
    : 0;
  const visibleVirtualRows = Math.ceil(viewportHeight / VIRTUAL_ROW_HEIGHT);
  const virtualEnd = virtualized
    ? Math.min(
        virtualEntries.length,
        virtualStart + Math.max(visibleVirtualRows, 1) + VIRTUAL_OVERSCAN * 2,
      )
    : virtualEntries.length;
  const virtualRows = virtualEntries.slice(virtualStart, virtualEnd);

  useEffect(() => {
    const pendingFocusId = pendingFocusRef.current;
    if (!pendingFocusId) {
      return;
    }
    const target = treeRef.current?.querySelector<HTMLButtonElement>(
      `[data-tree-node-id="${pendingFocusId}"]`,
    );
    if (target) {
      target.focus();
      pendingFocusRef.current = null;
    }
  }, [virtualStart, virtualEnd]);

  const openNode = nodes.find((node) => node.id === selectedId) ?? null;
  const activeParent =
    activeFolderId ??
    (openNode ? (openNode.kind === "folder" ? openNode.id : openNode.parentId) : null);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const selectForBulk = (node: TreeNode, range: boolean, toggleSelection: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (range && selectionAnchorRef.current) {
        const from = visibleIds.indexOf(selectionAnchorRef.current);
        const to = visibleIds.indexOf(node.id);
        if (from >= 0 && to >= 0) {
          for (const id of visibleIds.slice(Math.min(from, to), Math.max(from, to) + 1))
            next.add(id);
        }
      } else if (toggleSelection && next.has(node.id)) {
        next.delete(node.id);
      } else {
        next.add(node.id);
      }
      return next;
    });
    selectionAnchorRef.current = node.id;
  };

  const activate = (node: TreeNode, event?: MouseEvent<HTMLButtonElement>) => {
    if (longPressedRef.current) {
      longPressedRef.current = false;
      return;
    }
    if (event?.metaKey || event?.ctrlKey || event?.shiftKey || selectedIds.size > 0) {
      selectForBulk(
        node,
        Boolean(event?.shiftKey),
        Boolean(event?.metaKey || event?.ctrlKey || selectedIds.size > 0),
      );
      return;
    }
    if (node.kind === "folder") {
      toggle(node.id);
      setActiveFolderId(node.id);
      return;
    }
    onSelect(node);
    setActiveFolderId(node.parentId);
  };

  const runUpload = async (parentId: string | null, files: File[]) => {
    if (uploadClearRef.current) clearTimeout(uploadClearRef.current);
    setUploads(
      files.map((file) => ({
        id: crypto.randomUUID(),
        name: file.name,
        progress: 0,
        status: "uploading",
      })),
    );
    await onUpload(parentId, files, (index, progress, status, error) => {
      setUploads((current) =>
        current.map((item, itemIndex) =>
          itemIndex === index ? { ...item, progress, status, error } : item,
        ),
      );
    });
    uploadClearRef.current = setTimeout(() => setUploads([]), 6000);
  };

  const focusNode = (id: string | undefined) => {
    if (!id) {
      return;
    }
    const target = treeRef.current?.querySelector<HTMLButtonElement>(`[data-tree-node-id="${id}"]`);
    if (target) {
      target.focus();
      return;
    }
    if (virtualized) {
      const index = visibleIds.indexOf(id);
      if (index >= 0 && scrollRef.current) {
        const nextScrollTop = index * VIRTUAL_ROW_HEIGHT;
        scrollRef.current.scrollTop = nextScrollTop;
        setScrollTop(nextScrollTop);
        pendingFocusRef.current = id;
      }
    }
  };

  const onNodeKey = (event: KeyboardEvent<HTMLButtonElement>, node: TreeNode) => {
    const index = visibleIds.indexOf(node.id);
    if (event.key === " " && canEdit) {
      event.preventDefault();
      selectForBulk(node, event.shiftKey, true);
    } else if (event.key === "Escape" && selectedIds.size > 0) {
      event.preventDefault();
      setSelectedIds(new Set());
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      const nextId = visibleIds[Math.min(visibleIds.length - 1, index + 1)];
      if (event.shiftKey && canEdit) {
        selectionAnchorRef.current ??= node.id;
        const nextNode = nextId ? nodeById.get(nextId) : undefined;
        if (nextNode) selectForBulk(nextNode, true, false);
      }
      focusNode(nextId);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      const nextId = visibleIds[Math.max(0, index - 1)];
      if (event.shiftKey && canEdit) {
        selectionAnchorRef.current ??= node.id;
        const nextNode = nextId ? nodeById.get(nextId) : undefined;
        if (nextNode) selectForBulk(nextNode, true, false);
      }
      focusNode(nextId);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusNode(visibleIds[0]);
    } else if (event.key === "End") {
      event.preventDefault();
      focusNode(visibleIds.at(-1));
    } else if (event.key === "ArrowRight" && node.kind === "folder") {
      event.preventDefault();
      if (!isExpanded(node.id)) {
        setExpanded((prev) => new Set(prev).add(node.id));
      } else {
        focusNode(sortedChildren(node.id)[0]?.id);
      }
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (node.kind === "folder" && isExpanded(node.id)) {
        setExpanded((prev) => {
          const next = new Set(prev);
          next.delete(node.id);
          return next;
        });
      } else {
        focusNode(node.parentId ?? undefined);
      }
    }
  };

  const canDropInto = (targetId: string | null) => {
    if (!dragNodeId) {
      return true;
    }
    if (targetId === dragNodeId) {
      return false;
    }
    const dragNode = nodeById.get(dragNodeId);
    if (dragNode && dragNode.parentId === targetId) {
      return false;
    }
    let current = targetId ? nodeById.get(targetId) : undefined;
    while (current) {
      if (current.id === dragNodeId) {
        return false;
      }
      current = current.parentId ? nodeById.get(current.parentId) : undefined;
    }
    return true;
  };

  const onNodeDragStart = (event: DragEvent<HTMLButtonElement>, node: TreeNode) => {
    event.dataTransfer.setData(NODE_MIME, node.id);
    event.dataTransfer.effectAllowed = "move";
    setDragNodeId(node.id);
  };

  const endDrag = () => {
    setDragNodeId(null);
    setDropTargetId(null);
  };

  const onZoneDragOver = (event: DragEvent, targetId: string | null) => {
    const internal = event.dataTransfer.types.includes(NODE_MIME);
    if (internal && !canDropInto(targetId)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (internal) {
      event.dataTransfer.dropEffect = "move";
    }
    setDropTargetId(targetId ?? ROOT_TARGET);
  };

  const onZoneDrop = (event: DragEvent, targetId: string | null) => {
    event.preventDefault();
    event.stopPropagation();
    setDropTargetId(null);
    const draggedId = event.dataTransfer.getData(NODE_MIME);
    if (draggedId) {
      if (canDropInto(targetId)) {
        void onMove(draggedId, targetId);
      }
      return;
    }
    void runUpload(targetId, [...event.dataTransfer.files]);
  };

  const startDraftIn = (kind: DraftKind, parentId: string | null) => {
    if (parentId) {
      setExpanded((prev) => new Set(prev).add(parentId));
    }
    if (visibleRows.length >= VIRTUALIZE_ROWS_THRESHOLD && scrollRef.current) {
      const parentIndex = parentId ? visibleIds.indexOf(parentId) : -1;
      const nextScrollTop = (parentIndex + 1) * VIRTUAL_ROW_HEIGHT;
      scrollRef.current.scrollTop = nextScrollTop;
      setScrollTop(nextScrollTop);
    }
    setDraft({ kind, parentId });
    setDraftName("");
  };

  const startDraft = (kind: DraftKind) => startDraftIn(kind, activeParent);

  const submitDraft = async () => {
    if (!draft || draftName.trim().length === 0) {
      setDraft(null);
      return;
    }
    const name = draftName.trim();
    setDraft(null);
    setDraftName("");
    if (draft.kind === "folder") {
      await onCreateFolder(draft.parentId, name);
    } else {
      await onCreateFile(draft.parentId, name);
    }
  };

  const submitRename = async (id: string) => {
    const name = renameName.trim();
    setRenaming(null);
    if (name.length > 0) {
      await onRename(id, name);
    }
  };

  const onDraftKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void submitDraft();
    } else if (event.key === "Escape") {
      setDraft(null);
    }
  };

  const renderDraft = (depth: number) =>
    draft ? (
      <li>
        <div
          className="relative flex h-7 items-center gap-1.5 pr-2"
          style={{ paddingLeft: rowPadding(depth) }}
        >
          <IndentGuides depth={depth} />
          <span className="size-4 shrink-0" />
          <DraftGlyph kind={draft.kind} />
          <input
            ref={draftRef}
            aria-label={`New ${draft.kind} name`}
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            onBlur={submitDraft}
            onKeyDown={onDraftKey}
            placeholder={draft.kind === "folder" ? "folder name" : "name.md or name.html"}
            className={TREE_INPUT}
          />
        </div>
      </li>
    ) : null;

  const renderNodes = (parentId: string | null, depth: number, onlyNode?: TreeNode) => {
    const list = onlyNode ? [onlyNode] : sortedChildren(parentId);
    return (
      <ul
        className={cn("flex flex-col gap-0.5", (depth === 0 || onlyNode) && "px-3")}
        role={depth === 0 || onlyNode ? "presentation" : "group"}
      >
        {!onlyNode && draft?.parentId === parentId ? renderDraft(depth) : null}
        {list.map((node) => {
          const isOpen = isExpanded(node.id);
          const isSelected = selectedIds.has(node.id) || node.id === selectedId;
          const isActiveFolder = node.kind === "folder" && node.id === activeFolderId;
          const isRenaming = renaming === node.id;
          return (
            <li key={node.id} className={cn(containRows && "tree-row-contained")}>
              <div
                className={cn(
                  "group relative flex h-7 items-center rounded-md transition-colors",
                  !isRenaming && "cursor-pointer",
                  isSelected
                    ? "text-foreground"
                    : isActiveFolder
                      ? "text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  dragNodeId === node.id && "opacity-40",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "pointer-events-none absolute inset-y-0 right-0 z-0 rounded-md transition-colors",
                    dropTargetId === node.id && node.kind === "folder"
                      ? "bg-accent/12 ring-1 ring-accent/50 ring-inset"
                      : isSelected
                        ? "bg-accent/[0.09]"
                        : "group-hover:bg-foreground/[0.04]",
                  )}
                  style={{ left: `${depth * INDENT}px` }}
                >
                  {isSelected ? (
                    <span className="absolute inset-y-0 left-0 w-0.5 rounded-full bg-accent" />
                  ) : null}
                </span>
                <IndentGuides depth={depth} />
                {isRenaming ? (
                  <div
                    className="relative z-[1] flex h-full min-w-0 flex-1 items-center gap-1.5 pr-2"
                    style={{ paddingLeft: rowPadding(depth) }}
                  >
                    <span className="size-4 shrink-0" />
                    <StaticNodeGlyph node={node} />
                    <input
                      ref={renameRef}
                      aria-label={`Rename ${node.name}`}
                      value={renameName}
                      onChange={(event) => setRenameName(event.target.value)}
                      onBlur={() => submitRename(node.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void submitRename(node.id);
                        } else if (event.key === "Escape") {
                          setRenaming(null);
                        }
                      }}
                      className={TREE_INPUT}
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={(event) => activate(node, event)}
                    onKeyDown={(event) => onNodeKey(event, node)}
                    onPointerDown={(event) => {
                      if (!canEdit || event.pointerType === "mouse") return;
                      longPressedRef.current = false;
                      longPressRef.current = setTimeout(() => {
                        longPressedRef.current = true;
                        selectForBulk(node, false, true);
                      }, 450);
                    }}
                    onPointerUp={() => {
                      if (longPressRef.current) clearTimeout(longPressRef.current);
                    }}
                    onPointerCancel={() => {
                      if (longPressRef.current) clearTimeout(longPressRef.current);
                    }}
                    draggable={canEdit}
                    onDragStart={canEdit ? (event) => onNodeDragStart(event, node) : undefined}
                    onDragEnd={canEdit ? endDrag : undefined}
                    onDragOver={
                      canEdit
                        ? (event) =>
                            onZoneDragOver(event, node.kind === "folder" ? node.id : node.parentId)
                        : undefined
                    }
                    onDragLeave={
                      canEdit
                        ? () =>
                            setDropTargetId((prev) =>
                              prev ===
                              (node.kind === "folder" ? node.id : (node.parentId ?? ROOT_TARGET))
                                ? null
                                : prev,
                            )
                        : undefined
                    }
                    onDrop={
                      canEdit
                        ? (event) =>
                            onZoneDrop(event, node.kind === "folder" ? node.id : node.parentId)
                        : undefined
                    }
                    data-tree-node-id={node.id}
                    role="treeitem"
                    aria-level={depth + 1}
                    aria-selected={isSelected}
                    aria-expanded={node.kind === "folder" ? isOpen : undefined}
                    tabIndex={isSelected || (!selectedId && visibleIds[0] === node.id) ? 0 : -1}
                    className={cn(
                      "relative z-[1] flex h-full w-full min-w-0 items-center gap-1.5 bg-transparent pr-2 text-left transition-[padding] duration-150",
                      canEdit
                        ? node.kind === "folder"
                          ? "group-focus-within:pr-44 group-hover:pr-44"
                          : node.kind === "file"
                            ? "group-focus-within:pr-36 group-hover:pr-36"
                            : "group-focus-within:pr-32 group-hover:pr-32"
                        : "group-focus-within:pr-8 group-hover:pr-8",
                      canEdit ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
                    )}
                    style={{ paddingLeft: rowPadding(depth) }}
                  >
                    {node.kind === "folder" ? (
                      <span
                        aria-hidden="true"
                        className="flex size-4 shrink-0 items-center justify-center text-muted-foreground/70"
                      >
                        {isOpen ? (
                          <ChevronDown className="size-4" aria-hidden="true" />
                        ) : (
                          <ChevronRight className="size-4" aria-hidden="true" />
                        )}
                      </span>
                    ) : (
                      <span className="size-4 shrink-0" />
                    )}
                    <NodeGlyph node={node} />
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate text-left text-xs",
                        isSelected && "font-medium",
                      )}
                    >
                      {node.name}
                    </span>
                    {unreadIds.has(node.id as Id<"documents">) ? (
                      <>
                        <span
                          className="size-1.5 shrink-0 rounded-full bg-info"
                          aria-hidden="true"
                        />
                        <span className="sr-only">Has new activity</span>
                      </>
                    ) : null}
                  </button>
                )}
                {!isRenaming ? (
                  <div className="pointer-events-none absolute right-1 z-10 flex shrink-0 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                    <div className="pointer-events-auto">
                      <FavoriteButton
                        projectId={projectId}
                        documentId={node.id}
                        favorite={favoriteIds.has(node.id)}
                        className="size-6 rounded-xs"
                      />
                    </div>
                    {canEdit && node.kind === "folder" ? (
                      <>
                        <ActionButton
                          label="New document in folder"
                          onClick={() => onOpenDocumentDialog(node.id)}
                        >
                          <FilePlus className="size-3.5" aria-hidden="true" />
                        </ActionButton>
                        <ActionButton
                          label="New folder in folder"
                          onClick={() => startDraftIn("folder", node.id)}
                        >
                          <FolderPlus className="size-3.5" aria-hidden="true" />
                        </ActionButton>
                      </>
                    ) : null}
                    {canEdit && node.kind === "file" ? (
                      <ActionButton label="Duplicate" onClick={() => void onDuplicate(node)}>
                        <Copy className="size-3.5" aria-hidden="true" />
                      </ActionButton>
                    ) : null}
                    {canEdit ? (
                      <>
                        <ActionButton label="Move to folder" onClick={() => setMovingNode(node)}>
                          <FolderInput className="size-3.5" aria-hidden="true" />
                        </ActionButton>
                        <ActionButton
                          label="Rename"
                          onClick={() => {
                            setRenaming(node.id);
                            setRenameName(node.name);
                          }}
                        >
                          <Pencil className="size-3.5" aria-hidden="true" />
                        </ActionButton>
                        <ActionButton label="Delete" danger onClick={() => onRemove(node)}>
                          <Trash2 className="size-3.5" aria-hidden="true" />
                        </ActionButton>
                      </>
                    ) : null}
                  </div>
                ) : null}
              </div>
              {!onlyNode && node.kind === "folder" && isOpen
                ? renderNodes(node.id, depth + 1)
                : null}
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-hairline border-b pr-2 pl-3">
        <span className="font-medium font-mono text-muted-foreground text-xs uppercase tracking-widest">
          Files
        </span>
        {canEdit ? (
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => onOpenDocumentDialog(activeParent)}
              className="flex size-7 cursor-pointer items-center justify-center rounded-xs text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
              aria-label="New document"
            >
              <FilePlus className="size-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => startDraft("folder")}
              className="flex size-7 cursor-pointer items-center justify-center rounded-xs text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
              aria-label="New folder"
            >
              <FolderPlus className="size-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => uploadRef.current?.click()}
              className="flex size-7 cursor-pointer items-center justify-center rounded-xs text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
              aria-label="Upload files"
            >
              <Upload className="size-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={onOpenTrash}
              className="flex size-7 cursor-pointer items-center justify-center rounded-xs text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
              aria-label="Open trash"
            >
              <Trash2 className="size-4" aria-hidden="true" />
            </button>
          </div>
        ) : null}
      </div>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto py-1.5"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        onPaste={(event) => {
          const files = [...event.clipboardData.files];
          if (canEdit && files.length > 0) {
            event.preventDefault();
            void runUpload(activeParent, files);
          }
        }}
      >
        {nodes.length === 0 && !draft ? (
          <p className="px-3 py-4 text-muted-foreground/80 text-xs">
            {canEdit ? "No files yet — create one above." : "No files yet."}
          </p>
        ) : (
          <div
            ref={treeRef}
            role="tree"
            aria-label="Project files"
            onDragOver={canEdit ? (event) => onZoneDragOver(event, null) : undefined}
            onDragLeave={
              canEdit
                ? () => setDropTargetId((prev) => (prev === ROOT_TARGET ? null : prev))
                : undefined
            }
            onDrop={canEdit ? (event) => onZoneDrop(event, null) : undefined}
            className={cn(
              "min-h-full",
              dropTargetId === ROOT_TARGET && "rounded-xs ring-1 ring-accent/40 ring-inset",
            )}
          >
            {virtualized ? (
              <div
                className="relative"
                style={{ height: `${virtualEntries.length * VIRTUAL_ROW_HEIGHT}px` }}
              >
                <div
                  className="absolute inset-x-0 top-0"
                  style={{ transform: `translateY(${virtualStart * VIRTUAL_ROW_HEIGHT}px)` }}
                >
                  {virtualRows.map((entry) => (
                    <div
                      key={entry.type === "node" ? entry.node.id : "draft"}
                      style={{ height: `${VIRTUAL_ROW_HEIGHT}px` }}
                    >
                      {entry.type === "node" ? (
                        renderNodes(null, entry.depth, entry.node)
                      ) : (
                        <ul className="px-2" role="presentation">
                          {renderDraft(entry.depth)}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              renderNodes(null, 0)
            )}
          </div>
        )}
      </div>
      {uploads.length > 0 ? (
        <div
          className="shrink-0 border-hairline border-t bg-surface/95 px-3 py-2"
          aria-live="polite"
        >
          <ul className="max-h-32 space-y-2 overflow-auto">
            {uploads.map((upload) => (
              <li key={upload.id}>
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="truncate">{upload.name}</span>
                  <span
                    className={cn(
                      "shrink-0 font-mono text-[10px]",
                      upload.status === "failed" ? "text-destructive" : "text-muted-foreground",
                    )}
                  >
                    {upload.status === "failed"
                      ? (upload.error ?? "Failed")
                      : upload.status === "complete"
                        ? "Uploaded"
                        : `${upload.progress}%`}
                  </span>
                </div>
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-foreground/10">
                  <div
                    className={cn(
                      "h-full transition-[width]",
                      upload.status === "failed" ? "bg-destructive" : "bg-info",
                    )}
                    style={{ width: `${upload.status === "failed" ? 100 : upload.progress}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {canEdit && selectedIds.size > 0 ? (
        <div
          className="sticky bottom-0 z-20 flex min-h-11 shrink-0 items-center gap-1 border-hairline border-t bg-surface px-2 shadow-lg"
          role="toolbar"
          aria-label="Selected file actions"
        >
          <span className="mr-auto pl-1 font-mono text-xs">{selectedIds.size} selected</span>
          <button
            type="button"
            onClick={() => setMovingNode(nodes.find((node) => selectedIds.has(node.id)) ?? null)}
            className="flex size-11 items-center justify-center rounded-sm text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
            aria-label="Move selected items"
            title="Move selected items"
          >
            <FolderInput className="size-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            disabled={[...selectedIds].some((id) => nodeById.get(id)?.kind !== "file")}
            onClick={() =>
              void onBulkDuplicate(nodes.filter((node) => selectedIds.has(node.id))).then(() =>
                setSelectedIds(new Set()),
              )
            }
            className="flex size-11 items-center justify-center rounded-sm text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-40"
            aria-label="Duplicate selected documents"
            title="Duplicate selected documents"
          >
            <Files className="size-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() =>
              void onBulkExport(nodes.filter((node) => selectedIds.has(node.id))).then(() =>
                setSelectedIds(new Set()),
              )
            }
            className="flex size-11 items-center justify-center rounded-sm text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
            aria-label="Export selected items"
            title="Export selected items"
          >
            <Download className="size-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() =>
              void onBulkRemove(nodes.filter((node) => selectedIds.has(node.id))).then(() =>
                setSelectedIds(new Set()),
              )
            }
            className="flex size-11 items-center justify-center rounded-sm text-destructive hover:bg-destructive/10"
            aria-label="Move selected items to trash"
            title="Move selected items to trash"
          >
            <Trash2 className="size-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => setSelectedIds(new Set())}
            className="flex size-11 items-center justify-center rounded-sm text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
            aria-label="Clear selection"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      ) : null}
      <input
        ref={uploadRef}
        type="file"
        accept={`${ASSET_ACCEPT},.md,.html`}
        multiple
        className="hidden"
        onChange={(event) => {
          const files = event.target.files ? [...event.target.files] : [];
          event.target.value = "";
          if (files.length > 0) {
            void runUpload(activeParent, files);
          }
        }}
      />
      {movingNode ? (
        <MoveDialog
          node={movingNode}
          nodes={nodes}
          onMove={(parentId) =>
            selectedIds.size > 0
              ? onBulkMove([...selectedIds], parentId).then(() => setSelectedIds(new Set()))
              : onMove(movingNode.id, parentId)
          }
          onClose={() => setMovingNode(null)}
        />
      ) : null}
    </div>
  );
}
