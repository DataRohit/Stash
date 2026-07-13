"use client";

import { useAuth, useUser } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import {
  ArrowLeft,
  BookmarkPlus,
  Check,
  CircleHelp,
  Code2,
  Columns2,
  Eye,
  History,
  List,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  PanelLeft,
  Share2,
  X,
} from "lucide-react";
import dynamic from "next/dynamic";
import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import * as Y from "yjs";
import {
  CommentsRail,
  type CommentThread,
  type MentionCandidate,
  type ResolvedCommentRange,
} from "@/app/dashboard/projects/[id]/editor/comments-rail";
import type {
  CommentFocusRequest,
  CommentRange,
  DocEditorHandle,
  EditorSelectionState,
} from "@/app/dashboard/projects/[id]/editor/doc-editor";
import { DocEditor } from "@/app/dashboard/projects/[id]/editor/doc-editor";
import { DocPreview } from "@/app/dashboard/projects/[id]/editor/doc-preview";
import { ExportMenu } from "@/app/dashboard/projects/[id]/editor/export-menu";
import { FileTree } from "@/app/dashboard/projects/[id]/editor/file-tree";
import { missingRefToast } from "@/app/dashboard/projects/[id]/editor/lib/doc-html";
import { mapDocError } from "@/app/dashboard/projects/[id]/editor/lib/editor-format";
import {
  extractDocOutline,
  extractTextOutline,
  type OutlineItem,
} from "@/app/dashboard/projects/[id]/editor/lib/outline";
import {
  type CollabViewer,
  useCollabDoc,
} from "@/app/dashboard/projects/[id]/editor/lib/use-collab-doc";
import { NewDocumentDialog } from "@/app/dashboard/projects/[id]/editor/new-document-dialog";
import { OutlinePanel } from "@/app/dashboard/projects/[id]/editor/outline-panel";
import type {
  RichCommentRange,
  RichDocSelection,
} from "@/app/dashboard/projects/[id]/editor/rich-doc-editor";
import { SaveTemplateDialog } from "@/app/dashboard/projects/[id]/editor/save-template-dialog";
import { SearchPanel } from "@/app/dashboard/projects/[id]/editor/search-panel";
import {
  type ShareMode,
  SharePopover,
  type ShareState,
} from "@/app/dashboard/projects/[id]/editor/share-popover";
import { TrashPanel } from "@/app/dashboard/projects/[id]/editor/trash-panel";
import type { TreeNode } from "@/app/dashboard/projects/[id]/editor/tree-utils";
import { DataSkeleton, DataState } from "@/components/ui/data-state";
import { Dialog } from "@/components/ui/dialog";
import { notify } from "@/components/ui/toast";
import { useDialogA11y } from "@/components/ui/use-dialog-a11y";
import { useMediaQuery } from "@/components/ui/use-media-query";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { isRasterAssetMimeType, RASTER_ASSET_FORMATS } from "@/lib/asset-formats";
import { formatBytes, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

type ProjectEditorProps = {
  projectId: string;
  projectTitle: string;
  clerkOrgId: string;
  canEdit: boolean;
  isAdmin: boolean;
};

type ViewMode = "editor" | "split" | "preview";

const RichDocEditor = dynamic(
  () => import("@/app/dashboard/projects/[id]/editor/rich-doc-editor"),
  {
    ssr: false,
    loading: () => <DataSkeleton label="Loading rich-text editor" rows={6} className="flex-1" />,
  },
);

const VersionHistoryModal = dynamic(
  () =>
    import("@/app/dashboard/projects/[id]/editor/version-history").then(
      (module) => module.VersionHistoryModal,
    ),
  { ssr: false },
);

const MAX_ASSET_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024;

function sidebarStorageKey(projectId: string): string {
  return `stash:editor:sidebar:${projectId}`;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
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
      <Image
        src={viewer.image}
        alt={viewer.name}
        width={size}
        height={size}
        unoptimized
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
  const wrapperRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useDialogA11y({
    open: open && canOpen,
    onClose: () => setOpen(false),
    containerRef: panelRef,
    initialFocusRef: closeRef,
    lockBody: false,
  });

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointer = (event: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
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
    <div ref={wrapperRef} className="relative z-[70] hidden sm:block">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={`${viewers.length} viewing this file`}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex cursor-pointer items-center rounded-full transition-opacity hover:opacity-90"
      >
        <ViewerStack viewers={viewers} />
      </button>
      {open ? (
        <div
          ref={panelRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          className="absolute top-9 right-0 z-[80] w-96 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-hairline bg-surface p-1 shadow-xl"
        >
          <div className="flex min-h-9 items-center justify-between gap-2 px-2 py-1">
            <p
              id={titleId}
              className="font-medium font-mono text-[10px] text-muted-foreground uppercase tracking-widest"
            >
              {viewers.length} {viewers.length === 1 ? "person here" : "people here"}
            </p>
            <button
              ref={closeRef}
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close presence details"
              className="flex size-7 items-center justify-center rounded-xs text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </div>
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
  canEdit: initialCanEdit,
  isAdmin: initialIsAdmin,
}: ProjectEditorProps) {
  const pid = projectId as Id<"projects">;
  const router = useRouter();
  const searchParams = useSearchParams();
  const { orgId, isLoaded: authLoaded } = useAuth();
  const orgChanged = authLoaded && orgId !== clerkOrgId;
  const project = useQuery(api.projects.get, orgChanged ? "skip" : { projectId: pid });
  const accessLost = orgChanged ? "org" : project === null ? "access" : null;
  const canEdit =
    project === undefined
      ? initialCanEdit
      : Boolean(project?.isAdmin || project?.viewerLevel === "editor");
  const isAdmin = project === undefined ? initialIsAdmin : Boolean(project?.isAdmin);
  const editAccessRevoked = project !== undefined && initialCanEdit && !canEdit;
  const nodesData = useQuery(api.documents.listByProject, accessLost ? "skip" : { projectId: pid });
  const nodes = useMemo(() => (nodesData ?? []) as TreeNode[], [nodesData]);
  const usage = useQuery(api.documents.usage, accessLost ? "skip" : { projectId: pid });

  const createFolder = useMutation(api.documents.createFolder);
  const createFile = useMutation(api.documents.createFile);
  const createDocument = useMutation(api.documents.createDocument);
  const createFromTemplate = useMutation(api.documents.createFromTemplate);
  const renameDoc = useMutation(api.documents.rename);
  const removeDoc = useMutation(api.documents.remove);
  const moveDoc = useMutation(api.documents.move);
  const duplicateDoc = useMutation(api.documents.duplicate);
  const generateUploadUrl = useMutation(api.documents.generateUploadUrl);
  const createAsset = useMutation(api.documents.createAsset);
  const importDocuments = useMutation(api.documents.importDocuments);
  const createCommentThread = useMutation(api.comments.createThread);
  const replyToComment = useMutation(api.comments.reply);
  const setCommentResolved = useMutation(api.comments.setResolved);
  const setShareMode = useMutation(api.sharing.setMode);
  const rotateShare = useMutation(api.sharing.rotateShareToken);
  const saveTemplate = useMutation(api.templates.saveFromDocument);
  const recordOpened = useMutation(api.navigation.recordOpened);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("split");
  const [mobileViewMode, setMobileViewMode] = useState<Exclude<ViewMode, "split">>("editor");
  const [buffer, setBuffer] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileFilesOpen, setMobileFilesOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [newDocumentParent, setNewDocumentParent] = useState<string | null | undefined>(undefined);
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [docOutline, setDocOutline] = useState<OutlineItem[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [editorSelection, setEditorSelection] = useState<
    EditorSelectionState | RichDocSelection | null
  >(null);
  const [focusRequest, setFocusRequest] = useState<CommentFocusRequest | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [origin] = useState(() => (typeof window === "undefined" ? "" : window.location.origin));
  const [historyState, setHistoryState] = useState<{ documentId: string | null; open: boolean }>({
    documentId: null,
    open: false,
  });
  const lastSeeded = useRef<string | null>(null);
  const previewFrameRef = useRef<HTMLIFrameElement>(null);
  const editorRef = useRef<DocEditorHandle | null>(null);
  const handledDeepLinkRef = useRef<string | null>(null);
  const mobileCloseRef = useRef<HTMLButtonElement>(null);
  const mobileDrawerRef = useRef<HTMLElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const moreFirstRef = useRef<HTMLButtonElement>(null);
  const compactView = useMediaQuery("(max-width: 767px)");
  const compactActions = useMediaQuery("(max-width: 1023px)");
  const effectiveViewMode = compactView ? mobileViewMode : viewMode;

  useDialogA11y({
    open: mobileFilesOpen,
    onClose: () => setMobileFilesOpen(false),
    containerRef: mobileDrawerRef,
    initialFocusRef: mobileCloseRef,
  });

  useDialogA11y({
    open: moreOpen,
    onClose: () => setMoreOpen(false),
    containerRef: moreMenuRef,
    initialFocusRef: moreFirstRef,
    lockBody: false,
  });

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!compactView) {
        setMobileFilesOpen(false);
      }
      if (!compactActions) {
        setMoreOpen(false);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [compactActions, compactView]);

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
  const selectedAssetId = selectedNode?.kind === "asset" ? selectedNode.id : null;
  const selectedAssetUrls = useQuery(
    api.documents.getAssetUrls,
    selectedAssetId ? { documentIds: [selectedAssetId as Id<"documents">] } : "skip",
  );
  const selectedAssetUrl = selectedAssetUrls?.[0]?.url ?? null;
  const isDoc = selectedNode?.kind === "file" && selectedNode.fileType === "doc";
  const historyOpen = Boolean(
    selectedFileId && historyState.open && historyState.documentId === selectedFileId,
  );
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
  const commentThreadsData = useQuery(
    api.comments.listForDocument,
    selectedFileId && !accessLost ? { documentId: selectedFileId as Id<"documents"> } : "skip",
  );
  const mentionCandidatesData = useQuery(
    api.comments.mentionCandidates,
    commentsOpen && selectedFileId && !accessLost ? { projectId: pid } : "skip",
  );
  const shareStateData = useQuery(
    api.sharing.getState,
    selectedFileId && isAdmin && shareOpen && !accessLost
      ? { documentId: selectedFileId as Id<"documents"> }
      : "skip",
  );
  const commentThreads = useMemo(
    () => (commentThreadsData ?? []) as CommentThread[],
    [commentThreadsData],
  );
  const mentionCandidates = useMemo(
    () => (mentionCandidatesData ?? []) as MentionCandidate[],
    [mentionCandidatesData],
  );
  const shareState = useMemo(
    () => shareStateData as ShareState | null | undefined,
    [shareStateData],
  );
  const collabYdoc = collab?.ydoc;
  const collabYtext = collab?.ytext;
  const resolvedCommentRanges = useMemo(() => {
    const ranges = new Map<string, ResolvedCommentRange>();
    if (isDoc || !collabYdoc || !collabYtext) {
      return ranges;
    }
    for (const thread of commentThreads) {
      try {
        const start = Y.createAbsolutePositionFromRelativePosition(
          Y.decodeRelativePosition(new Uint8Array(thread.startRel)),
          collabYdoc,
        );
        const end = Y.createAbsolutePositionFromRelativePosition(
          Y.decodeRelativePosition(new Uint8Array(thread.endRel)),
          collabYdoc,
        );
        if (!start || !end || start.type !== collabYtext || end.type !== collabYtext) {
          continue;
        }
        const from = Math.min(start.index, end.index);
        const to = Math.max(start.index, end.index);
        if (from < to) {
          ranges.set(thread.id, { id: thread.id, from, to, status: thread.status });
        }
      } catch (error) {
        if (process.env.NODE_ENV === "development") {
          console.error(error);
        }
      }
    }
    return ranges;
  }, [collabYdoc, collabYtext, commentThreads, isDoc]);
  const commentRanges = useMemo<CommentRange[]>(
    () => [...resolvedCommentRanges.values()],
    [resolvedCommentRanges],
  );
  const richCommentRanges = useMemo<RichCommentRange[]>(
    () =>
      isDoc
        ? commentThreads.map((thread) => ({
            id: thread.id,
            startRel: thread.startRel,
            endRel: thread.endRel,
            status: thread.status,
          }))
        : [],
    [commentThreads, isDoc],
  );
  const unresolvedCommentCount = commentThreads.filter((thread) => thread.status === "open").length;
  const commentSelection = effectiveViewMode === "preview" ? null : editorSelection;
  const outlineItems = useMemo<OutlineItem[]>(() => {
    if (!outlineOpen || !selectedFileId || selectedNode?.kind !== "file") {
      return [];
    }
    if (isDoc) {
      return docOutline;
    }
    const source = canEdit ? buffer : (doc?.content ?? "");
    return extractTextOutline(source, selectedNode.fileType === "html");
  }, [outlineOpen, selectedFileId, selectedNode, isDoc, docOutline, buffer, canEdit, doc]);

  const scrollToOutline = (item: OutlineItem) => {
    setOutlineOpen(false);
    if (isDoc) {
      const headings = document.querySelectorAll<HTMLElement>(
        ".tiptap-doc-content :is(h1,h2,h3,h4,h5,h6)",
      );
      headings[item.index]?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    editorRef.current?.focusRange(item.offset, item.offset);
    previewFrameRef.current?.contentWindow?.postMessage(
      { type: "stash-scroll-heading", target: item.target },
      "*",
    );
  };

  useEffect(() => {
    if (orgChanged) {
      router.refresh();
    }
  }, [orgChanged, router]);

  useEffect(() => {
    const fileId = searchParams.get("file");
    const threadId = searchParams.get("thread");
    if (!fileId) {
      return;
    }
    const key = `${fileId}:${threadId ?? ""}`;
    if (handledDeepLinkRef.current === key) {
      return;
    }
    const target = nodes.find((node) => node.id === fileId);
    if (target && target.kind !== "folder") {
      const timer = window.setTimeout(() => {
        handledDeepLinkRef.current = key;
        setSelectedId(target.id);
        if (threadId) {
          setCommentsOpen(true);
          setActiveCommentId(threadId);
        }
      }, 0);
      return () => window.clearTimeout(timer);
    }
  }, [nodes, searchParams]);

  useEffect(() => {
    if (!selectedNode || selectedNode.kind === "folder" || accessLost) {
      return;
    }
    void recordOpened({ documentId: selectedNode.id as Id<"documents"> });
  }, [accessLost, recordOpened, selectedNode]);

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
    if (!moreOpen) {
      return;
    }
    const onPointer = (event: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(event.target as Node)) {
        setMoreOpen(false);
      }
    };
    window.addEventListener("mousedown", onPointer);
    return () => {
      window.removeEventListener("mousedown", onPointer);
    };
  }, [moreOpen]);

  useEffect(() => {
    if (doc && doc.id === selectedFileId && lastSeeded.current !== selectedFileId) {
      setBuffer(doc.content);
      lastSeeded.current = selectedFileId;
      setEditorSelection(null);
      setShareOpen(false);
    }
  }, [doc, selectedFileId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        notify.success("Changes sync automatically");
        return;
      }
      if (
        event.key === "?" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.repeat &&
        !event.isComposing &&
        !isEditableShortcutTarget(event.target)
      ) {
        event.preventDefault();
        setShortcutsOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!outlineOpen || !isDoc || !collab?.ydoc) {
      return;
    }
    const ydoc = collab.ydoc;
    const fragment = ydoc.getXmlFragment("prosemirror");
    const update = () => setDocOutline(extractDocOutline(fragment));
    update();
    ydoc.on("update", update);
    return () => ydoc.off("update", update);
  }, [outlineOpen, isDoc, collab?.ydoc]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.source !== previewFrameRef.current?.contentWindow) {
        return;
      }
      if (event.data?.type === "stash-open-doc") {
        const target = nodes.find((node) => node.id === event.data.id);
        if (target?.kind === "file") {
          setSelectedId(target.id);
        } else {
          const toast = missingRefToast(null);
          notify.error(toast.title, {
            description: "The linked file was moved or deleted from this project.",
          });
        }
      }
      if (event.data?.type === "stash-missing-ref") {
        const toast = missingRefToast(event.data.ref);
        notify.error(toast.title, { description: toast.description });
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [nodes]);

  useEffect(() => {
    if (!activeCommentId) {
      return;
    }
    const range = resolvedCommentRanges.get(activeCommentId);
    if (range) {
      const timer = window.setTimeout(() => {
        editorRef.current?.focusRange(range.from, range.to);
      }, 0);
      return () => window.clearTimeout(timer);
    }
  }, [activeCommentId, resolvedCommentRanges]);

  const guard = async (action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (error) {
      notify.error("Action failed", { description: mapDocError(error) });
    }
  };

  const handleUpload = async (parentId: string | null, files: File[]) => {
    const imports = files.filter((file) => /\.(?:md|markdown|html?|txt)$/i.test(file.name));
    const assets = files.filter((file) => isRasterAssetMimeType(file.type));
    if (imports.length + assets.length !== files.length) {
      notify.error("Unsupported file", {
        description: `Upload ${RASTER_ASSET_FORMATS} images, Markdown, HTML, or plain-text files.`,
      });
    }
    if (imports.length > 0) {
      await guard(async () => {
        await importDocuments({
          projectId: pid,
          parentId: parentId as Id<"documents"> | null,
          files: await Promise.all(
            imports.map(async (file) => ({ name: file.name, content: await file.text() })),
          ),
        });
      });
    }
    for (const file of assets) {
      if (file.size > MAX_ASSET_BYTES) {
        notify.error("File too large", { description: "Each asset can be up to 5 MB." });
        continue;
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
    }
  };

  const insertImageAsset = async (file: File): Promise<string | null> => {
    if (selectedNode?.kind !== "file") {
      return null;
    }
    if (!isRasterAssetMimeType(file.type)) {
      notify.error("Unsupported image", {
        description: `Images must be ${RASTER_ASSET_FORMATS}.`,
      });
      return null;
    }
    if (file.size > MAX_ASSET_BYTES) {
      notify.error("File too large", { description: "Each image can be up to 5 MB." });
      return null;
    }
    const subtype = file.type.split("/")[1] ?? "png";
    const name = file.name.length > 0 ? file.name : `image-${Date.now()}.${subtype}`;
    try {
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
      const asset = await createAsset({
        projectId: pid,
        parentId: selectedNode.parentId as Id<"documents"> | null,
        name,
        storageId,
      });
      notify.success("Image inserted");
      return asset.name;
    } catch (error) {
      notify.error("Image upload failed", { description: mapDocError(error) });
      return null;
    }
  };

  const createThreadFromSelection = async (body: string, mentionUserIds: string[]) => {
    if (
      !selectedFileId ||
      !collab?.ready ||
      !editorSelection ||
      (!isDoc && (!collab.ytext || effectiveViewMode === "preview")) ||
      editorSelection.from >= editorSelection.to
    ) {
      notify.error("Select text first", {
        description:
          effectiveViewMode === "preview"
            ? "Switch to editor or split view before starting a thread."
            : "Comments need a highlighted range in the editor.",
      });
      return;
    }
    try {
      const anchors = isDoc
        ? {
            startRel: (editorSelection as RichDocSelection).startRel,
            endRel: (editorSelection as RichDocSelection).endRel,
          }
        : {
            startRel: toArrayBuffer(
              Y.encodeRelativePosition(
                Y.createRelativePositionFromTypeIndex(collab.ytext as Y.Text, editorSelection.from),
              ),
            ),
            endRel: toArrayBuffer(
              Y.encodeRelativePosition(
                Y.createRelativePositionFromTypeIndex(collab.ytext as Y.Text, editorSelection.to),
              ),
            ),
          };
      const commentId = await createCommentThread({
        documentId: selectedFileId as Id<"documents">,
        startRel: anchors.startRel,
        endRel: anchors.endRel,
        quote: editorSelection.text,
        body,
        mentionUserIds,
      });
      setCommentsOpen(true);
      setActiveCommentId(commentId);
      notify.success("Comment added");
    } catch (error) {
      notify.error("Comment failed", { description: mapDocError(error) });
      throw error;
    }
  };

  const replyToThread = async (commentId: string, body: string, mentionUserIds: string[]) => {
    try {
      await replyToComment({
        commentId: commentId as Id<"comments">,
        body,
        mentionUserIds,
      });
      setActiveCommentId(commentId);
    } catch (error) {
      notify.error("Reply failed", { description: mapDocError(error) });
      throw error;
    }
  };

  const resolveThread = async (commentId: string, resolved: boolean) => {
    try {
      await setCommentResolved({ commentId: commentId as Id<"comments">, resolved });
      setActiveCommentId(commentId);
    } catch (error) {
      notify.error("Update failed", { description: mapDocError(error) });
      throw error;
    }
  };

  const updateShareMode = async (mode: ShareMode, expiresAt?: number | null) => {
    if (!selectedFileId) {
      return;
    }
    try {
      await setShareMode({ documentId: selectedFileId as Id<"documents">, mode, expiresAt });
      notify.success(mode === "private" ? "Share link revoked" : "Share settings updated");
    } catch (error) {
      notify.error("Share update failed", { description: mapDocError(error) });
      throw error;
    }
  };

  const rotateShareLink = async () => {
    if (!selectedFileId) {
      return;
    }
    try {
      await rotateShare({ documentId: selectedFileId as Id<"documents"> });
      notify.success("Share link rotated");
    } catch (error) {
      notify.error("Rotate failed", { description: mapDocError(error) });
      throw error;
    }
  };

  const copyShareLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      notify.success("Share link copied");
    } catch (error) {
      notify.error("Copy failed", { description: mapDocError(error) });
      throw error;
    }
  };

  const focusThread = (commentId: string) => {
    setActiveCommentId(commentId);
    if (isDoc) {
      return;
    }
    const range = resolvedCommentRanges.get(commentId);
    if (range) {
      setFocusRequest({ id: commentId, from: range.from, to: range.to, nonce: Date.now() });
      editorRef.current?.focusRange(range.from, range.to);
    }
  };

  const selectNode = (id: string) => {
    setSelectedId(id);
    setMobileFilesOpen(false);
  };

  const renderFileBrowser = () => (
    <SearchPanel
      projectId={pid}
      nodes={nodes}
      query={searchQuery}
      onQueryChange={setSearchQuery}
      selectedId={effectiveSelectedId}
      onSelect={selectNode}
    >
      <FileTree
        nodes={nodes}
        selectedId={effectiveSelectedId}
        canEdit={canEdit}
        onSelect={(node) => selectNode(node.id)}
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
            createFile({
              projectId: pid,
              parentId: parentId as Id<"documents"> | null,
              name,
            }),
          )
        }
        onCreateDocument={(parentId, name) =>
          guard(() =>
            createDocument({
              projectId: pid,
              parentId: parentId as Id<"documents"> | null,
              name,
            }),
          )
        }
        onRename={(id, name) => guard(() => renameDoc({ documentId: id as Id<"documents">, name }))}
        onRemove={(node) =>
          guard(async () => {
            await removeDoc({ documentId: node.id as Id<"documents"> });
            const removedIds = new Set<string>([node.id]);
            let changed = true;
            while (changed) {
              changed = false;
              for (const child of nodes) {
                if (child.parentId && removedIds.has(child.parentId) && !removedIds.has(child.id)) {
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
        onMove={(id, parentId) =>
          guard(() =>
            moveDoc({
              documentId: id as Id<"documents">,
              parentId: parentId as Id<"documents"> | null,
            }),
          )
        }
        onDuplicate={(node) =>
          guard(async () => {
            const id = await duplicateDoc({ documentId: node.id as Id<"documents"> });
            selectNode(id);
          })
        }
        onOpenTrash={() => setTrashOpen(true)}
        onOpenDocumentDialog={setNewDocumentParent}
      />
    </SearchPanel>
  );

  const saveStatus = selectedFileId
    ? collab?.pendingEdits
      ? "Reconnecting..."
      : collab?.syncing
        ? "Syncing..."
        : collab?.lastSyncedAt
          ? `Live ${formatRelativeTime(collab.lastSyncedAt)}`
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
      <div className="glass relative z-[60] flex h-14 shrink-0 items-center justify-between gap-2 overflow-hidden rounded-lg px-3 sm:gap-3 sm:px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
          <button
            type="button"
            onClick={() => setMobileFilesOpen(true)}
            aria-label="Open file drawer"
            aria-controls="mobile-file-drawer"
            aria-expanded={mobileFilesOpen}
            className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-xs text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground sm:hidden"
          >
            <PanelLeft className="size-4" aria-hidden="true" />
          </button>
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
            className="flex min-w-0 shrink items-center gap-1.5 font-medium font-mono text-muted-foreground text-xs uppercase tracking-widest transition-colors hover:text-foreground sm:max-w-48"
          >
            <ArrowLeft className="size-3.5" aria-hidden="true" />
            <span className="hidden truncate sm:inline">{projectTitle}</span>
          </Link>
          {selectedNode ? (
            <span className="min-w-0 truncate font-mono text-muted-foreground text-xs">
              {selectedNode.name}
            </span>
          ) : null}
          {!canEdit ? (
            <span className="hidden shrink-0 items-center gap-1 rounded-full border border-hairline bg-surface/60 px-2 py-0.5 font-medium font-mono text-[10px] text-muted-foreground uppercase tracking-widest sm:inline-flex">
              <Eye className="size-3" aria-hidden="true" />
              View only
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
          <span className="sr-only" aria-live="polite">
            {saveStatus ? `Save state: ${saveStatus}` : "No document selected"}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
          {selectedFileId && collab ? (
            <>
              <ViewerPresence viewers={collab.viewers} canOpen={isAdmin} />
              <span className="sr-only" aria-live="polite">
                {collab.viewers.length} {collab.viewers.length === 1 ? "person" : "people"} in this
                file
              </span>
            </>
          ) : null}
          <div className="hidden items-center gap-2 xl:flex">
            <div
              className="h-1.5 w-24 overflow-hidden rounded-full bg-foreground/10"
              role="progressbar"
              aria-label="Project storage used"
              aria-valuemin={0}
              aria-valuemax={maxBytes}
              aria-valuenow={usedBytes}
            >
              <div
                className={cn(
                  "h-full rounded-full",
                  usedPercent >= 90 ? "bg-destructive" : "bg-accent",
                )}
                style={{ width: `${usedPercent}%` }}
              />
            </div>
            <span className="font-mono text-muted-foreground text-xs tabular-nums">
              {formatBytes(usedBytes)} / {formatBytes(maxBytes)}
            </span>
          </div>
          <span className="hidden rounded-sm border border-hairline px-2 py-1 font-mono text-[10px] text-muted-foreground tabular-nums lg:inline-flex xl:hidden">
            {usedPercent}%
          </span>
          {selectedFileId ? (
            <div className="flex items-center gap-1.5">
              {isAdmin ? (
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setShareOpen((value) => !value)}
                    aria-label="Share document"
                    aria-haspopup="dialog"
                    aria-expanded={shareOpen}
                    aria-pressed={shareOpen}
                    className={cn(
                      "relative flex size-8 cursor-pointer items-center justify-center rounded-sm border border-hairline transition-colors",
                      shareOpen
                        ? "bg-foreground/[0.08] text-foreground"
                        : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground",
                    )}
                  >
                    <Share2 className="size-4" aria-hidden="true" />
                    {shareState?.mode && shareState.mode !== "private" ? (
                      <span className="absolute -top-1 -right-1 size-2 rounded-full bg-accent" />
                    ) : null}
                  </button>
                  {shareOpen ? (
                    <SharePopover
                      open={shareOpen}
                      onClose={() => setShareOpen(false)}
                      state={shareState}
                      origin={origin}
                      onSetMode={updateShareMode}
                      onRotate={rotateShareLink}
                      onCopy={copyShareLink}
                    />
                  ) : null}
                </div>
              ) : null}
              <button
                type="button"
                onClick={() => setCommentsOpen((value) => !value)}
                aria-label={`Comments, ${unresolvedCommentCount} open`}
                aria-haspopup="dialog"
                aria-expanded={commentsOpen}
                aria-pressed={commentsOpen}
                className={cn(
                  "relative flex size-8 cursor-pointer items-center justify-center rounded-sm border border-hairline transition-colors",
                  commentsOpen
                    ? "bg-foreground/[0.08] text-foreground"
                    : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground",
                )}
              >
                <MessageSquare className="size-4" aria-hidden="true" />
                {unresolvedCommentCount > 0 ? (
                  <span className="absolute -top-1 -right-1 flex min-w-4 items-center justify-center rounded-full bg-accent px-1 font-mono text-[9px] text-background">
                    {unresolvedCommentCount}
                  </span>
                ) : null}
              </button>
              <button
                type="button"
                onClick={() => setOutlineOpen((value) => !value)}
                aria-label="Document outline"
                aria-haspopup="dialog"
                aria-expanded={outlineOpen}
                aria-pressed={outlineOpen}
                className={cn(
                  "hidden size-8 cursor-pointer items-center justify-center rounded-sm border border-hairline transition-colors lg:flex",
                  outlineOpen
                    ? "bg-foreground/[0.08] text-foreground"
                    : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground",
                )}
              >
                <List className="size-4" aria-hidden="true" />
              </button>
              {selectedNode?.kind === "file" && doc ? (
                <ExportMenu
                  projectId={pid}
                  fileNode={selectedNode}
                  content={canEdit ? buffer : doc.content}
                  nodes={nodes}
                  richContentState={
                    isDoc && collab ? toArrayBuffer(Y.encodeStateAsUpdate(collab.ydoc)) : null
                  }
                />
              ) : null}
              {isAdmin && selectedFileId ? (
                <button
                  type="button"
                  onClick={() => setSaveTemplateOpen(true)}
                  aria-label="Save as organization template"
                  className="hidden size-8 cursor-pointer items-center justify-center rounded-sm border border-hairline text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground lg:flex"
                >
                  <BookmarkPlus className="size-4" />
                </button>
              ) : null}
              <div ref={moreRef} className="relative lg:hidden">
                <button
                  type="button"
                  onClick={() => setMoreOpen((value) => !value)}
                  aria-label="More document actions"
                  aria-haspopup="menu"
                  aria-expanded={moreOpen}
                  className="flex size-8 cursor-pointer items-center justify-center rounded-sm border border-hairline text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
                >
                  <MoreHorizontal className="size-4" aria-hidden="true" />
                </button>
                {moreOpen ? (
                  <div
                    ref={moreMenuRef}
                    tabIndex={-1}
                    className="absolute top-10 right-0 z-[80] w-48 rounded-lg border border-hairline bg-surface p-1 shadow-xl"
                    role="menu"
                  >
                    <button
                      ref={moreFirstRef}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMoreOpen(false);
                        setOutlineOpen(true);
                      }}
                      className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-muted-foreground text-xs hover:bg-foreground/[0.06] hover:text-foreground"
                    >
                      <List className="size-4" aria-hidden="true" />
                      Document outline
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMoreOpen(false);
                        setHistoryState({ documentId: selectedFileId, open: true });
                      }}
                      className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-muted-foreground text-xs hover:bg-foreground/[0.06] hover:text-foreground"
                    >
                      <History className="size-4" aria-hidden="true" />
                      Version history
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMoreOpen(false);
                        setShortcutsOpen(true);
                      }}
                      className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-muted-foreground text-xs hover:bg-foreground/[0.06] hover:text-foreground"
                    >
                      <CircleHelp className="size-4" aria-hidden="true" />
                      Keyboard shortcuts
                    </button>
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => setShortcutsOpen(true)}
                aria-label="Keyboard shortcuts"
                className="hidden size-8 cursor-pointer items-center justify-center rounded-sm border border-hairline text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground lg:flex"
              >
                <CircleHelp className="size-4" aria-hidden="true" />
              </button>
              {!isDoc ? (
                <fieldset className="flex min-w-0 items-center gap-0.5 rounded-sm border border-hairline p-0.5">
                  <legend className="sr-only">View mode</legend>
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
                      onClick={() => {
                        if (compactView) {
                          if (mode !== "split") {
                            setMobileViewMode(mode);
                          }
                        } else {
                          setViewMode(mode);
                        }
                      }}
                      aria-label={label}
                      aria-pressed={effectiveViewMode === mode}
                      className={cn(
                        "flex size-7 cursor-pointer items-center justify-center rounded-xs transition-colors",
                        mode === "split" && "hidden md:flex",
                        effectiveViewMode === mode
                          ? "bg-foreground/[0.08] text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <Icon className="size-4" aria-hidden="true" />
                    </button>
                  ))}
                </fieldset>
              ) : null}
            </div>
          ) : null}
          {selectedFileId ? (
            <button
              type="button"
              onClick={() =>
                setHistoryState((value) => ({
                  documentId: selectedFileId,
                  open: value.documentId === selectedFileId ? !value.open : true,
                }))
              }
              aria-label="Version history"
              aria-pressed={historyOpen}
              className={cn(
                "hidden size-8 cursor-pointer items-center justify-center rounded-sm border border-hairline transition-colors lg:flex",
                historyOpen
                  ? "bg-foreground/[0.08] text-foreground"
                  : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground",
              )}
            >
              <History className="size-4" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>

      <div className="relative z-0 flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {mobileFilesOpen ? (
          <div className="fixed inset-0 z-[95] p-3 pt-24 sm:hidden">
            <button
              type="button"
              aria-label="Close file drawer overlay"
              className="absolute inset-0 cursor-default bg-black/45"
              onClick={() => setMobileFilesOpen(false)}
            />
            <section
              ref={mobileDrawerRef}
              id="mobile-file-drawer"
              tabIndex={-1}
              role="dialog"
              aria-modal="true"
              aria-label="Project files"
              className="glass relative flex h-[min(82dvh,calc(100dvh-7rem))] w-full flex-col overflow-hidden rounded-lg"
            >
              <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-hairline border-b pr-2 pl-3">
                <span className="font-medium font-mono text-muted-foreground text-xs uppercase tracking-widest">
                  Project files
                </span>
                <button
                  ref={mobileCloseRef}
                  type="button"
                  onClick={() => setMobileFilesOpen(false)}
                  aria-label="Close file drawer"
                  className="flex size-7 cursor-pointer items-center justify-center rounded-xs text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                >
                  <X className="size-4" aria-hidden="true" />
                </button>
              </div>
              <div className="min-h-0 flex-1">{renderFileBrowser()}</div>
            </section>
          </div>
        ) : null}
        <div
          className={cn(
            "glass hidden shrink-0 overflow-hidden rounded-lg",
            sidebarCollapsed ? "sm:hidden" : "sm:block",
          )}
          style={{ width: `${sidebarWidth}px` }}
        >
          {renderFileBrowser()}
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

        <div className="editor-surface flex min-w-0 flex-1 overflow-hidden rounded-lg">
          {selectedNode?.kind === "file" && doc && doc.id === selectedFileId ? (
            <div className="flex min-w-0 flex-1 flex-col">
              {editAccessRevoked ? (
                <div
                  role="status"
                  aria-live="polite"
                  className="shrink-0 border-warning/30 border-b bg-warning/8 px-4 py-2 text-warning text-xs"
                >
                  Your edit access changed. This document is now read-only.
                </div>
              ) : null}
              {collab?.blocked ? (
                <div className="shrink-0 border-destructive/30 border-b bg-destructive/8 px-4 py-2 text-destructive text-xs">
                  {collab.blocked} Editing is paused until this file can sync again.
                </div>
              ) : null}
              {!collab?.blocked && collab?.pendingEdits ? (
                <div
                  role="status"
                  aria-live="polite"
                  className="shrink-0 border-info/30 border-b bg-info/8 px-4 py-2 text-info text-xs"
                >
                  Reconnecting — {collab.pendingEdits}{" "}
                  {collab.pendingEdits === 1 ? "edit" : "edits"} pending.
                </div>
              ) : null}
              {isDoc ? (
                collab?.ready && collab.sessionId ? (
                  <RichDocEditor
                    key={selectedFileId}
                    ydoc={collab.ydoc}
                    awareness={collab.awareness}
                    editable={canEdit && !collab.blocked}
                    userName={collab.userLabel}
                    userColor={collab.color}
                    userColorLight={collab.colorLight}
                    sessionId={collab.sessionId}
                    commentRanges={richCommentRanges}
                    activeCommentId={activeCommentId}
                    onSelectionChange={setEditorSelection}
                    onCommentRangeClick={(commentId) => {
                      setCommentsOpen(true);
                      focusThread(commentId);
                    }}
                  />
                ) : (
                  <DataSkeleton label="Loading document" rows={6} className="min-h-0 flex-1" />
                )
              ) : (
                <div className="flex min-h-0 flex-1">
                  {effectiveViewMode !== "preview" ? (
                    <div
                      className={cn(
                        "min-w-0 overflow-auto",
                        effectiveViewMode === "split"
                          ? "flex-1 border-hairline border-r"
                          : "flex-1",
                      )}
                    >
                      <DocEditor
                        ref={editorRef}
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
                        ytext={collab?.ytext}
                        awareness={collab?.awareness}
                        commentRanges={commentRanges}
                        activeCommentId={activeCommentId}
                        focusRequest={focusRequest}
                        onSelectionChange={setEditorSelection}
                        onCommentRangeClick={(commentId) => {
                          setCommentsOpen(true);
                          focusThread(commentId);
                        }}
                        onInsertImage={canEdit ? insertImageAsset : undefined}
                        fileNode={selectedNode}
                        nodes={nodes}
                      />
                    </div>
                  ) : null}
                  {effectiveViewMode !== "editor" ? (
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
              )}
            </div>
          ) : selectedFileId && doc === undefined ? (
            <div className="editor-panel flex min-w-0 flex-1 overflow-hidden">
              <DataSkeleton label="Loading document" rows={6} className="w-full" />
            </div>
          ) : selectedNode?.kind === "asset" && selectedAssetUrl ? (
            <div className="editor-panel flex min-w-0 flex-1 items-center justify-center overflow-auto p-6">
              <Image
                src={selectedAssetUrl}
                alt={selectedNode.name}
                width={1600}
                height={1200}
                unoptimized
                className="max-h-full max-w-full rounded-md border border-hairline object-contain"
              />
            </div>
          ) : selectedNode?.kind === "asset" ? (
            <div className="editor-panel flex flex-1 items-center justify-center p-6 text-center">
              {selectedAssetUrls === undefined ? (
                <DataSkeleton label="Loading asset" rows={3} className="w-full max-w-lg" />
              ) : (
                <DataState
                  kind="error"
                  title="Asset unavailable"
                  description="The stored asset could not be loaded. Refresh the project and try again."
                />
              )}
            </div>
          ) : (
            <div className="editor-panel flex flex-1 items-center justify-center p-6 text-center">
              {nodesData === undefined ? (
                <DataSkeleton label="Loading project files" rows={5} className="w-full max-w-lg" />
              ) : (
                <DataState
                  title={nodes.length === 0 ? "No documents yet" : "Select a file"}
                  description={
                    nodes.length === 0
                      ? canEdit
                        ? "Create a file or document to start writing."
                        : "This project does not contain any documents."
                      : "Choose a file from the project tree to open it."
                  }
                />
              )}
            </div>
          )}
        </div>
        {outlineOpen && selectedFileId && selectedNode?.kind === "file" ? (
          <OutlinePanel
            open={outlineOpen}
            items={outlineItems}
            onSelect={scrollToOutline}
            onClose={() => setOutlineOpen(false)}
          />
        ) : null}
        {commentsOpen && selectedFileId ? (
          <CommentsRail
            threads={commentThreads}
            loading={commentThreadsData === undefined}
            candidates={mentionCandidates}
            ranges={resolvedCommentRanges}
            activeThreadId={activeCommentId}
            selection={commentSelection}
            onClose={() => setCommentsOpen(false)}
            onCreate={createThreadFromSelection}
            onReply={replyToThread}
            onResolve={resolveThread}
            onFocusThread={focusThread}
          />
        ) : null}
      </div>
      {historyOpen && selectedFileId && selectedNode?.kind === "file" && doc ? (
        <VersionHistoryModal
          key={selectedFileId}
          documentId={selectedFileId}
          fileNode={selectedNode}
          nodes={nodes}
          currentContent={isDoc ? doc.content : canEdit ? buffer : doc.content}
          language={doc.fileType === "html" ? "html" : doc.fileType === "doc" ? "doc" : "md"}
          canCheckpoint={canEdit && !collab?.syncing}
          canManage={isAdmin}
          onClose={() => setHistoryState({ documentId: selectedFileId, open: false })}
          onRestored={(documentId) => {
            setSelectedId(documentId);
            setHistoryState({ documentId, open: false });
            setViewMode("split");
            setMobileViewMode("editor");
          }}
        />
      ) : null}
      <TrashPanel
        open={trashOpen}
        projectId={pid}
        isAdmin={isAdmin}
        onClose={() => setTrashOpen(false)}
      />
      <Dialog
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
        title="Keyboard shortcuts"
        icon={<CircleHelp className="size-4" aria-hidden="true" />}
        description="Use these shortcuts from anywhere in the editor unless you are typing in a field."
        className="max-w-md"
      >
        <dl className="divide-y divide-hairline px-3 py-2">
          {[
            ["Quick open", "Ctrl / ⌘ K"],
            ["Confirm automatic sync", "Ctrl / ⌘ S"],
            ["Open this reference", "?"],
            ["Close a dialog", "Esc"],
          ].map(([label, keys]) => (
            <div key={label} className="flex items-center justify-between gap-4 py-3">
              <dt className="text-sm">{label}</dt>
              <dd>
                <kbd className="rounded-xs border border-hairline bg-surface/60 px-2 py-1 font-mono text-[10px] text-muted-foreground">
                  {keys}
                </kbd>
              </dd>
            </div>
          ))}
        </dl>
      </Dialog>
      <NewDocumentDialog
        open={newDocumentParent !== undefined}
        projectId={pid}
        parentId={newDocumentParent ?? null}
        onClose={() => setNewDocumentParent(undefined)}
        onCreate={async (value) => {
          const id = await createFromTemplate({
            projectId: pid,
            parentId: value.parentId as Id<"documents"> | null,
            name: value.name,
            fileType: value.fileType,
            templateId: value.templateId,
          });
          selectNode(id);
        }}
      />
      {selectedFileId && selectedNode?.kind === "file" ? (
        <SaveTemplateDialog
          open={saveTemplateOpen}
          documentName={selectedNode.name}
          fileType={selectedNode.fileType ?? "doc"}
          onClose={() => setSaveTemplateOpen(false)}
          onSave={async (name) => {
            await saveTemplate({ documentId: selectedFileId as Id<"documents">, name });
            notify.success("Organization template saved");
          }}
        />
      ) : null}
    </div>
  );
}
