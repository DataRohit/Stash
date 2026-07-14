"use client";

import { Folder } from "lucide-react";
import { useRouter } from "next/navigation";
import { type KeyboardEvent, useEffect, useRef } from "react";
import { FileIcon } from "@/components/file-icon";
import { DataState } from "@/components/ui/data-state";
import { cn } from "@/lib/utils";

export type GlobalResult = {
  id: string;
  projectId: string;
  projectTitle: string;
  documentId: string | null;
  kind: "project" | "file" | "folder" | "asset" | "content";
  name: string;
  path: string;
  fileType: "md" | "html" | null;
  snippet: { before: string; match: string; after: string; lineNumber: number } | null;
};

export function resultHref(result: GlobalResult): string {
  if (!result.documentId || result.kind === "folder") {
    return `/dashboard/projects/${result.projectId}${result.kind === "folder" ? "/editor" : ""}`;
  }
  return `/dashboard/projects/${result.projectId}/editor?file=${result.documentId}`;
}

function ResultIcon({ result }: { result: GlobalResult }) {
  if (result.kind === "project") {
    return <Folder className="size-4 text-info" />;
  }
  if (result.kind === "folder") {
    return <FileIcon kind="folder" />;
  }
  if (result.kind === "asset") {
    return <FileIcon kind="asset" />;
  }
  return <FileIcon kind="file" fileType={result.fileType} />;
}

export function SearchResults({
  results,
  active,
  onActive,
  onChoose,
  orgName,
  emptyText = "No matches found.",
}: {
  results: GlobalResult[];
  active: number;
  onActive: (index: number) => void;
  onChoose?: (result: GlobalResult) => void;
  orgName?: string;
  emptyText?: string;
}) {
  const router = useRouter();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    refs.current[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);
  if (!results.length) return <DataState title={emptyText} compact className="m-3" />;
  return (
    <div
      role="listbox"
      aria-label="Search results"
      className="divide-y divide-hairline bg-surface/45"
    >
      {results.map((result, current) => (
        <button
          ref={(node) => {
            refs.current[current] = node;
          }}
          id={`global-result-${current}`}
          role="option"
          aria-selected={active === current}
          type="button"
          key={result.id}
          onMouseEnter={() => onActive(current)}
          onClick={() => (onChoose ? onChoose(result) : router.push(resultHref(result)))}
          className={cn(
            "grid w-full cursor-pointer grid-cols-[1.5rem_minmax(0,1fr)] gap-3 px-5 py-3 text-left transition-colors hover:bg-surface/70",
            active === current && "bg-accent/[0.07]",
          )}
        >
          <span className="mt-0.5 flex size-6 items-center justify-center">
            <ResultIcon result={result} />
          </span>
          <span className="min-w-0">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="shrink-0 font-semibold text-sm">{result.name}</span>
              <span className="truncate text-muted-foreground text-xs">{result.path}</span>
            </span>
            <span className="mt-0.5 flex min-w-0 items-center gap-2 text-muted-foreground text-xs">
              <span className="truncate">{orgName ?? "Organization"}</span>
              <span aria-hidden="true" className="text-muted-foreground/40">
                ·
              </span>
              <span className="truncate">{result.projectTitle}</span>
            </span>
            {result.snippet ? (
              <span className="mt-2 grid min-w-0 grid-cols-[3rem_minmax(0,1fr)] overflow-hidden rounded-md bg-background/40 text-xs leading-5">
                <span className="border-hairline border-r px-2 py-1.5 text-right text-muted-foreground/65">
                  {result.snippet.lineNumber}
                </span>
                <span className="line-clamp-2 px-3 py-1.5 text-muted-foreground">
                  {result.snippet.before}
                  <mark className="rounded-xs bg-accent/25 px-0.5 font-medium text-foreground">
                    {result.snippet.match}
                  </mark>
                  {result.snippet.after}
                </span>
              </span>
            ) : null}
          </span>
        </button>
      ))}
    </div>
  );
}

export function searchKey(
  event: KeyboardEvent,
  count: number,
  active: number,
  setActive: (value: number) => void,
  choose: () => void,
) {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    setActive(Math.min(count - 1, active + 1));
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    setActive(Math.max(0, active - 1));
  } else if (event.key === "Enter" && count > 0) {
    event.preventDefault();
    choose();
  }
}
