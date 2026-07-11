"use client";

import { useQuery } from "convex/react";
import { Clock3, FileText, Image as ImageIcon } from "lucide-react";
import Link from "next/link";
import { api } from "@/convex/_generated/api";

function relative(timestamp: number) {
  const seconds = Math.max(1, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function RecentDocuments({ clerkOrgId }: { clerkOrgId: string }) {
  const recent = useQuery(api.navigation.listRecent, { clerkOrgId });
  if (recent === undefined)
    return (
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        {[0, 1, 2, 3].map((item) => (
          <div key={item} className="h-24 animate-pulse rounded-md bg-foreground/[0.04]" />
        ))}
      </div>
    );
  if (!recent.length) return null;
  return (
    <section className="mb-6">
      <div className="mb-3 flex items-center gap-2">
        <Clock3 className="size-4 text-muted-foreground" />
        <h2 className="font-mono text-muted-foreground text-xs uppercase tracking-widest">
          Recent
        </h2>
      </div>
      <div className="flex snap-x gap-3 overflow-x-auto pb-2 md:grid md:grid-cols-4 md:overflow-visible">
        {recent.map((item) => (
          <Link
            key={item.id}
            href={`/dashboard/projects/${item.projectId}/editor?file=${item.documentId}`}
            className="min-w-56 snap-start rounded-md border border-hairline bg-surface/35 p-3 transition-colors hover:bg-foreground/[0.04] md:min-w-0"
          >
            <div className="flex items-center gap-2">
              {item.kind === "asset" ? (
                <ImageIcon className="size-4 shrink-0 text-info" />
              ) : (
                <FileText className="size-4 shrink-0 text-accent" />
              )}
              <span className="truncate font-medium text-sm">{item.name}</span>
            </div>
            <p className="mt-2 truncate text-muted-foreground text-xs">
              {item.projectTitle} · {item.path}
            </p>
            <p className="mt-1 font-mono text-[10px] text-muted-foreground/70">
              {relative(item.lastOpenedAt)}
            </p>
          </Link>
        ))}
      </div>
    </section>
  );
}
