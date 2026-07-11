"use client";

import { useQuery } from "convex/react";
import { Loader2, Search } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  type GlobalResult,
  resultHref,
  SearchResults,
  searchKey,
} from "@/components/dashboard/search-ui";
import { api } from "@/convex/_generated/api";

export function GlobalSearchPage({ clerkOrgId }: { clerkOrgId: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const [query, setQuery] = useState(() => params.get("q") ?? "");
  const [debounced, setDebounced] = useState(query.trim());
  const [active, setActive] = useState(0);
  const results = useQuery(
    api.navigation.search,
    debounced ? { clerkOrgId, query: debounced, mode: "page" } : "skip",
  );
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const value = query.trim();
      setDebounced(value);
      const next = value ? `/dashboard/search?q=${encodeURIComponent(value)}` : "/dashboard/search";
      window.history.replaceState(null, "", next);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query]);
  const rows = (results ?? []) as GlobalResult[];
  return (
    <main className="flex w-full flex-col items-center px-3 pt-32 pb-16 sm:px-6 lg:pt-28">
      <section className="glass flex w-full max-w-7xl flex-col overflow-hidden rounded-lg">
        <div className="border-hairline border-b p-5 sm:p-7">
          <span className="font-mono text-muted-foreground text-xs uppercase tracking-widest">
            — Workspace search
          </span>
          <h1 className="mt-1 font-serif text-3xl tracking-display">Search</h1>
          <div className="mt-5 flex h-12 items-center gap-3 rounded-md border border-hairline bg-surface/50 px-4">
            <Search className="size-5 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") setQuery("");
                searchKey(
                  event,
                  rows.length,
                  active,
                  setActive,
                  () => rows[active] && router.push(resultHref(rows[active])),
                );
              }}
              aria-label="Search workspace"
              aria-activedescendant={rows[active] ? `global-result-${active}` : undefined}
              placeholder="Search projects, files, paths, and contents…"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
            />
          </div>
        </div>
        <div className="min-h-72">
          {!debounced ? (
            <div className="px-6 py-14 text-center">
              <Search className="mx-auto size-8 text-muted-foreground/50" />
              <p className="mt-3 text-muted-foreground text-sm">
                Search every project you can access.
              </p>
            </div>
          ) : results === undefined ? (
            <p className="flex items-center justify-center gap-2 px-6 py-14 text-muted-foreground text-sm">
              <Loader2 className="size-4 animate-spin" />
              Searching…
            </p>
          ) : (
            <>
              <div className="border-hairline border-b px-5 py-2 font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
                {rows.length} {rows.length === 1 ? "result" : "results"}
              </div>
              <SearchResults
                results={rows}
                active={active}
                onActive={setActive}
                emptyText={`No matches for “${debounced}”.`}
              />
            </>
          )}
        </div>
      </section>
    </main>
  );
}
