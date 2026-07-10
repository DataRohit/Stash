"use client";

import { useQuery } from "convex/react";
import { FileText, Globe2, Loader2, LockKeyhole } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef } from "react";
import { DocPreview } from "@/app/dashboard/projects/[id]/editor/doc-preview";
import { missingRefToast } from "@/app/dashboard/projects/[id]/editor/lib/doc-html";
import { RichDocPreview } from "@/app/dashboard/projects/[id]/editor/rich-doc-preview";
import type { TreeNode } from "@/app/dashboard/projects/[id]/editor/tree-utils";
import { notify } from "@/components/ui/toast";
import { api } from "@/convex/_generated/api";

type SharedDocumentViewProps = {
  token: string;
};

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-12">
      <section className="glass flex w-full max-w-md flex-col items-center gap-3 rounded-lg p-6 text-center">
        <LockKeyhole className="size-5 text-muted-foreground" aria-hidden="true" />
        <h1 className="font-serif text-2xl tracking-display">{title}</h1>
        <p className="text-muted-foreground text-sm leading-relaxed">{body}</p>
        {action ? <div className="pt-1">{action}</div> : null}
      </section>
    </main>
  );
}

export function SharedDocumentView({ token }: SharedDocumentViewProps) {
  const shared = useQuery(api.sharing.getSharedDocument, { token });
  const fileLinkById = useMemo(() => {
    if (shared?.status !== "ok") {
      return {};
    }
    return Object.fromEntries(shared.fileLinks.map((row) => [row.documentId, row.href]));
  }, [shared]);
  const frameRef = useRef<HTMLIFrameElement>(null);

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

  if (shared === undefined) {
    return (
      <main className="flex min-h-dvh items-center justify-center gap-2 text-muted-foreground text-sm">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        Loading shared document
      </main>
    );
  }

  if (shared === null) {
    return (
      <EmptyState
        title="Share link unavailable"
        body="This document is private, revoked, deleted, or the link is invalid."
      />
    );
  }

  if (shared.status === "auth-required") {
    return (
      <EmptyState
        title="Organization sign-in required"
        body="This document is shared with organization members only."
        action={
          <Link
            href="/sign-in"
            className="inline-flex h-9 items-center justify-center rounded-sm bg-foreground px-4 font-medium text-background text-sm transition-colors hover:bg-foreground/90"
          >
            Sign in
          </Link>
        }
      />
    );
  }

  if (shared.status === "forbidden") {
    return (
      <EmptyState
        title="No access"
        body="Your active organization does not have access to this shared document."
      />
    );
  }

  const nodes = shared.nodes as TreeNode[];
  const fileNode = nodes.find((node) => node.id === shared.documentId);
  if (!fileNode) {
    return (
      <EmptyState title="Document unavailable" body="This shared document could not be loaded." />
    );
  }
  const content = shared.content ?? "";
  const updatedAt = shared.updatedAt ?? 0;

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
              {shared.projectTitle} / Updated {formatTime(updatedAt)}
            </p>
          </div>
        </div>
        <span className="hidden shrink-0 items-center gap-1.5 rounded-sm border border-hairline bg-foreground/[0.04] px-2.5 py-1 font-mono text-[10px] text-muted-foreground uppercase tracking-widest sm:inline-flex">
          <Globe2 className="size-3" aria-hidden="true" />
          {shared.mode === "public" ? "Public" : "Org"}
        </span>
      </header>
      <section className="editor-surface min-h-0 flex-1 overflow-hidden rounded-lg">
        {fileNode.fileType === "doc" ? (
          <RichDocPreview contentState={shared.contentState ?? null} fallbackContent={content} />
        ) : (
          <DocPreview
            fileNode={fileNode}
            content={content}
            nodes={nodes}
            iframeRef={frameRef}
            fileLinkById={fileLinkById}
          />
        )}
      </section>
    </main>
  );
}
