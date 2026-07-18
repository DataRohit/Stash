"use client";

import { FolderTree, Menu } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { AttachmentViewer } from "@/app/dashboard/projects/[id]/editor/attachment-viewer";
import type { TreeNode } from "@/app/dashboard/projects/[id]/editor/tree-utils";
import { SharedDocumentContent } from "@/app/share/[token]/shared-document-view";

type Result = {
  mode: "private" | "org" | "public";
  projectTitle: string;
  nodes: Array<{
    id: string;
    parentId: string | null;
    kind: "folder" | "file" | "asset";
    name: string;
    fileType: TreeNode["fileType"];
    size: number;
    mimeType: string | null;
    assetUrl: string | null;
  }>;
  nextCursor: string | null;
  document: null | {
    id: string;
    kind: "file" | "asset";
    name: string;
    fileType: TreeNode["fileType"];
    content: string;
    updatedAt: number;
    mimeType: string | null;
    size: number;
    assetUrl: string | null;
    sheetPreview?: Parameters<typeof SharedDocumentContent>[0]["shared"]["sheetPreview"];
    boardPreview?: Parameters<typeof SharedDocumentContent>[0]["shared"]["boardPreview"];
    viewPreview?: Parameters<typeof SharedDocumentContent>[0]["shared"]["viewPreview"];
    chartPreview?: Parameters<typeof SharedDocumentContent>[0]["shared"]["chartPreview"];
    dashboardPreview?: Parameters<typeof SharedDocumentContent>[0]["shared"]["dashboardPreview"];
  };
};

export function ProjectSharedView({ token, result }: { token: string; result: Result }) {
  const [allNodes, setAllNodes] = useState(result.nodes);
  const [nextCursor, setNextCursor] = useState(result.nextCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const byId = new Map(allNodes.map((node) => [node.id, node]));
  const pathOf = (node: (typeof allNodes)[number]) => {
    const parts = [node.name];
    let current = node.parentId ? byId.get(node.parentId) : undefined;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      parts.unshift(current.name);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return parts.join("/");
  };
  const files = allNodes
    .filter((node) => node.kind !== "folder")
    .sort((left, right) => pathOf(left).localeCompare(pathOf(right)));
  const depthOf = (node: (typeof allNodes)[number]) => {
    let depth = 0;
    let current = node.parentId ? byId.get(node.parentId) : undefined;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      depth += 1;
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return depth;
  };
  const tree = (
    <nav aria-label="Shared project files" className="thin-scrollbar h-full overflow-y-auto p-3">
      <div className="mb-3 flex items-center gap-2 px-2">
        <FolderTree className="size-4 text-muted-foreground" aria-hidden="true" />
        <span className="truncate font-medium text-sm">{result.projectTitle}</span>
      </div>
      <ul className="space-y-1">
        {files.map((file) => (
          <li key={file.id}>
            <Link
              href={`/share/project/${token}?document=${file.id}`}
              aria-current={result.document?.id === file.id ? "page" : undefined}
              style={{ paddingLeft: `${Math.min(5, depthOf(file)) * 12 + 8}px` }}
              className="flex min-h-11 items-center rounded-sm pr-2 text-muted-foreground text-sm transition-colors hover:bg-foreground/[0.05] hover:text-foreground aria-[current=page]:bg-foreground/[0.08] aria-[current=page]:text-foreground"
            >
              <span className="truncate">{file.name}</span>
            </Link>
          </li>
        ))}
      </ul>
      {nextCursor ? (
        <button
          type="button"
          disabled={loadingMore}
          onClick={async () => {
            setLoadingMore(true);
            try {
              const response = await fetch(
                `/api/shares/project/${token}/tree?cursor=${encodeURIComponent(nextCursor)}&document=${encodeURIComponent(result.document?.id ?? "")}`,
              );
              if (!response.ok) return;
              const page = (await response.json()) as {
                nodes: Result["nodes"];
                nextCursor: string | null;
              };
              setAllNodes((nodes) => [
                ...nodes,
                ...page.nodes.filter((node) => !nodes.some((current) => current.id === node.id)),
              ]);
              setNextCursor(page.nextCursor);
            } finally {
              setLoadingMore(false);
            }
          }}
          className="mt-3 flex min-h-11 w-full cursor-pointer items-center justify-center rounded-sm border border-hairline text-xs hover:bg-foreground/[0.04] disabled:opacity-50"
        >
          {loadingMore ? "Loading…" : "Load more files"}
        </button>
      ) : null}
    </nav>
  );
  if (!result.document)
    return <main className="p-6 text-center">This project has no shared documents.</main>;
  const nodes = allNodes as TreeNode[];
  return (
    <div className="grid h-dvh grid-cols-1 overflow-hidden lg:grid-cols-[280px_1fr]">
      <aside className="hidden border-hairline border-r bg-surface lg:block">{tree}</aside>
      <div className="min-h-0 overflow-hidden">
        <details className="glass mx-3 mt-3 rounded-lg lg:hidden">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-sm">
            <Menu className="size-4" aria-hidden="true" /> Browse files
          </summary>
          <div className="max-h-72 border-hairline border-t">{tree}</div>
        </details>
        {result.document.kind === "asset" && result.document.assetUrl ? (
          <main className="flex h-full items-center justify-center overflow-auto p-4">
            <AttachmentViewer
              node={{
                id: result.document.id,
                parentId: null,
                kind: "asset",
                name: result.document.name,
                fileType: null,
                size: result.document.size,
                mimeType: result.document.mimeType,
                assetUrl: result.document.assetUrl,
              }}
              url={result.document.assetUrl}
            />
          </main>
        ) : (
          <SharedDocumentContent
            shared={{
              mode: result.mode === "public" ? "public" : "org",
              projectTitle: result.projectTitle,
              documentId: result.document.id,
              documentName: result.document.name,
              fileType: result.document.fileType,
              content: result.document.content,
              updatedAt: result.document.updatedAt,
              nodes,
              fileLinks: files.map((file) => ({
                documentId: file.id,
                href: `/share/project/${token}?document=${file.id}`,
              })),
              sheetPreview: result.document.sheetPreview,
              boardPreview: result.document.boardPreview,
              viewPreview: result.document.viewPreview,
              chartPreview: result.document.chartPreview,
              dashboardPreview: result.document.dashboardPreview,
            }}
          />
        )}
      </div>
      <footer className="fixed right-4 bottom-2 z-20 rounded-sm bg-surface/85 px-2 py-1 font-mono text-[9px] text-muted-foreground uppercase tracking-wider backdrop-blur">
        Shared via Stash
      </footer>
    </div>
  );
}
