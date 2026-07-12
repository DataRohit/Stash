import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import type { TreeNode } from "@/app/dashboard/projects/[id]/editor/tree-utils";
import { SharedDocumentContent } from "@/app/share/[token]/shared-document-view";
import { SharedEmptyState } from "@/app/share/[token]/shared-empty-state";
import { fetchSharedDocument } from "@/lib/convex-server";

export const metadata: Metadata = {
  title: "Shared document",
};

function clientIp(headerList: Headers): string {
  const forwarded = headerList.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) {
      return first;
    }
  }
  return headerList.get("x-real-ip")?.trim() || "0.0.0.0";
}

export default async function SharedDocumentPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const headerList = await headers();
  const result = await fetchSharedDocument(token, clientIp(headerList));

  if (!result) {
    return (
      <SharedEmptyState
        title="Share link unavailable"
        body="This document is private, revoked, deleted, or the link is invalid."
      />
    );
  }

  if (result.status === "rate-limited") {
    return (
      <SharedEmptyState
        title="Too many requests"
        body="This link received too many requests in a short time. Wait a minute and try again."
      />
    );
  }

  if (result.status === "expired") {
    return (
      <SharedEmptyState
        title="Link expired"
        body="This share link has expired. Ask the document owner for an updated link."
      />
    );
  }

  if (result.status === "auth-required") {
    return (
      <SharedEmptyState
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

  if (result.status === "forbidden") {
    return (
      <SharedEmptyState
        title="No access"
        body="Your active organization does not have access to this shared document."
      />
    );
  }

  if (result.status !== "ok") {
    return (
      <SharedEmptyState
        title="Share link unavailable"
        body="This shared document could not be loaded. Please try again later."
      />
    );
  }

  return (
    <SharedDocumentContent
      shared={{
        mode: result.mode === "public" ? "public" : "org",
        projectTitle: result.projectTitle,
        documentId: result.documentId,
        documentName: result.documentName,
        fileType: result.fileType,
        content: result.content,
        docHtml: result.docHtml,
        updatedAt: result.updatedAt,
        nodes: result.nodes as TreeNode[],
        fileLinks: result.fileLinks,
      }}
    />
  );
}
