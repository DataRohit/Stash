import { isIP } from "node:net";
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

const MAX_IP_LENGTH = 128;
const MAX_FORWARDED_LENGTH = 1024;

function canonicalIp(value: string | null): string | null {
  const candidate = value?.trim();
  if (!candidate || candidate.length > MAX_IP_LENGTH) {
    return null;
  }
  if (isIP(candidate) === 4) {
    return candidate;
  }
  if (isIP(candidate) === 6) {
    const hostname = new URL(`http://[${candidate}]/`).hostname;
    return hostname.slice(1, -1).toLowerCase();
  }
  return null;
}

function firstForwardedIp(value: string | null): string | null {
  if (!value || value.length > MAX_FORWARDED_LENGTH) {
    return null;
  }
  return canonicalIp(value.split(",", 1)[0] ?? null);
}

function clientIp(headerList: Headers): string {
  const realIp = canonicalIp(headerList.get("x-real-ip"));
  if (process.env.SHARE_TRUST_FORWARDED !== "1") {
    return realIp ?? "unknown";
  }
  return (
    firstForwardedIp(headerList.get("x-vercel-forwarded-for")) ??
    firstForwardedIp(headerList.get("x-forwarded-for")) ??
    realIp ??
    "unknown"
  );
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
        sheetPreview: result.sheetPreview,
        boardPreview: result.boardPreview,
        updatedAt: result.updatedAt,
        nodes: result.nodes as TreeNode[],
        fileLinks: result.fileLinks,
      }}
    />
  );
}
