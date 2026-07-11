"use client";

import { useOrganization } from "@clerk/nextjs";
import { useQuery } from "convex/react";
import { Loader2, Search } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { api } from "@/convex/_generated/api";
import { type GlobalResult, resultHref, SearchResults, searchKey } from "./search-ui";

export const OPEN_QUICK_SEARCH = "stash-open-quick-search";

export function QuickOpen() {
  const { organization } = useOrganization();
  const router = useRouter();
  const pathname = usePathname();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [active, setActive] = useState(0);
  const orgId = organization?.id;
  const recent = useQuery(
    api.navigation.listRecent,
    open && orgId ? { clerkOrgId: orgId } : "skip",
  );
  const projects = useQuery(
    api.navigation.listProjects,
    open && orgId ? { clerkOrgId: orgId } : "skip",
  );
  const search = useQuery(
    api.navigation.search,
    open && orgId && debounced ? { clerkOrgId: orgId, query: debounced, mode: "palette" } : "skip",
  );
  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setDebounced("");
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 180);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    const timer = window.setTimeout(close, 0);
    return () => window.clearTimeout(timer);
  }, [pathname, orgId, close]);
  useEffect(() => {
    const show = () => setOpen(true);
    const key = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "k" &&
        !event.repeat &&
        !event.isComposing
      ) {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener(OPEN_QUICK_SEARCH, show);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener(OPEN_QUICK_SEARCH, show);
      window.removeEventListener("keydown", key);
    };
  }, []);
  const idleResults: GlobalResult[] = query.trim()
    ? []
    : [
        ...((recent ?? []).map((item) => ({
          id: `recent:${item.documentId}`,
          projectId: item.projectId,
          projectTitle: item.projectTitle,
          documentId: item.documentId,
          kind: item.kind,
          name: item.name,
          path: item.path,
          fileType: item.fileType,
          snippet: null,
        })) as GlobalResult[]),
        ...(projects ?? []).map((project) => ({
          id: `project:${project.id}`,
          projectId: project.id,
          projectTitle: project.title,
          documentId: null,
          kind: "project" as const,
          name: project.title,
          path: "/",
          fileType: null,
          snippet: null,
        })),
      ];
  const results = query.trim() ? ((search ?? []) as GlobalResult[]) : idleResults;
  const choose = (result: GlobalResult) => {
    close();
    router.push(resultHref(result));
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Quick open"
      icon={<Search className="size-4" />}
      initialFocusRef={inputRef}
      className="max-w-2xl"
    >
      <div className="flex items-center gap-2 border-hairline border-b px-4">
        <Search className="size-4 text-muted-foreground" />
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded="true"
          aria-controls="quick-results"
          aria-activedescendant={results[active] ? `global-result-${active}` : undefined}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query) {
              event.preventDefault();
              event.stopPropagation();
              setQuery("");
              return;
            }
            searchKey(
              event,
              results.length,
              active,
              setActive,
              () => results[active] && choose(results[active]),
            );
          }}
          placeholder="Search projects, files, and contents…"
          className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
        />
        <kbd className="rounded-xs border border-hairline px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          Esc
        </kbd>
      </div>
      <div id="quick-results" className="max-h-[60dvh] min-h-48 overflow-auto">
        {query.trim() && search === undefined ? (
          <p className="flex items-center justify-center gap-2 px-4 py-8 text-muted-foreground text-sm">
            <Loader2 className="size-4 animate-spin" />
            Searching…
          </p>
        ) : (
          <SearchResults
            results={results}
            active={active}
            onActive={setActive}
            onChoose={choose}
            orgName={organization?.name}
            emptyText={
              query ? `No matches for “${query.trim()}”.` : "Open a project to get started."
            }
          />
        )}
      </div>
      {query.trim() ? (
        <button
          type="button"
          onClick={() => {
            close();
            router.push(`/dashboard/search?q=${encodeURIComponent(query.trim())}`);
          }}
          className="flex h-11 w-full cursor-pointer items-center justify-center border-hairline border-t text-muted-foreground text-xs transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
        >
          Search all for “{query.trim()}”
        </button>
      ) : null}
    </Dialog>
  );
}
