"use client";

import { useQuery } from "convex/react";
import { Clock3 } from "lucide-react";
import Link from "next/link";
import { FileIcon } from "@/components/file-icon";
import { DataSkeleton, DataState } from "@/components/ui/data-state";
import { api } from "@/convex/_generated/api";
import { formatDateTime, formatRelativeTime } from "@/lib/format";

export function RecentDocuments({ clerkOrgId }: { clerkOrgId: string }) {
  const recent = useQuery(api.navigation.listRecent, { clerkOrgId });
  if (recent === undefined)
    return <DataSkeleton label="Loading recent documents" rows={2} compact className="mb-6" />;
  return (
    <section className="mb-6">
      <div className="mb-3 flex items-center gap-2">
        <Clock3 className="size-4 text-muted-foreground" />
        <h2 className="font-mono text-muted-foreground text-xs uppercase tracking-widest">
          Recent
        </h2>
      </div>
      {recent.length === 0 ? (
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
    </section>
  );
}
