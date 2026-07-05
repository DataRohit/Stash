"use client";

import { useAuth, useUser } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import { ArrowLeft, Check, Code2, Columns2, Eye, Loader2, PanelLeft } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { DocEditor } from "@/app/dashboard/projects/[id]/editor/doc-editor";
import { DocPreview } from "@/app/dashboard/projects/[id]/editor/doc-preview";
import { FileTree } from "@/app/dashboard/projects/[id]/editor/file-tree";
import {
  type CollabViewer,
  useCollabDoc,
} from "@/app/dashboard/projects/[id]/editor/lib/use-collab-doc";
import type { TreeNode } from "@/app/dashboard/projects/[id]/editor/tree-utils";
import { notify } from "@/components/ui/toast";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { cn } from "@/lib/utils";

type ProjectEditorProps = {
  projectId: string;
  projectTitle: string;
  clerkOrgId: string;
  canEdit: boolean;
  isAdmin: boolean;
};

type ViewMode = "editor" | "split" | "preview";

const MAX_ASSET_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024;

function sidebarStorageKey(projectId: string): string {
  return `stash:editor:sidebar:${projectId}`;
}

function mapDocError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("project-full")) {
    return "This project has reached its size limit. Upgrade or remove files.";
  }
  if (message.includes("file-too-large")) {
    return "This file is too large (max 512 KB per file).";
  }
  if (message.includes("invalid-asset")) {
    return "Only image and SVG files can be uploaded.";
  }
  if (message.includes("invalid-type")) {
    return "Files must end in .md or .html.";
  }
  if (message.includes("invalid-parent")) {
    return "That folder no longer exists. Refresh and try again.";
  }
  if (message.includes("invalid-name")) {
    return "That name isn’t allowed.";
  }
  if (message.includes("too-many-nodes")) {
    return "This project has too many files and folders.";
  }
  if (message.includes("too-deep")) {
    return "Folders can’t be nested that deeply.";
  }
  if (message.includes("name-taken")) {
    return "A file or folder with that name already exists here.";
  }
  return "Something went wrong. Please try again.";
}

function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function formatSaveTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "?";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

function ViewerAvatar({ viewer, size }: { viewer: CollabViewer; size: number }) {
  const dimension = `${size}px`;
  if (viewer.image) {
    return (
      <img
        src={viewer.image}
        alt={viewer.name}
        style={{ width: dimension, height: dimension, outline: `1.5px solid ${viewer.color}` }}
        className="shrink-0 rounded-full border-2 border-surface object-cover"
      />
    );
  }
  return (
    <span
      style={{ width: dimension, height: dimension, backgroundColor: viewer.color }}
      className="flex shrink-0 items-center justify-center rounded-full border-2 border-surface font-medium text-[10px] text-white"
    >
      {initialsOf(viewer.name)}
    </span>
  );
}

function ViewerStack({ viewers }: { viewers: CollabViewer[] }) {
  const shown = viewers.slice(0, 3);
  const extra = viewers.length - shown.length;
  return (
    <>
      {shown.map((viewer, index) => (
        <span
          key={viewer.sessionId}
          style={{ marginLeft: index === 0 ? 0 : "-8px", zIndex: shown.length - index }}
          className="relative"
        >
          <ViewerAvatar viewer={viewer} size={24} />
        </span>
      ))}
      {extra > 0 ? (
        <span
          style={{ marginLeft: "-8px" }}
          className="flex size-6 items-center justify-center rounded-full border-2 border-surface bg-foreground/15 font-medium font-mono text-[10px] text-muted-foreground"
        >
          +{extra}
        </span>
      ) : null}
    </>
  );
}

function ViewerPresence({ viewers, canOpen }: { viewers: CollabViewer[]; canOpen: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointer = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onPointer);
    return () => window.removeEventListener("mousedown", onPointer);
  }, [open]);

  if (viewers.length === 0) {
    return null;
  }

  if (!canOpen) {
    return (
      <div title={`${viewers.length} viewing this file`} className="hidden items-center sm:flex">
        <ViewerStack viewers={viewers} />
      </div>
    );
  }

  return (
    <div ref={ref} className="relative z-[70] hidden sm:block">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={`${viewers.length} viewing this file`}
        className="flex cursor-pointer items-center rounded-full transition-opacity hover:opacity-90"
      >
        <ViewerStack viewers={viewers} />
      </button>
      {open ? (
        <div className="absolute top-9 right-0 z-[80] w-96 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-hairline bg-surface p-1 shadow-xl">
          <p className="px-2 py-1.5 font-medium font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
            {viewers.length} {viewers.length === 1 ? "person here" : "people here"}
          </p>
          <ul className="flex max-h-64 flex-col overflow-auto">
            {viewers.map((viewer) => (
              <li
                key={viewer.sessionId}
                className="flex items-center gap-2 rounded-md px-2 py-2 hover:bg-foreground/[0.04]"
              >
                <ViewerAvatar viewer={viewer} size={22} />
                <span className="min-w-0 flex-1">
                  <span className="block text-xs">{viewer.name}</span>
                  {viewer.email ? (
                    <span className="block break-all text-[11px] text-muted-foreground leading-snug">
                      {viewer.email}
                    </span>
                  ) : null}
                </span>
                {viewer.isSelf ? (
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">You</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function AccessLostState({ projectId, reason }: { projectId: string; reason: "org" | "access" }) {
  return (
    <div className="glass flex min-h-0 flex-1 items-center justify-center rounded-lg p-6 text-center">
      <div className="flex max-w-md flex-col items-center gap-3">
        <p className="font-serif text-2xl tracking-display">Project access changed</p>
        <p className="text-muted-foreground text-sm leading-relaxed">
          {reason === "org"
            ? "Your active organization changed in another tab. This editor is paused so it does not show stale project data."
            : "You no longer have access to this project, or it was removed while this tab was open."}
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
          <Link
            href="/dashboard/projects"
            className="inline-flex h-9 items-center justify-center rounded-sm bg-primary px-4 font-medium text-primary-foreground text-sm transition-colors hover:bg-primary/90"
          >
            Back to projects
          </Link>
          <Link
            href={`/dashboard/projects/${projectId}`}
            className="inline-flex h-9 items-center justify-center rounded-sm border border-hairline px-4 font-medium text-sm transition-colors hover:bg-foreground/[0.06]"
          >
            Check access
          </Link>
        </div>
      </div>
    </div>
  );
}

export function ProjectEditor({
  projectId,
  projectTitle,
  clerkOrgId,
  canEdit,
  isAdmin,
}: ProjectEditorProps) {
  const pid = projectId as Id<"projects">;
  const router = useRouter();
  const { orgId, isLoaded: authLoaded } = useAuth();
  const orgChanged = authLoaded && orgId !== clerkOrgId;
  const project = useQuery(api.projects.get, orgChanged ? "skip" : { projectId: pid });
  const accessLost = orgChanged ? "org" : project === null ? "access" : null;
  const nodesData = useQuery(api.documents.listByProject, accessLost ? "skip" : { projectId: pid });
  const nodes = useMemo(() => (nodesData ?? []) as TreeNode[], [nodesData]);
  const usage = useQuery(api.documents.usage, accessLost ? "skip" : { projectId: pid });

  const createFolder = useMutation(api.documents.createFolder);
  const createFile = useMutation(api.documents.createFile);
  const renameDoc = useMutation(api.documents.rename);
  const removeDoc = useMutation(api.documents.remove);
  const generateUploadUrl = useMutation(api.documents.generateUploadUrl);
  const createAsset = useMutation(api.documents.createAsset);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("split");
  const [buffer, setBuffer] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const lastSeeded = useRef<string | null>(null);
  const previewFrameRef = useRef<HTMLIFrameElement>(null);

  const startResize = (event: ReactPointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const onMove = (moveEvent: PointerEvent) => {
      const next = Math.min(440, Math.max(260, startWidth + moveEvent.clientX - startX));
      setSidebarWidth(next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
    };
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const { user } = useUser();
  const effectiveSelectedId =
    selectedId && (nodesData === undefined || nodes.some((node) => node.id === selectedId))
      ? selectedId
      : null;
  const selectedNode = nodes.find((node) => node.id === effectiveSelectedId) ?? null;
  const selectedFileId = selectedNode?.kind === "file" ? (effectiveSelectedId as string) : null;
  const doc = useQuery(
    api.documents.getDocument,
    selectedFileId && !accessLost ? { documentId: selectedFileId as Id<"documents"> } : "skip",
  );

  const collabUser = useMemo(
    () => ({
      id: user?.id ?? "anon",
      name:
        user?.fullName || user?.username || user?.primaryEmailAddress?.emailAddress || "Someone",
      email: user?.primaryEmailAddress?.emailAddress ?? null,
      image: user?.imageUrl ?? null,
    }),
    [user],
  );
  const collab = useCollabDoc(selectedFileId, canEdit, collabUser);

  useEffect(() => {
    if (orgChanged) {
      router.refresh();
    }
  }, [orgChanged, router]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSidebarCollapsed(
        window.localStorage.getItem(sidebarStorageKey(projectId)) === "collapsed",
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, [projectId]);

  useEffect(() => {
    window.localStorage.setItem(
      sidebarStorageKey(projectId),
      sidebarCollapsed ? "collapsed" : "expanded",
    );
  }, [sidebarCollapsed, projectId]);

  useEffect(() => {
    if (doc && doc.id === selectedFileId && lastSeeded.current !== selectedFileId) {
      setBuffer(doc.content);
      lastSeeded.current = selectedFileId;
    }
  }, [doc, selectedFileId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        notify.success("Changes sync automatically");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.source !== previewFrameRef.current?.contentWindow) {
        return;
      }
      if (event.data?.type === "stash-open-doc") {
        const target = nodes.find((node) => node.id === event.data.id);
        if (target?.kind === "file") {
          setSelectedId(target.id);
        }
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [nodes]);

  const guard = async (action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (error) {
      notify.error("Action failed", { description: mapDocError(error) });
    }
  };

  const handleUpload = async (parentId: string | null, file: File) => {
    if (!file.type.startsWith("image/")) {
      notify.error("Unsupported file", {
        description: "Only image and SVG files can be uploaded.",
      });
      return;
    }
    if (file.size > MAX_ASSET_BYTES) {
      notify.error("File too large", { description: "Each asset can be up to 5 MB." });
      return;
    }
    await guard(async () => {
      const uploadUrl = await generateUploadUrl({ projectId: pid });
      const response = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!response.ok) {
        throw new Error("upload failed");
      }
      const { storageId } = (await response.json()) as { storageId: Id<"_storage"> };
      await createAsset({
        projectId: pid,
        parentId: parentId as Id<"documents"> | null,
        name: file.name,
        storageId,
      });
    });
  };

  const saveStatus = selectedFileId
    ? collab?.syncing
      ? "Syncing..."
      : collab?.lastSyncedAt
        ? `Live ${formatSaveTime(collab.lastSyncedAt)}`
        : "Live"
    : "";
  const usedBytes = usage?.usedBytes ?? 0;
  const maxBytes = usage?.maxSizeBytes ?? 8 * 1024 * 1024;
  const usedPercent = maxBytes > 0 ? Math.min(100, Math.round((usedBytes / maxBytes) * 100)) : 100;
  const maxEditableBytes = doc
    ? Math.min(MAX_FILE_BYTES, doc.size + Math.max(0, maxBytes - usedBytes))
    : MAX_FILE_BYTES;

  if (accessLost) {
    return <AccessLostState projectId={projectId} reason={accessLost} />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="glass relative z-[60] flex h-14 shrink-0 items-center justify-between gap-3 rounded-lg px-4">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={() => setSidebarCollapsed((value) => !value)}
            aria-label={sidebarCollapsed ? "Show file tree" : "Hide file tree"}
            aria-pressed={!sidebarCollapsed}
            className={cn(
              "hidden size-7 shrink-0 cursor-pointer items-center justify-center rounded-xs transition-colors hover:bg-foreground/10 hover:text-foreground sm:flex",
              sidebarCollapsed ? "text-foreground" : "text-muted-foreground",
            )}
          >
            <PanelLeft className="size-4" aria-hidden="true" />
          </button>
          <Link
            href={`/dashboard/projects/${projectId}`}
            className="flex shrink-0 items-center gap-1.5 font-medium font-mono text-muted-foreground text-xs uppercase tracking-widest transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">{projectTitle}</span>
          </Link>
          {selectedNode ? (
            <span className="truncate font-mono text-muted-foreground text-xs">
              {selectedNode.name}
            </span>
          ) : null}
          {saveStatus ? (
            <span className="hidden shrink-0 items-center gap-1 font-mono text-muted-foreground text-xs sm:flex">
              {collab?.syncing ? (
                <Loader2 className="size-3 animate-spin" aria-hidden="true" />
              ) : (
                <Check className="size-3 text-accent" aria-hidden="true" />
              )}
              {saveStatus}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {selectedFileId && collab ? (
            <ViewerPresence viewers={collab.viewers} canOpen={isAdmin} />
          ) : null}
          <div className="hidden items-center gap-2 sm:flex">
            <div className="h-1.5 w-24 overflow-hidden rounded-full bg-foreground/10">
              <div
                className={cn(
                  "h-full rounded-full",
                  usedPercent >= 90 ? "bg-destructive" : "bg-accent",
                )}
                style={{ width: `${usedPercent}%` }}
              />
            </div>
            <span className="font-mono text-muted-foreground text-xs tabular-nums">
              {formatMb(usedBytes)}/{formatMb(maxBytes)} MB
            </span>
          </div>
          {selectedFileId ? (
            <div className="flex items-center gap-0.5 rounded-sm border border-hairline p-0.5">
              {(
                [
                  ["editor", Code2, "Editor"],
                  ["split", Columns2, "Split"],
                  ["preview", Eye, "Preview"],
                ] as const
              ).map(([mode, Icon, label]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setViewMode(mode)}
                  aria-label={label}
                  className={cn(
                    "flex size-7 cursor-pointer items-center justify-center rounded-xs transition-colors",
                    viewMode === mode
                      ? "bg-foreground/[0.08] text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="size-4" aria-hidden="true" />
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <div className="relative z-0 flex min-h-0 flex-1">
        <div
          className={cn(
            "glass hidden shrink-0 overflow-hidden rounded-lg",
            sidebarCollapsed ? "sm:hidden" : "sm:block",
          )}
          style={{ width: `${sidebarWidth}px` }}
        >
          <FileTree
            nodes={nodes}
            selectedId={effectiveSelectedId}
            canEdit={canEdit}
            onSelect={(node) => setSelectedId(node.id)}
            onCreateFolder={(parentId, name) =>
              guard(() =>
                createFolder({
                  projectId: pid,
                  parentId: parentId as Id<"documents"> | null,
                  name,
                }),
              )
            }
            onCreateFile={(parentId, name) =>
              guard(() =>
                createFile({ projectId: pid, parentId: parentId as Id<"documents"> | null, name }),
              )
            }
            onRename={(id, name) =>
              guard(() => renameDoc({ documentId: id as Id<"documents">, name }))
            }
            onRemove={(node) =>
              guard(async () => {
                await removeDoc({ documentId: node.id as Id<"documents"> });
                const removedIds = new Set<string>([node.id]);
                let changed = true;
                while (changed) {
                  changed = false;
                  for (const child of nodes) {
                    if (
                      child.parentId &&
                      removedIds.has(child.parentId) &&
                      !removedIds.has(child.id)
                    ) {
                      removedIds.add(child.id);
                      changed = true;
                    }
                  }
                }
                if (effectiveSelectedId && removedIds.has(effectiveSelectedId)) {
                  setSelectedId(null);
                }
              })
            }
            onUpload={handleUpload}
          />
        </div>

        <button
          type="button"
          onPointerDown={startResize}
          aria-label="Resize sidebar"
          className={cn(
            "group hidden w-3 shrink-0 cursor-col-resize touch-none items-center justify-center",
            sidebarCollapsed ? "sm:hidden" : "sm:flex",
          )}
        >
          <span className="h-8 w-1 rounded-full bg-hairline transition-colors group-hover:bg-foreground/30" />
        </button>

        <div className="glass flex min-w-0 flex-1 overflow-hidden rounded-lg">
          {selectedNode?.kind === "file" && doc && doc.id === selectedFileId ? (
            <div className="flex min-w-0 flex-1 flex-col">
              {collab?.blocked ? (
                <div className="shrink-0 border-destructive/30 border-b bg-destructive/6 px-4 py-2 text-destructive text-xs">
                  {collab.blocked} Editing is paused until this file can sync again.
                </div>
              ) : null}
              <div className="flex min-h-0 flex-1">
                {viewMode !== "preview" ? (
                  <div
                    className={cn(
                      "min-w-0 overflow-auto",
                      viewMode === "split" ? "flex-1 border-hairline border-r" : "flex-1",
                    )}
                  >
                    <DocEditor
                      key={`${selectedFileId}:${doc.fileType}`}
                      initialContent={doc.content}
                      language={doc.fileType === "html" ? "html" : "md"}
                      readOnly={!canEdit || Boolean(collab?.blocked)}
                      onChange={setBuffer}
                      maxContentBytes={canEdit ? maxEditableBytes : undefined}
                      onLimit={() =>
                        notify.error("Edit is too large", {
                          description: mapDocError(new Error("file-too-large")),
                        })
                      }
                      ytext={canEdit ? collab?.ytext : undefined}
                      awareness={canEdit ? collab?.awareness : undefined}
                    />
                  </div>
                ) : null}
                {viewMode !== "editor" ? (
                  <div className="min-w-0 flex-1">
                    <DocPreview
                      fileNode={selectedNode}
                      content={canEdit ? buffer : doc.content}
                      nodes={nodes}
                      iframeRef={previewFrameRef}
                    />
                  </div>
                ) : null}
              </div>
            </div>
          ) : selectedNode?.kind === "asset" && selectedNode.assetUrl ? (
            <div className="flex min-w-0 flex-1 items-center justify-center overflow-auto p-6">
              <img
                src={selectedNode.assetUrl}
                alt={selectedNode.name}
                className="max-h-full max-w-full rounded-md border border-hairline object-contain"
              />
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center p-6 text-center text-muted-foreground text-sm">
              {nodes.length === 0
                ? canEdit
                  ? "Create a .md or .html file to start writing."
                  : "This project has no documents yet."
                : "Select a file to open it."}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
