"use client";

import {
  ChevronDown,
  ChevronRight,
  FileCode,
  FilePlus,
  FileText,
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
  onRename: (id: string, name: string) => Promise<void>;
  onRemove: (node: TreeNode) => Promise<void>;
  onUpload: (parentId: string | null, file: File) => Promise<void>;
};

type Draft = { kind: "folder" | "file"; parentId: string | null };

const INDENT = 12;
const PAD_BASE = 8;
const BARE_INPUT =
  "min-w-0 flex-1 bg-transparent p-0 text-foreground text-xs caret-accent outline-none placeholder:text-muted-foreground/45";

function rowPadding(depth: number) {
  return `${PAD_BASE + depth * INDENT}px`;
}

function NodeGlyph({ node }: { node: TreeNode }) {
  const icon =
    node.kind === "folder" ? (
      <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    ) : node.kind === "asset" ? (
      <ImageIcon className="size-4 shrink-0 text-info" aria-hidden="true" />
    ) : node.fileType === "html" ? (
      <FileCode className="size-4 shrink-0 text-warning" aria-hidden="true" />
    ) : (
      <FileText className="size-4 shrink-0 text-accent" aria-hidden="true" />
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
  return node.fileType === "html" ? (
    <FileCode className="size-4 shrink-0 text-warning" aria-hidden="true" />
  ) : (
    <FileText className="size-4 shrink-0 text-accent" aria-hidden="true" />
  );
}

function DraftGlyph({ kind }: { kind: "folder" | "file" }) {
  return kind === "folder" ? (
    <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
  ) : (
    <FileText className="size-4 shrink-0 text-accent" aria-hidden="true" />
  );
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
  const draftRef = useRef<HTMLInputElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);

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
  for (const node of nodes) {
    const list = childrenByParent.get(node.parentId) ?? [];
    list.push(node);
    childrenByParent.set(node.parentId, list);
  }

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

  const startDraftIn = (kind: "folder" | "file", parentId: string | null) => {
    if (parentId) {
      setExpanded((prev) => new Set(prev).add(parentId));
    }
    setDraft({ kind, parentId });
    setDraftName("");
  };

  const startDraft = (kind: "folder" | "file") => startDraftIn(kind, activeParent);

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
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            onBlur={submitDraft}
            onKeyDown={onDraftKey}
            placeholder={draft.kind === "folder" ? "folder name" : "name.md or name.html"}
            className={BARE_INPUT}
          />
        </div>
      </li>
    ) : null;

  const renderNodes = (parentId: string | null, depth: number) => {
    const list = sortNodes(childrenByParent.get(parentId) ?? []);
    return (
      <ul className="flex flex-col">
        {draft?.parentId === parentId ? renderDraft(depth) : null}
        {list.map((node) => {
          const isOpen = expanded.has(node.id);
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
              onClick={() => startDraft("folder")}
              className="flex size-7 cursor-pointer items-center justify-center rounded-xs text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
              aria-label="New folder"
            >
              <FolderPlus className="size-4" aria-hidden="true" />
            </button>
            <label
              className="flex size-7 cursor-pointer items-center justify-center rounded-xs text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
              aria-label="Upload asset"
            >
              <Upload className="size-4" aria-hidden="true" />
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) {
                    void onUpload(activeParent, file);
                  }
                }}
              />
            </label>
          </div>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1.5">
        {nodes.length === 0 && !draft ? (
          <p className="px-3 py-4 text-muted-foreground/80 text-xs">
            {canEdit ? "No files yet — create one above." : "No files yet."}
          </p>
        ) : (
          renderNodes(null, 0)
        )}
      </div>
    </div>
  );
}
