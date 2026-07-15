"use client";

import { useMutation, useQuery } from "convex/react";
import {
  Check,
  ChevronDown,
  Clock3,
  Code2,
  Eye,
  History,
  Loader2,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DiffView } from "@/app/dashboard/projects/[id]/editor/diff-view";
import { DocEditor } from "@/app/dashboard/projects/[id]/editor/doc-editor";
import { DocPreview } from "@/app/dashboard/projects/[id]/editor/doc-preview";
import { historyEmail, mapDocError } from "@/app/dashboard/projects/[id]/editor/lib/editor-format";
import type { TreeNode } from "@/app/dashboard/projects/[id]/editor/tree-utils";
import { BoardView } from "@/components/board-view";
import { SheetTable } from "@/components/sheet-table";
import { DataLoader, DataState } from "@/components/ui/data-state";
import { notify } from "@/components/ui/toast";
import { useDialogA11y } from "@/components/ui/use-dialog-a11y";
import { ViewPreview } from "@/components/view-preview";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { formatBytes, formatDateTime, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

type VersionHistoryModalProps = {
  documentId: string;
  fileNode: TreeNode;
  nodes: TreeNode[];
  currentContent: string;
  language: "md" | "html";
  canCheckpoint: boolean;
  canManage: boolean;
  onClose: () => void;
  onRestored: (documentId: string) => void;
};

type MainTab = "file" | "diff" | "compare";
type FileMode = "preview" | "source";

type SnapshotRow = {
  id: string;
  versionNumber: number;
  authorName: string;
  authorEmail?: string;
  createdAt: number;
};

const PRIMARY_BUTTON =
  "inline-flex h-7 cursor-pointer items-center gap-1 rounded-xs bg-foreground px-2.5 font-medium text-background text-xs transition-colors hover:bg-foreground/90 disabled:cursor-not-allowed disabled:bg-foreground/12 disabled:text-muted-foreground";

function noop() {
  return undefined;
}

function TabButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-7 w-full cursor-pointer items-center justify-center rounded-xs px-2.5 font-medium text-xs transition-colors",
        active
          ? "bg-foreground/[0.08] text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

function VersionSelect({
  label,
  value,
  snapshots,
  onChange,
}: {
  label: string;
  value: string | null;
  snapshots: SnapshotRow[];
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = snapshots.find((snapshot) => snapshot.id === value) ?? null;

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest("[data-version-select]")) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <div data-version-select className="relative min-w-0 flex-1">
      <span className="mb-1 block font-medium font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
        {label}
      </span>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex min-h-11 w-full cursor-pointer items-center justify-between gap-2 rounded-sm border border-hairline bg-[var(--editor-control)] px-2.5 py-1.5 text-foreground transition-colors hover:bg-foreground/[0.06]"
      >
        {current ? (
          <span className="flex min-w-0 flex-col text-left">
            <span className="truncate text-xs">
              v{current.versionNumber}
              <span className="text-muted-foreground/70"> · </span>
              <time
                dateTime={new Date(current.createdAt).toISOString()}
                title={formatDateTime(current.createdAt)}
              >
                {formatRelativeTime(current.createdAt)}
              </time>
              <span className="text-muted-foreground/70"> · </span>
              {current.authorName}
            </span>
            <span className="truncate text-[11px] text-muted-foreground leading-snug">
              {historyEmail(current.authorEmail)}
            </span>
          </span>
        ) : (
          <span className="min-w-0 truncate text-xs">Select</span>
        )}
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open ? "rotate-180" : "",
          )}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <ul className="thin-scrollbar absolute top-full left-0 z-30 mt-1 max-h-72 w-full overflow-auto rounded-sm border border-hairline bg-surface p-1 shadow-glass">
          {snapshots.map((snapshot) => {
            const selected = snapshot.id === value;
            return (
              <li key={snapshot.id}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(snapshot.id);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full cursor-pointer items-center justify-between gap-2 rounded-xs px-2.5 py-1.5 text-left transition-colors hover:bg-foreground/[0.06]",
                    selected ? "bg-foreground/[0.06]" : "",
                  )}
                >
                  <span className="flex min-w-0 flex-col">
                    <span
                      className={cn(
                        "truncate text-xs",
                        selected ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      v{snapshot.versionNumber}
                      <span className="text-muted-foreground/70"> · </span>
                      <time
                        dateTime={new Date(snapshot.createdAt).toISOString()}
                        title={formatDateTime(snapshot.createdAt)}
                      >
                        {formatRelativeTime(snapshot.createdAt)}
                      </time>
                      <span className="text-muted-foreground/70"> · </span>
                      {snapshot.authorName}
                    </span>
                    <span className="truncate text-[11px] text-muted-foreground leading-snug">
                      {historyEmail(snapshot.authorEmail)}
                    </span>
                  </span>
                  {selected ? (
                    <Check className="size-3.5 shrink-0 text-foreground" aria-hidden="true" />
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function LoadingPane({ label }: { label: string }) {
  return <DataLoader label={label} className="h-full" />;
}

export function VersionHistoryModal({
  documentId,
  fileNode,
  nodes,
  currentContent,
  language,
  canCheckpoint,
  canManage,
  onClose,
  onRestored,
}: VersionHistoryModalProps) {
  const docId = documentId as Id<"documents">;
  const isSheet = fileNode.fileType === "sheet";
  const isBoard = fileNode.fileType === "board";
  const isView = fileNode.fileType === "view";
  const isStructured = isSheet || isBoard || isView;
  const snapshots = useQuery(api.collab.listHistory, { documentId: docId });
  const createCheckpoint = useMutation(api.collab.createHistoryCheckpoint);
  const restoreHistory = useMutation(api.collab.restoreHistory);
  const deleteCheckpoint = useMutation(api.collab.deleteHistoryCheckpoint);

  const [tab, setTab] = useState<MainTab>("file");
  const [fileMode, setFileMode] = useState<FileMode>("preview");
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(null);
  const [baseId, setBaseId] = useState<string | null>(null);
  const [compareId, setCompareId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useDialogA11y({
    open: true,
    onClose,
    containerRef: panelRef,
    initialFocusRef: closeRef,
  });

  const selected =
    snapshots?.find((snapshot) => snapshot.id === selectedSnapshotId)?.id ??
    snapshots?.[0]?.id ??
    null;
  const selectedSnapshot = snapshots?.find((snapshot) => snapshot.id === selected) ?? null;
  const effectiveCompareId = compareId ?? snapshots?.[0]?.id ?? null;
  const effectiveBaseId = baseId ?? snapshots?.[1]?.id ?? snapshots?.[0]?.id ?? null;
  const totalHistoryBytes = (snapshots ?? []).reduce(
    (sum, snapshot) => sum + snapshot.sizeBytes,
    0,
  );

  const preview = useQuery(
    api.collab.getHistoryPreview,
    selected ? { snapshotId: selected as Id<"yjsSnapshots"> } : "skip",
  );
  const basePreview = useQuery(
    api.collab.getHistoryPreview,
    effectiveBaseId ? { snapshotId: effectiveBaseId as Id<"yjsSnapshots"> } : "skip",
  );
  const comparePreview = useQuery(
    api.collab.getHistoryPreview,
    effectiveCompareId ? { snapshotId: effectiveCompareId as Id<"yjsSnapshots"> } : "skip",
  );

  const createSelectedCheckpoint = async () => {
    if (!canCheckpoint || creating) {
      return;
    }
    setCreating(true);
    try {
      const result = await createCheckpoint({ documentId: docId });
      if (result.created) {
        notify.success("Checkpoint created", { description: "Saved to version history." });
      } else {
        notify.info("No new changes", { description: "This version is already checkpointed." });
      }
    } catch (error) {
      notify.error("Checkpoint failed", { description: mapDocError(error) });
    } finally {
      setCreating(false);
    }
  };

  const restoreSelected = async () => {
    if (!canManage || !selected || !selectedSnapshot || restoring) {
      return;
    }
    setRestoring(true);
    try {
      await restoreHistory({ snapshotId: selected as Id<"yjsSnapshots"> });
      notify.success("Version restored", {
        description: `Checkpoint ${selectedSnapshot.versionNumber} is now the live version.`,
      });
      onRestored(documentId);
    } catch (error) {
      notify.error("Restore failed", { description: mapDocError(error) });
    } finally {
      setRestoring(false);
    }
  };

  const removeCheckpoint = async (snapshotId: string, versionNumber: number) => {
    if (deletingId) {
      return;
    }
    setDeletingId(snapshotId);
    try {
      await deleteCheckpoint({ snapshotId: snapshotId as Id<"yjsSnapshots"> });
      if (selectedSnapshotId === snapshotId) {
        setSelectedSnapshotId(null);
      }
      setBaseId((value) => (value === snapshotId ? null : value));
      setCompareId((value) => (value === snapshotId ? null : value));
      notify.success("Checkpoint deleted", {
        description: `Checkpoint ${versionNumber} was removed from history.`,
      });
    } catch (error) {
      notify.error("Delete failed", { description: mapDocError(error) });
    } finally {
      setDeletingId(null);
    }
  };

  const overlay = (
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Version history"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="glass-strong relative flex h-[92dvh] w-full max-w-[1400px] flex-col overflow-hidden rounded-t-lg border border-hairline shadow-[var(--shadow-glass)] sm:rounded-lg"
      >
        <div className="flex h-5 shrink-0 items-center justify-center sm:hidden" aria-hidden="true">
          <span className="h-1 w-10 rounded-full bg-foreground/20" />
        </div>
        <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-hairline border-b pr-2 pl-3">
          <div className="flex min-w-0 items-center gap-2">
            <History className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="flex min-w-0 flex-col">
              <span className="truncate font-medium font-mono text-[10px] text-muted-foreground uppercase leading-tight tracking-widest">
                Version history
              </span>
              <span className="truncate text-[11px] text-foreground leading-tight">
                {fileNode.name}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={createSelectedCheckpoint}
              disabled={!canCheckpoint || creating}
              className={PRIMARY_BUTTON}
            >
              {creating ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Plus className="size-4" aria-hidden="true" />
              )}
              Checkpoint
            </button>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label="Close history"
              className="flex size-9 cursor-pointer items-center justify-center rounded-xs text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive sm:size-7"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
        </div>

        {snapshots === undefined ? (
          <LoadingPane label="Loading history..." />
        ) : snapshots.length === 0 ? (
          <DataState
            title="No versions yet"
            description={
              canCheckpoint
                ? "Create a checkpoint to preserve the current version. You can preview, compare, and restore it anytime."
                : "Checkpoints saved for this file will appear here."
            }
            icon={<Clock3 className="size-5" aria-hidden="true" />}
            className="m-4 flex-1"
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            <aside className="flex max-h-44 w-full shrink-0 flex-col border-hairline border-b md:max-h-none md:w-72 md:border-r md:border-b-0">
              <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-hairline border-b px-3">
                <span className="font-medium font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
                  {snapshots.length} version{snapshots.length === 1 ? "" : "s"}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground/80 tabular-nums">
                  {formatBytes(totalHistoryBytes)}
                </span>
              </div>
              <ul className="thin-scrollbar min-h-0 flex-1 space-y-1.5 overflow-auto p-2">
                {snapshots.map((snapshot) => (
                  <li key={snapshot.id} className="group/row relative">
                    <button
                      type="button"
                      onClick={() => setSelectedSnapshotId(snapshot.id)}
                      className={cn(
                        "flex w-full cursor-pointer items-center gap-2.5 rounded-md py-1.5 pl-2.5 text-left transition-colors",
                        canManage ? "pr-9" : "pr-2.5",
                        selected === snapshot.id
                          ? "bg-foreground/[0.09] text-foreground"
                          : "bg-foreground/[0.035] text-muted-foreground hover:bg-foreground/[0.065] hover:text-foreground",
                      )}
                    >
                      <span
                        className={cn(
                          "flex size-6 shrink-0 items-center justify-center rounded-full font-medium font-mono text-[10px]",
                          selected === snapshot.id
                            ? "bg-foreground text-background"
                            : "bg-foreground/10 text-muted-foreground",
                        )}
                      >
                        v{snapshot.versionNumber}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-xs">
                          Checkpoint {snapshot.versionNumber}
                        </span>
                        <span className="block truncate text-[11px] text-muted-foreground leading-snug">
                          {snapshot.authorName}
                          <span className="text-muted-foreground/70"> · </span>
                          <time
                            dateTime={new Date(snapshot.createdAt).toISOString()}
                            title={formatDateTime(snapshot.createdAt)}
                          >
                            {formatRelativeTime(snapshot.createdAt)}
                          </time>
                        </span>
                      </span>
                    </button>
                    {canManage ? (
                      <button
                        type="button"
                        onClick={() => removeCheckpoint(snapshot.id, snapshot.versionNumber)}
                        disabled={deletingId === snapshot.id}
                        aria-label={`Delete checkpoint ${snapshot.versionNumber}`}
                        title="Delete checkpoint"
                        className="absolute top-1/2 right-1.5 flex size-9 -translate-y-1/2 cursor-pointer items-center justify-center rounded-sm text-muted-foreground opacity-100 transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 disabled:cursor-not-allowed disabled:opacity-60 md:size-7 md:opacity-0 md:group-hover/row:opacity-100"
                      >
                        {deletingId === snapshot.id ? (
                          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                        ) : (
                          <Trash2 className="size-3.5" aria-hidden="true" />
                        )}
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </aside>

            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-2 border-hairline border-b px-2 py-1.5">
                <div
                  className={cn(
                    "grid min-w-0 flex-1 gap-0.5 rounded-sm border border-hairline p-0.5 sm:flex-none",
                    isStructured ? "grid-cols-2" : "grid-cols-3",
                  )}
                >
                  <TabButton active={tab === "file"} label="File" onClick={() => setTab("file")} />
                  {!isStructured ? (
                    <TabButton
                      active={tab === "diff"}
                      label="Diff → current"
                      onClick={() => setTab("diff")}
                    />
                  ) : null}
                  <TabButton
                    active={tab === "compare"}
                    label="Compare"
                    onClick={() => setTab("compare")}
                  />
                </div>
                {tab === "file" && !isStructured ? (
                  <div className="flex items-center gap-0.5 rounded-sm border border-hairline p-0.5">
                    {(
                      [
                        ["preview", Eye, "Preview"],
                        ["source", Code2, "Source"],
                      ] as const
                    ).map(([mode, Icon, modeLabel]) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setFileMode(mode)}
                        aria-label={modeLabel}
                        className={cn(
                          "flex size-7 cursor-pointer items-center justify-center rounded-xs transition-colors",
                          fileMode === mode
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

              {tab === "compare" ? (
                <div className="flex shrink-0 flex-col items-stretch gap-3 border-hairline border-b px-3 py-2.5 sm:flex-row sm:items-end">
                  <VersionSelect
                    label="Base"
                    value={effectiveBaseId}
                    snapshots={snapshots}
                    onChange={setBaseId}
                  />
                  <VersionSelect
                    label="Compare"
                    value={effectiveCompareId}
                    snapshots={snapshots}
                    onChange={setCompareId}
                  />
                </div>
              ) : null}

              <div className="relative min-h-0 flex-1">
                {tab === "file" ? (
                  preview ? (
                    isSheet && preview.sheetPreview ? (
                      <SheetTable model={preview.sheetPreview} className="size-full p-3" />
                    ) : isBoard && preview.boardPreview ? (
                      <BoardView model={preview.boardPreview} className="size-full" />
                    ) : isView && preview.viewPreview ? (
                      <ViewPreview
                        model={{ config: preview.viewPreview, properties: [], records: [] }}
                        className="size-full"
                      />
                    ) : fileMode === "preview" ? (
                      <DocPreview fileNode={fileNode} content={preview.content} nodes={nodes} />
                    ) : (
                      <DocEditor
                        key={`source:${selected}`}
                        initialContent={preview.content}
                        language={language}
                        readOnly
                        onChange={noop}
                      />
                    )
                  ) : (
                    <LoadingPane label="Loading version..." />
                  )
                ) : null}

                {tab === "diff" && !isStructured ? (
                  preview ? (
                    <div className="flex size-full flex-col">
                      <div className="min-h-0 flex-1">
                        <DiffView
                          original={preview.content}
                          modified={currentContent}
                          language={language}
                        />
                      </div>
                    </div>
                  ) : (
                    <LoadingPane label="Loading diff..." />
                  )
                ) : null}

                {tab === "compare" ? (
                  basePreview && comparePreview ? (
                    <div className="flex size-full flex-col">
                      <div className="min-h-0 flex-1">
                        {isSheet && basePreview.sheetPreview && comparePreview.sheetPreview ? (
                          <div className="grid size-full min-h-0 grid-cols-1 gap-3 overflow-auto p-3 lg:grid-cols-2">
                            <SheetTable
                              model={basePreview.sheetPreview}
                              className="min-h-0 rounded-md border border-hairline"
                            />
                            <SheetTable
                              model={comparePreview.sheetPreview}
                              className="min-h-0 rounded-md border border-hairline"
                            />
                          </div>
                        ) : isBoard && basePreview.boardPreview && comparePreview.boardPreview ? (
                          <div className="grid size-full min-h-0 grid-cols-1 gap-3 overflow-auto p-3 lg:grid-cols-2">
                            <BoardView
                              model={basePreview.boardPreview}
                              className="min-h-0 rounded-md border border-hairline"
                            />
                            <BoardView
                              model={comparePreview.boardPreview}
                              className="min-h-0 rounded-md border border-hairline"
                            />
                          </div>
                        ) : isView && basePreview.viewPreview && comparePreview.viewPreview ? (
                          <div className="grid size-full min-h-0 grid-cols-1 gap-3 overflow-auto p-3 lg:grid-cols-2">
                            <ViewPreview
                              model={{
                                config: basePreview.viewPreview,
                                properties: [],
                                records: [],
                              }}
                              className="min-h-0 rounded-md border border-hairline"
                            />
                            <ViewPreview
                              model={{
                                config: comparePreview.viewPreview,
                                properties: [],
                                records: [],
                              }}
                              className="min-h-0 rounded-md border border-hairline"
                            />
                          </div>
                        ) : (
                          <DiffView
                            original={basePreview.content}
                            modified={comparePreview.content}
                            language={language}
                          />
                        )}
                      </div>
                    </div>
                  ) : (
                    <LoadingPane label="Loading diff..." />
                  )
                ) : null}
              </div>

              <div className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-2 border-hairline border-t px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                  {selectedSnapshot ? (
                    <>
                      Checkpoint {selectedSnapshot.versionNumber}
                      <span className="text-muted-foreground/70"> · </span>
                      {selectedSnapshot.authorName}
                      <span className="text-muted-foreground/70"> · </span>
                      {historyEmail(selectedSnapshot.authorEmail)}
                    </>
                  ) : null}
                </span>
                {canManage ? null : (
                  <span className="shrink-0 text-[11px] text-muted-foreground/80">
                    Only admins can restore
                  </span>
                )}
                <button
                  type="button"
                  onClick={restoreSelected}
                  disabled={!canManage || !selected || !selectedSnapshot || restoring}
                  className={PRIMARY_BUTTON}
                >
                  {restoring ? (
                    <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <RotateCcw className="size-4" aria-hidden="true" />
                  )}
                  Restore
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}
