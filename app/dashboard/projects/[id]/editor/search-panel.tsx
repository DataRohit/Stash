"use client";

import { useQuery } from "convex/react";
import { FileCode, FileText, Folder, Image as ImageIcon, Loader2, Search, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { pathOf, type TreeNode } from "@/app/dashboard/projects/[id]/editor/tree-utils";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { cn } from "@/lib/utils";

type Snippet = { before: string; match: string; after: string };
type ContentHit = {
  id: string;
  name: string;
  parentId: string | null;
  fileType: "md" | "html" | "doc" | null;
  snippet: Snippet;
};

type SearchPanelProps = {
  projectId: Id<"projects">;
  nodes: TreeNode[];
  query: string;
  onQueryChange: (value: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  children: ReactNode;
};

function NodeGlyph({ node }: { node: TreeNode }) {
  if (node.kind === "folder") {
    return <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />;
  }
  if (node.kind === "asset") {
    return <ImageIcon className="size-4 shrink-0 text-info" aria-hidden="true" />;
  }
  return node.fileType === "html" ? (
    <FileCode className="size-4 shrink-0 text-warning" aria-hidden="true" />
  ) : (
    <FileText className="size-4 shrink-0 text-accent" aria-hidden="true" />
  );
}

function Highlighted({ text, term }: { text: string; term: string }) {
  const lower = text.toLowerCase();
  const needle = term.toLowerCase();
  const at = needle.length > 0 ? lower.indexOf(needle) : -1;
  if (at < 0) {
    return <>{text}</>;
  }
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-xs bg-accent/25 text-foreground">
        {text.slice(at, at + term.length)}
      </mark>
      {text.slice(at + term.length)}
    </>
  );
}

function dirLabel(path: string): string {
  const slash = path.lastIndexOf("/");
  const dir = slash > 0 ? path.slice(0, slash) : "";
  return dir.length > 0 ? dir : "/";
}

export function SearchPanel({
  projectId,
  nodes,
  query,
  onQueryChange,
  selectedId,
  onSelect,
  children,
}: SearchPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsId = useId();
  const [debounced, setDebounced] = useState("");
  const trimmed = query.trim();

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(trimmed), 250);
    return () => clearTimeout(timer);
  }, [trimmed]);

  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);

  const nameMatches = useMemo(() => {
    if (trimmed.length === 0) {
      return [];
    }
    const needle = trimmed.toLowerCase();
    return nodes
      .filter((node) => node.name.toLowerCase().includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 30);
  }, [nodes, trimmed]);

  const contentData = useQuery(
    api.documents.search,
    debounced.length > 0 ? { projectId, query: debounced } : "skip",
  );
  const nameMatchIds = useMemo(() => new Set(nameMatches.map((node) => node.id)), [nameMatches]);
  const contentHits = useMemo(() => {
    const hits = (contentData ?? []) as ContentHit[];
    return hits.filter((hit) => !nameMatchIds.has(hit.id));
  }, [contentData, nameMatchIds]);

  const loading = debounced.length > 0 && contentData === undefined;
  const empty =
    trimmed.length > 0 && !loading && nameMatches.length === 0 && contentHits.length === 0;

  const firstResultId = nameMatches[0]?.id ?? contentHits[0]?.id ?? null;

  return (
    <div className="flex h-full flex-col">
      <search className="flex h-11 shrink-0 items-center gap-2 border-hairline border-b px-3">
        <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              onQueryChange("");
            } else if (event.key === "Enter" && firstResultId) {
              event.preventDefault();
              onSelect(firstResultId);
            }
          }}
          placeholder="Search files…"
          aria-label="Search project files"
          aria-controls={resultsId}
          className="min-w-0 flex-1 bg-transparent p-0 text-foreground text-xs caret-accent outline-none placeholder:text-muted-foreground/45"
        />
        {trimmed.length > 0 ? (
          <button
            type="button"
            onClick={() => {
              onQueryChange("");
              inputRef.current?.focus();
            }}
            aria-label="Clear search"
            className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-xs text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </search>
      {trimmed.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      ) : (
        <div id={resultsId} className="min-h-0 flex-1 overflow-auto py-1.5">
          {loading && nameMatches.length === 0 ? (
            <p
              className="flex items-center gap-2 px-3 py-4 text-muted-foreground/80 text-xs"
              role="status"
            >
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              Searching…
            </p>
          ) : null}
          {empty ? (
            <p className="px-3 py-4 text-muted-foreground/80 text-xs" role="status">
              No matches for “{trimmed}”.
            </p>
          ) : null}
          {nameMatches.length > 0 ? (
            <ul className="flex flex-col gap-1 px-2">
              {nameMatches.map((node) => (
                <li key={node.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(node.id)}
                    aria-current={node.id === selectedId ? "true" : undefined}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-2 rounded-md px-3 py-1.5 text-left transition-colors hover:bg-foreground/[0.04]",
                      node.id === selectedId ? "bg-accent/[0.09]" : null,
                    )}
                  >
                    <NodeGlyph node={node} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-foreground text-xs">
                        <Highlighted text={node.name} term={trimmed} />
                      </span>
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {dirLabel(pathOf(node, byId))}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {contentHits.length > 0 ? (
            <>
              <p className="px-3 pt-3 pb-1 font-medium font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
                In file contents
              </p>
              <ul className="flex flex-col gap-1 px-2">
                {contentHits.map((hit) => {
                  const node = byId.get(hit.id);
                  return (
                    <li key={hit.id}>
                      <button
                        type="button"
                        onClick={() => onSelect(hit.id)}
                        aria-current={hit.id === selectedId ? "true" : undefined}
                        className={cn(
                          "flex w-full cursor-pointer flex-col gap-1 rounded-md px-3 py-2 text-left transition-colors hover:bg-foreground/[0.04]",
                          hit.id === selectedId ? "bg-accent/[0.09]" : null,
                        )}
                      >
                        <span className="flex items-center gap-2">
                          {hit.fileType === "html" ? (
                            <FileCode className="size-4 shrink-0 text-warning" aria-hidden="true" />
                          ) : (
                            <FileText className="size-4 shrink-0 text-accent" aria-hidden="true" />
                          )}
                          <span className="min-w-0 flex-1 truncate text-foreground text-xs">
                            {hit.name}
                          </span>
                        </span>
                        <span className="line-clamp-2 pl-6 text-[11px] text-muted-foreground leading-snug">
                          {hit.snippet.before}
                          {hit.snippet.match ? (
                            <mark className="rounded-xs bg-accent/25 text-foreground">
                              {hit.snippet.match}
                            </mark>
                          ) : null}
                          {hit.snippet.after}
                        </span>
                        {node ? (
                          <span className="truncate pl-6 text-[10px] text-muted-foreground/70">
                            {dirLabel(pathOf(node, byId))}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
