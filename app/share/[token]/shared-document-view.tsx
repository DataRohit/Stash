"use client";

import { FileText, Globe2 } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { DocPreview } from "@/app/dashboard/projects/[id]/editor/doc-preview";
import { missingRefToast } from "@/app/dashboard/projects/[id]/editor/lib/doc-html";
import type { TreeNode } from "@/app/dashboard/projects/[id]/editor/tree-utils";
import { notify } from "@/components/ui/toast";
import { formatDateTime, formatRelativeTime } from "@/lib/format";

export type SharedDocument = {
  mode: "org" | "public";
  projectTitle: string;
  documentId: string;
  documentName: string;
  fileType: "md" | "html" | null;
  content: string;
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
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

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
        {fileNode ? (
          <DocPreview
            fileNode={fileNode}
            content={shared.content}
            nodes={nodes}
            iframeRef={frameRef}
            fileLinkById={fileLinkById}
          />
        ) : null}
      </section>
    </main>
  );
}
