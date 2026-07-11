"use client";

import { FileCode, FileText, Folder, Image as ImageIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { type KeyboardEvent, useEffect, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";

export type GlobalResult = {
  id: string;
  projectId: string;
  projectTitle: string;
  documentId: string | null;
  kind: "project" | "file" | "folder" | "asset" | "content";
  name: string;
  path: string;
  fileType: "md" | "html" | "doc" | null;
  snippet: { before: string; match: string; after: string } | null;
};

export function resultHref(result: GlobalResult): string {
  if (!result.documentId || result.kind === "folder") {
    return `/dashboard/projects/${result.projectId}${result.kind === "folder" ? "/editor" : ""}`;
  }
  return `/dashboard/projects/${result.projectId}/editor?file=${result.documentId}`;
}

function ResultIcon({ result }: { result: GlobalResult }) {
  if (result.kind === "project" || result.kind === "folder")
    return <Folder className="size-4 text-warning" />;
  if (result.kind === "asset") return <ImageIcon className="size-4 text-info" />;
  return result.fileType === "html" ? (
    <FileCode className="size-4 text-warning" />
  ) : (
    <FileText className="size-4 text-accent" />
  );
}

export function SearchResults({
  results,
  active,
  onActive,
  onChoose,
  emptyText = "No matches found.",
}: {
  results: GlobalResult[];
  active: number;
  onActive: (index: number) => void;
  onChoose?: (result: GlobalResult) => void;
  emptyText?: string;
}) {
  const router = useRouter();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => refs.current[active]?.scrollIntoView({ block: "nearest" }), [active]);
  const groups = useMemo(() => {
    const map = new Map<string, GlobalResult[]>();
    for (const result of results)
      map.set(result.projectTitle, [...(map.get(result.projectTitle) ?? []), result]);
    return [...map.entries()];
  }, [results]);
  if (!results.length)
    return <p className="px-4 py-8 text-center text-muted-foreground text-sm">{emptyText}</p>;
  let index = -1;
  return (
    <div role="listbox" aria-label="Search results" className="flex flex-col gap-4 p-2">
      {groups.map(([project, items]) => (
        <section key={project}>
          <h2 className="px-2 py-1 font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
            {project}
          </h2>
          <div className="flex flex-col gap-1">
            {items.map((result) => {
              index += 1;
              const current = index;
              return (
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
                    "flex min-h-12 w-full cursor-pointer items-start gap-3 rounded-md px-3 py-2 text-left transition-colors hover:bg-foreground/[0.05]",
                    active === current && "bg-accent/[0.1]",
                  )}
                >
                  <span className="mt-0.5 shrink-0">
                    <ResultIcon result={result} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-sm">{result.name}</span>
                    <span className="block truncate text-muted-foreground text-xs">
                      {result.path}
                    </span>
                    {result.snippet ? (
                      <span className="mt-1 line-clamp-2 block text-muted-foreground text-xs leading-relaxed">
                        {result.snippet.before}
                        <mark className="rounded-xs bg-accent/25 text-foreground">
                          {result.snippet.match}
                        </mark>
                        {result.snippet.after}
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
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
