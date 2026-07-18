import { isIP } from "node:net";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { SharedEmptyState } from "@/app/share/[token]/shared-empty-state";
import { fetchSharedProject } from "@/lib/convex-server";
import { ProjectSharedView } from "./project-shared-view";

export const metadata: Metadata = {
  title: "Shared project",
  robots: { index: false, follow: false },
};

function clientIp(headersList: Headers): string {
  const direct = headersList.get("x-real-ip")?.trim();
  if (direct && isIP(direct)) return direct.slice(0, 128);
  if (process.env.SHARE_TRUST_FORWARDED === "1") {
    const forwarded = headersList.get("x-forwarded-for")?.split(",", 1)[0]?.trim();
    if (forwarded && isIP(forwarded)) return forwarded.slice(0, 128);
  }
  return "unknown";
}

export default async function SharedProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ document?: string; cursor?: string }>;
}) {
  const [{ token }, search, headerList] = await Promise.all([params, searchParams, headers()]);
  const result = await fetchSharedProject(
    token,
    search.document,
    search.cursor,
    clientIp(headerList),
  );
  if (!result)
    return (
      <SharedEmptyState
        title="Share link unavailable"
        body="This project is private, revoked, deleted, or the link is invalid."
      />
    );
  if (result.status === "expired")
    return (
      <SharedEmptyState title="Link expired" body="Ask the project owner for an updated link." />
    );
  if (result.status === "rate-limited")
    return <SharedEmptyState title="Too many requests" body="Wait a minute and try again." />;
  if (result.status === "auth-required")
    return (
      <SharedEmptyState
        title="Organization sign-in required"
        body="This project is shared with organization members only."
        action={
          <Link
            href="/sign-in"
            className="inline-flex h-11 items-center rounded-sm bg-foreground px-4 text-background"
          >
            Sign in
          </Link>
        }
      />
    );
  if (result.status === "forbidden")
    return (
      <SharedEmptyState
        title="No access"
        body="Your active organization does not have access to this project."
      />
    );
  if (result.status !== "ok")
    return (
      <SharedEmptyState
        title="Share unavailable"
        body="This shared project could not be loaded. Please try again later."
      />
    );
  const localAssetUrl = (documentId: string) => `/api/shares/project/${token}/assets/${documentId}`;
  return (
    <ProjectSharedView
      token={token}
      result={{
        ...result,
        nodes: result.nodes.map((node) => ({
          ...node,
          assetUrl: node.kind === "asset" ? localAssetUrl(node.id) : node.assetUrl,
        })),
        document:
          result.document?.kind === "asset"
            ? { ...result.document, assetUrl: localAssetUrl(result.document.id) }
            : result.document,
      }}
    />
  );
}
