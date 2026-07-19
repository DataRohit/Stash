"use client";

import { FileText, Globe2 } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { StaticDocPreview } from "@/app/dashboard/projects/[id]/editor/doc-preview";
import { missingRefToast } from "@/app/dashboard/projects/[id]/editor/lib/doc-html";
import type { TreeNode } from "@/app/dashboard/projects/[id]/editor/tree-utils";
import { BoardView } from "@/components/board-view";
import { ChartView } from "@/components/chart-view";
import { SheetTable } from "@/components/sheet-table";
import { notify } from "@/components/ui/toast";
import { ViewPreview, type ViewPreviewModel } from "@/components/view-preview";
import type { ChartData } from "@/lib/chart-data";
import type { DashboardTile } from "@/lib/dashboard-model";
import type { BoardRenderModel, SheetRenderModel } from "@/lib/doc-projection";
import type { FileType } from "@/lib/document-types";
import { formatDateTime, formatRelativeTime } from "@/lib/format";

export type SharedDocument = {
  mode: "org" | "public";
  projectTitle: string;
  documentId: string;
  documentName: string;
  fileType: FileType | null;
  content: string;
  sheetPreview?: SheetRenderModel;
  boardPreview?: BoardRenderModel;
  viewPreview?: ViewPreviewModel;
  chartPreview?: ChartData;
  dashboardPreview?: Array<{
    tile: DashboardTile;
    status: "ok" | "missing";
    chart?: ChartData;
    value?: number;
    truncated?: boolean;
  }>;
  updatedAt: number;
  nodes: TreeNode[];
  fileLinks: { documentId: string; href: string }[];
};

export function SharedDocumentContent({ shared }: { shared: SharedDocument }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const fileLinkById = useMemo(
    () => Object.fromEntries(shared.fileLinks.map((row) => [row.documentId, row.href])),
    [shared.fileLinks],
  );
  const nodes = shared.nodes;
  const fileNode = nodes.find((node) => node.id === shared.documentId);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) {
        return;
      }
      if (event.data?.type === "stash-missing-ref") {
        const toast = missingRefToast(event.data.ref);
        notify.error(toast.title, { description: toast.description });
      }
      if (event.data?.type === "stash-open-doc") {
        notify.info("File not shared", {
          description: "The linked file exists in this project but is not part of this share link.",
        });
      }
      if (event.data?.type === "stash-open-shared-doc") {
        const href = fileLinkById[String(event.data.id)];
        if (href) {
          window.location.assign(href);
        }
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [fileLinkById]);

  return (
    <main className="flex h-dvh flex-col gap-3 px-3 py-3 sm:px-6 sm:py-4">
      <header className="glass flex h-14 shrink-0 items-center justify-between gap-3 rounded-lg px-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-sm border border-hairline bg-foreground text-background">
            <FileText className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate font-medium text-sm">{shared.documentName}</h1>
            <p className="truncate text-muted-foreground text-xs">
              {shared.projectTitle} / Updated{" "}
              <time
                dateTime={new Date(shared.updatedAt).toISOString()}
                title={formatDateTime(shared.updatedAt)}
                suppressHydrationWarning
              >
                {formatRelativeTime(shared.updatedAt)}
              </time>
            </p>
          </div>
        </div>
        <span className="hidden shrink-0 items-center gap-1.5 rounded-sm border border-hairline bg-foreground/[0.04] px-2.5 py-1 font-mono text-[10px] text-muted-foreground uppercase tracking-widest sm:inline-flex">
          <Globe2 className="size-3" aria-hidden="true" />
          {shared.mode === "public" ? "Public" : "Org"}
        </span>
      </header>
      <section className="editor-surface min-h-0 flex-1 overflow-hidden rounded-lg">
        {shared.fileType === "sheet" && shared.sheetPreview ? (
          <SheetTable model={shared.sheetPreview} className="h-full bg-background p-3" />
        ) : shared.fileType === "board" && shared.boardPreview ? (
          <BoardView model={shared.boardPreview} className="h-full bg-background" />
        ) : shared.fileType === "view" && shared.viewPreview ? (
          <ViewPreview model={shared.viewPreview} className="h-full" />
        ) : shared.fileType === "chart" && shared.chartPreview ? (
          <ChartView model={shared.chartPreview} className="h-full" />
        ) : shared.fileType === "dashboard" && shared.dashboardPreview ? (
          <div className="thin-scrollbar grid h-full grid-cols-1 gap-4 overflow-y-auto bg-background p-4 lg:grid-cols-2">
            {shared.dashboardPreview.map(({ tile, status, chart, value, truncated }) => (
              <article
                key={tile.id}
                className={`overflow-hidden rounded-lg border border-hairline bg-surface ${tile.width === 2 ? "lg:col-span-2" : ""}`}
              >
                <h2 className="border-hairline border-b px-3 py-2 font-medium text-sm">
                  {tile.title}
                </h2>
                {status === "missing" ? (
                  <p className="p-8 text-center text-muted-foreground text-sm">
                    This tile or its source is not shared.
                  </p>
                ) : chart ? (
                  <ChartView model={chart} />
                ) : (
                  <div className="flex min-h-36 flex-col items-center justify-center gap-2">
                    <strong className="font-mono text-4xl">{(value ?? 0).toLocaleString()}</strong>
                    <span className="text-muted-foreground text-xs uppercase tracking-widest">
                      {tile.aggregate === "sum" ? "Total" : "Records"}
                      {truncated ? " · sampled" : ""}
                    </span>
                  </div>
                )}
              </article>
            ))}
          </div>
        ) : fileNode ? (
          <StaticDocPreview
            fileNode={fileNode}
            content={shared.content}
            nodes={nodes}
            iframeRef={frameRef}
            fileLinkById={fileLinkById}
            allowActiveContent={false}
          />
        ) : null}
      </section>
    </main>
  );
}
