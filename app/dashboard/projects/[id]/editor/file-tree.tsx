"use client";

import {
  ChevronDown,
  ChevronRight,
  FileCode,
  FilePlus,
  FileText,
  FileType,
  Folder,
  FolderPlus,
  Image as ImageIcon,
  Pencil,
  Trash2,
  Upload,
} from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { sortNodes, type TreeNode } from "@/app/dashboard/projects/[id]/editor/tree-utils";
import { cn } from "@/lib/utils";

type FileTreeProps = {
  nodes: TreeNode[];
  selectedId: string | null;
  canEdit: boolean;
  onSelect: (node: TreeNode) => void;
  onCreateFolder: (parentId: string | null, name: string) => Promise<void>;
  onCreateFile: (parentId: string | null, name: string) => Promise<void>;
  onCreateDocument: (parentId: string | null, name: string) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
  onRemove: (node: TreeNode) => Promise<void>;
  onUpload: (parentId: string | null, files: File[]) => Promise<void>;
};

type DraftKind = "folder" | "file" | "doc";
type Draft = { kind: DraftKind; parentId: string | null };

const INDENT = 12;
const PAD_BASE = 8;
const BARE_INPUT =
  "min-w-0 flex-1 bg-transparent p-0 text-foreground text-xs caret-accent outline-none placeholder:text-muted-foreground/45";

function rowPadding(depth: number) {
  return `${PAD_BASE + depth * INDENT}px`;
}

function fileGlyph(node: TreeNode) {
  if (node.fileType === "html") {
    return <FileCode className="size-4 shrink-0 text-warning" aria-hidden="true" />;
  }
  if (node.fileType === "doc") {
    return <FileType className="size-4 shrink-0 text-info" aria-hidden="true" />;
  }
  return <FileText className="size-4 shrink-0 text-accent" aria-hidden="true" />;
}

function NodeGlyph({ node }: { node: TreeNode }) {
  const icon =
    node.kind === "folder" ? (
      <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    ) : node.kind === "asset" ? (
      <ImageIcon className="size-4 shrink-0 text-info" aria-hidden="true" />
    ) : (
      fileGlyph(node)
    );
  return <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>;
}

function StaticNodeGlyph({ node }: { node: TreeNode }) {
  if (node.kind === "folder") {
    return <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />;
  }
  if (node.kind === "asset") {
    return <ImageIcon className="size-4 shrink-0 text-info" aria-hidden="true" />;
  }
  return fileGlyph(node);
}

function DraftGlyph({ kind }: { kind: DraftKind }) {
  if (kind === "folder") {
    return <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />;
  }
  if (kind === "doc") {
    return <FileType className="size-4 shrink-0 text-info" aria-hidden="true" />;
  }
  return <FileText className="size-4 shrink-0 text-accent" aria-hidden="true" />;
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
      className="absolute inset-y-0 w-px bg-hairline/70"
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
        "pointer-events-auto flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-xs text-muted-foreground transition-colors",
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
  selectedId,
  canEdit,
  onSelect,
  onCreateFolder,
  onCreateFile,
  onCreateDocument,
  onRename,
  onRemove,
  onUpload,
}: FileTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftName, setDraftName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef<HTMLInputElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);

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

  const childrenByParent = new Map<string | null, TreeNode[]>();
  const nodeById = new Map<string, TreeNode>();
  for (const node of nodes) {
    nodeById.set(node.id, node);
    const list = childrenByParent.get(node.parentId) ?? [];
    list.push(node);
    childrenByParent.set(node.parentId, list);
  }

  const selectedAncestorIds = new Set<string>();
  let selectedNode = selectedId ? nodeById.get(selectedId) : undefined;
  while (selectedNode?.parentId) {
    selectedAncestorIds.add(selectedNode.parentId);
    selectedNode = nodeById.get(selectedNode.parentId);
  }

  const isExpanded = (id: string) => expanded.has(id) || selectedAncestorIds.has(id);

  const sortedChildren = (parentId: string | null) =>
    sortNodes(childrenByParent.get(parentId) ?? []);

  const visibleNodes: TreeNode[] = [];
  const collectVisible = (parentId: string | null) => {
    for (const node of sortedChildren(parentId)) {
      visibleNodes.push(node);
      if (node.kind === "folder" && isExpanded(node.id)) {
        collectVisible(node.id);
      }
    }
  };
  collectVisible(null);
  const visibleIds = visibleNodes.map((node) => node.id);

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

  const activate = (node: TreeNode) => {
    if (node.kind === "folder") {
      toggle(node.id);
      setActiveFolderId(node.id);
      return;
    }
    onSelect(node);
    setActiveFolderId(node.parentId);
  };

  const focusNode = (id: string | undefined) => {
    if (!id) {
      return;
    }
    treeRef.current?.querySelector<HTMLButtonElement>(`[data-tree-node-id="${id}"]`)?.focus();
  };

  const onNodeKey = (event: KeyboardEvent<HTMLButtonElement>, node: TreeNode) => {
    const index = visibleIds.indexOf(node.id);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusNode(visibleIds[Math.min(visibleIds.length - 1, index + 1)]);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusNode(visibleIds[Math.max(0, index - 1)]);
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

  const startDraftIn = (kind: DraftKind, parentId: string | null) => {
    if (parentId) {
      setExpanded((prev) => new Set(prev).add(parentId));
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
    } else if (draft.kind === "doc") {
      await onCreateDocument(draft.parentId, name);
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
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            onBlur={submitDraft}
            onKeyDown={onDraftKey}
            placeholder={
              draft.kind === "folder"
                ? "folder name"
                : draft.kind === "doc"
                  ? "document name"
                  : "name.md or name.html"
            }
            className={BARE_INPUT}
          />
        </div>
      </li>
    ) : null;

  const renderNodes = (parentId: string | null, depth: number) => {
    const list = sortedChildren(parentId);
    return (
      <ul className="flex flex-col" role={depth === 0 ? "presentation" : "group"}>
        {draft?.parentId === parentId ? renderDraft(depth) : null}
        {list.map((node) => {
          const isOpen = isExpanded(node.id);
          const isSelected = node.id === selectedId;
          const isActiveFolder = node.kind === "folder" && node.id === activeFolderId;
          const isRenaming = renaming === node.id;
          return (
            <li key={node.id}>
              <div
                className={cn(
                  "group relative flex h-7 items-center transition-colors",
                  !isRenaming && "cursor-pointer",
                  isSelected
                    ? "bg-accent/[0.09] text-foreground"
                    : isActiveFolder
                      ? "text-foreground hover:bg-foreground/[0.04]"
                      : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
                )}
              >
                {isSelected ? (
                  <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 bg-accent" />
                ) : null}
                <IndentGuides depth={depth} />
                {isRenaming ? (
                  <div
                    className="flex h-full min-w-0 flex-1 items-center gap-1.5 pr-2"
                    style={{ paddingLeft: rowPadding(depth) }}
                  >
                    <span className="size-4 shrink-0" />
                    <StaticNodeGlyph node={node} />
                    <input
                      ref={renameRef}
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
                      className={BARE_INPUT}
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => activate(node)}
                    onKeyDown={(event) => onNodeKey(event, node)}
                    onDragOver={
                      canEdit && node.kind === "folder"
                        ? (event) => event.preventDefault()
                        : undefined
                    }
                    onDrop={
                      canEdit && node.kind === "folder"
                        ? (event) => {
                            event.preventDefault();
                            void onUpload(node.id, [...event.dataTransfer.files]);
                          }
                        : undefined
                    }
                    data-tree-node-id={node.id}
                    role="treeitem"
                    aria-level={depth + 1}
                    aria-selected={isSelected}
                    aria-expanded={node.kind === "folder" ? isOpen : undefined}
                    tabIndex={isSelected || (!selectedId && visibleIds[0] === node.id) ? 0 : -1}
                    className="flex h-full w-full min-w-0 cursor-pointer items-center gap-1.5 bg-transparent pr-24 text-left"
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
                  </button>
                )}
                {canEdit && !isRenaming ? (
                  <div className="pointer-events-none absolute right-2 z-10 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                    {node.kind === "folder" ? (
                      <>
                        <ActionButton
                          label="New file in folder"
                          onClick={() => startDraftIn("file", node.id)}
                        >
                          <FilePlus className="size-3.5" aria-hidden="true" />
                        </ActionButton>
                        <ActionButton
                          label="New document in folder"
                          onClick={() => startDraftIn("doc", node.id)}
                        >
                          <FileType className="size-3.5" aria-hidden="true" />
                        </ActionButton>
                        <ActionButton
                          label="New folder in folder"
                          onClick={() => startDraftIn("folder", node.id)}
                        >
                          <FolderPlus className="size-3.5" aria-hidden="true" />
                        </ActionButton>
                      </>
                    ) : null}
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
                  </div>
                ) : null}
              </div>
              {node.kind === "folder" && isOpen ? renderNodes(node.id, depth + 1) : null}
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
              onClick={() => startDraft("file")}
              className="flex size-7 cursor-pointer items-center justify-center rounded-xs text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
              aria-label="New file"
            >
              <FilePlus className="size-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => startDraft("doc")}
              className="flex size-7 cursor-pointer items-center justify-center rounded-xs text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
              aria-label="New document"
            >
              <FileType className="size-4" aria-hidden="true" />
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
          </div>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1.5">
        {nodes.length === 0 && !draft ? (
          <p className="px-3 py-4 text-muted-foreground/80 text-xs">
            {canEdit ? "No files yet — create one above." : "No files yet."}
          </p>
        ) : (
          <div
            ref={treeRef}
            role="tree"
            aria-label="Project files"
            onDragOver={canEdit ? (event) => event.preventDefault() : undefined}
            onDrop={
              canEdit
                ? (event) => {
                    event.preventDefault();
                    void onUpload(activeParent, [...event.dataTransfer.files]);
                  }
                : undefined
            }
          >
            {renderNodes(null, 0)}
          </div>
        )}
      </div>
      <input
        ref={uploadRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,.md,.markdown,.html,.htm,.txt,text/markdown,text/plain,text/html"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = event.target.files ? [...event.target.files] : [];
          event.target.value = "";
          if (files.length > 0) {
            void onUpload(activeParent, files);
          }
        }}
      />
    </div>
  );
}
