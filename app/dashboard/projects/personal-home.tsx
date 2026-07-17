"use client";

import { useQuery } from "convex/react";
import { AtSign, Clock3, Star } from "lucide-react";
import Link from "next/link";
import { FileIcon } from "@/components/file-icon";
import { DataLoader, DataState } from "@/components/ui/data-state";
import { api } from "@/convex/_generated/api";
import { formatDateTime, formatRelativeTime } from "@/lib/format";

function Heading({ icon: Icon, children }: { icon: typeof Star; children: string }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
      <h2 className="font-mono text-muted-foreground text-xs uppercase tracking-widest">
        {children}
      </h2>
    </div>
  );
}

export function PersonalHome({ clerkOrgId }: { clerkOrgId: string }) {
  const favorites = useQuery(api.navigation.listFavorites, { clerkOrgId });
  const recent = useQuery(api.navigation.listRecent, { clerkOrgId });
  const notifications = useQuery(api.comments.listMine);
  const mentions = notifications?.filter(
    (item) => item.kind === "mention" && item.threadStatus === "open",
  );
  return (
    <section className="mb-8 flex flex-col gap-6" aria-label="My work">
      <div>
        <Heading icon={Star}>Favorites</Heading>
        {favorites === undefined ? (
          <DataLoader label="Loading favorites" compact />
        ) : favorites.length === 0 ? (
          <DataState
            title="No favorites yet"
            description="Star a project or document and it will appear here."
            compact
          />
        ) : (
          <div className="flex snap-x gap-3 overflow-x-auto pb-2 md:grid md:grid-cols-4 md:overflow-visible">
            {favorites.map((item) => (
              <Link
                key={item.id}
                href={
                  item.documentId
                    ? `/dashboard/projects/${item.projectId}/editor?file=${item.documentId}`
                    : `/dashboard/projects/${item.projectId}`
                }
                className={`min-w-56 snap-start rounded-md border border-hairline bg-surface/35 p-3 transition-colors hover:bg-foreground/[0.04] md:min-w-0 ${item.trashed ? "opacity-60" : ""}`}
              >
                <div className="flex items-center gap-2">
                  {item.kind === "project" ? (
                    <Star className="size-4 fill-signal text-signal" aria-hidden="true" />
                  ) : (
                    <FileIcon kind={item.kind} fileType={item.fileType} />
                  )}
                  <span className="truncate font-medium text-sm">{item.name}</span>
                </div>
                <p className="mt-2 truncate text-muted-foreground text-xs">
                  {item.projectTitle} · {item.path}
                </p>
                {item.trashed ? (
                  <p className="mt-1 text-warning text-xs">In trash · restore it to open</p>
                ) : null}
              </Link>
            ))}
          </div>
        )}
      </div>
      <div>
        <Heading icon={Clock3}>Recent</Heading>
        {recent === undefined ? (
          <DataLoader label="Loading recent documents" compact />
        ) : recent.length === 0 ? (
          <DataState
            title="No recent documents"
            description="Documents you open will appear here for quick access."
            compact
          />
        ) : (
          <div className="flex snap-x gap-3 overflow-x-auto pb-2 md:grid md:grid-cols-4 md:overflow-visible">
            {recent.map((item) => (
              <Link
                key={item.id}
                href={`/dashboard/projects/${item.projectId}/editor?file=${item.documentId}`}
                className="min-w-56 snap-start rounded-md border border-hairline bg-surface/35 p-3 transition-colors hover:bg-foreground/[0.04] md:min-w-0"
              >
                <div className="flex items-center gap-2">
                  <FileIcon kind={item.kind} fileType={item.fileType} />
                  <span className="truncate font-medium text-sm">{item.name}</span>
                </div>
                <p className="mt-2 truncate text-muted-foreground text-xs">
                  {item.projectTitle} · {item.path}
                </p>
                <time
                  dateTime={new Date(item.lastOpenedAt).toISOString()}
                  title={formatDateTime(item.lastOpenedAt)}
                  className="mt-1 block font-mono text-[10px] text-muted-foreground/70"
                >
                  {formatRelativeTime(item.lastOpenedAt)}
                </time>
              </Link>
            ))}
          </div>
        )}
      </div>
      <div>
        <Heading icon={AtSign}>Open mentions</Heading>
        {mentions === undefined ? (
          <DataLoader label="Loading open mentions" compact />
        ) : mentions.length === 0 ? (
          <DataState
            title="No open mentions"
            description="Unresolved comment threads that mention you will appear here."
            compact
          />
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {mentions.slice(0, 8).map((item) => (
              <Link
                key={item.id}
                href={`/dashboard/projects/${item.projectId}/editor?file=${item.documentId}&thread=${item.commentId}`}
                className="rounded-md border border-hairline bg-surface/35 p-3 transition-colors hover:bg-foreground/[0.04]"
              >
                <p className="truncate font-medium text-sm">{item.actorName} mentioned you</p>
                <p className="mt-1 truncate text-muted-foreground text-xs">
                  {item.projectTitle} / {item.documentName}
                </p>
                <p className="mt-2 line-clamp-2 text-sm">{item.bodySnippet}</p>
              </Link>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
