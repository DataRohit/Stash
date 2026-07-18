"use client";

import { useQuery } from "convex/react";
import { BarChart3, ChevronDown, ChevronUp, Plus, Sigma, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type * as Y from "yjs";
import type { TreeNode } from "@/app/dashboard/projects/[id]/editor/tree-utils";
import { ChartView } from "@/components/chart-view";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { resolveChartData } from "@/lib/chart-data";
import {
  createDashboardTile,
  type DashboardTile,
  dashboardId,
  getDashboardRoots,
  inspectDashboard,
  MAX_DASHBOARD_TILES,
} from "@/lib/dashboard-model";
import { fieldClass } from "@/lib/ui";
import { cn } from "@/lib/utils";

function ChartTile({ projectId, tile }: { projectId: Id<"projects">; tile: DashboardTile }) {
  const result = useQuery(api.charts.dashboardChartData, {
    projectId,
    chartDocumentId: tile.sourceDocId,
  });
  if (result === undefined)
    return <div className="h-44 animate-pulse rounded-md bg-foreground/[0.04]" />;
  if (!result || result.status === "missing") {
    return (
      <p className="p-6 text-center text-muted-foreground text-sm">
        Chart unavailable or in trash.
      </p>
    );
  }
  return <ChartView model={resolveChartData(result.config, result.source)} />;
}

function StatTile({ projectId, tile }: { projectId: Id<"projects">; tile: DashboardTile }) {
  const result = useQuery(api.charts.dashboardStatData, {
    projectId,
    viewDocumentId: tile.sourceDocId,
    aggregate: tile.aggregate,
    propertyId: tile.propertyId,
  });
  if (result === undefined)
    return <div className="h-28 animate-pulse rounded-md bg-foreground/[0.04]" />;
  if (!result || result.status === "missing") {
    return (
      <p className="p-6 text-center text-muted-foreground text-sm">View unavailable or in trash.</p>
    );
  }
  return (
    <div className="flex min-h-36 flex-col items-center justify-center gap-2">
      <strong className="font-mono text-4xl tracking-tight">{result.value.toLocaleString()}</strong>
      <span className="text-muted-foreground text-xs uppercase tracking-widest">
        {tile.aggregate === "sum" ? "Total" : "Records"}
        {result.truncated ? " · sampled" : ""}
      </span>
    </div>
  );
}

export function DashboardEditor({
  projectId,
  ydoc,
  ready,
  canEdit,
  nodes,
}: {
  projectId: Id<"projects">;
  ydoc: Y.Doc;
  ready: boolean;
  canEdit: boolean;
  nodes: TreeNode[];
}) {
  const [revision, setRevision] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [kind, setKind] = useState<"chart" | "stat">("chart");
  const [sourceDocId, setSourceDocId] = useState("");
  const [title, setTitle] = useState("");
  const [aggregate, setAggregate] = useState<"count" | "sum">("count");
  const properties = useQuery(api.structuredSurfaces.listProperties, { projectId });
  const [propertyId, setPropertyId] = useState<string>("");

  useEffect(() => {
    const update = () => setRevision((value) => value + 1);
    ydoc.on("update", update);
    return () => ydoc.off("update", update);
  }, [ydoc]);

  const tiles = useMemo(() => {
    void revision;
    if (!ready) return [];
    try {
      return inspectDashboard(ydoc);
    } catch {
      return [];
    }
  }, [ydoc, ready, revision]);
  const sources = nodes.filter(
    (node) => node.kind === "file" && node.fileType === (kind === "chart" ? "chart" : "view"),
  );

  const addTile = () => {
    if (!sourceDocId || tiles.length >= MAX_DASHBOARD_TILES) return;
    const roots = getDashboardRoots(ydoc);
    const id = dashboardId();
    ydoc.transact(() => {
      roots.tiles.set(
        id,
        createDashboardTile({
          kind,
          title: title.trim() || (kind === "chart" ? "Chart" : "Statistic"),
          sourceDocId,
          aggregate: kind === "stat" ? aggregate : "count",
          propertyId: kind === "stat" && aggregate === "sum" ? propertyId || null : null,
          x: 0,
          y: tiles.length,
          width: 1,
          height: 1,
        }),
      );
      roots.order.push([id]);
    }, "dashboard-edit");
    setAddOpen(false);
    setSourceDocId("");
    setTitle("");
  };

  const move = (id: string, direction: -1 | 1) => {
    const order = getDashboardRoots(ydoc).order;
    const current = order.toArray().indexOf(id);
    const target = current + direction;
    if (current < 0 || target < 0 || target >= order.length) return;
    ydoc.transact(() => {
      order.delete(current, 1);
      order.insert(target, [id]);
    }, "dashboard-arrange");
  };

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        Preparing dashboard…
      </div>
    );
  }
  return (
    <section className="thin-scrollbar h-full overflow-y-auto bg-background p-3 sm:p-5">
      <header className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">Dashboard</h2>
          <p className="text-muted-foreground text-xs">Live charts and view statistics.</p>
        </div>
        <Button
          onClick={() => setAddOpen(true)}
          disabled={!canEdit || tiles.length >= MAX_DASHBOARD_TILES}
        >
          <Plus className="size-4" /> Add tile
        </Button>
      </header>
      {tiles.length === 0 ? (
        <div className="rounded-lg border border-hairline border-dashed p-12 text-center text-muted-foreground text-sm">
          Add a chart or statistic to build this dashboard.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {tiles.map((tile, index) => (
            <article
              key={tile.id}
              className={cn(
                "overflow-hidden rounded-lg border border-hairline bg-surface shadow-sm",
                tile.width === 2 && "lg:col-span-2",
              )}
            >
              <header className="flex h-11 items-center gap-2 border-hairline border-b px-3">
                {tile.kind === "chart" ? (
                  <BarChart3 className="size-4 text-warning" />
                ) : (
                  <Sigma className="size-4 text-info" />
                )}
                <h3 className="min-w-0 flex-1 truncate font-medium text-sm">{tile.title}</h3>
                {canEdit ? (
                  <>
                    <button
                      type="button"
                      disabled={index === 0}
                      onClick={() => move(tile.id, -1)}
                      className="rounded-sm p-1 text-muted-foreground hover:bg-foreground/[0.06] disabled:opacity-30"
                      aria-label={`Move ${tile.title} earlier`}
                    >
                      <ChevronUp className="size-4" />
                    </button>
                    <button
                      type="button"
                      disabled={index === tiles.length - 1}
                      onClick={() => move(tile.id, 1)}
                      className="rounded-sm p-1 text-muted-foreground hover:bg-foreground/[0.06] disabled:opacity-30"
                      aria-label={`Move ${tile.title} later`}
                    >
                      <ChevronDown className="size-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const map = getDashboardRoots(ydoc).tiles.get(tile.id);
                        ydoc.transact(() => {
                          map?.set("width", tile.width === 1 ? 2 : 1);
                          map?.set("height", tile.height === 1 ? 2 : 1);
                        }, "dashboard-arrange");
                      }}
                      className="rounded-sm px-1.5 py-1 text-[10px] text-muted-foreground hover:bg-foreground/[0.06]"
                      aria-label={`Resize ${tile.title}, currently ${tile.width} by ${tile.height}`}
                    >
                      {tile.width}×{tile.height}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const roots = getDashboardRoots(ydoc);
                        ydoc.transact(() => {
                          roots.tiles.delete(tile.id);
                          const position = roots.order.toArray().indexOf(tile.id);
                          if (position >= 0) roots.order.delete(position, 1);
                        }, "dashboard-edit");
                      }}
                      className="p-1 text-muted-foreground hover:text-destructive"
                      aria-label={`Remove ${tile.title}`}
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </>
                ) : null}
              </header>
              <div className={cn(tile.height === 2 && "min-h-[32rem]")}>
                {tile.kind === "chart" ? (
                  <ChartTile projectId={projectId} tile={tile} />
                ) : (
                  <StatTile projectId={projectId} tile={tile} />
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      <Dialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add dashboard tile"
        className="max-w-md"
      >
        <div className="space-y-4 p-4">
          <label className="block text-xs">
            Tile type
            <select
              className={cn(fieldClass, "mt-1 w-full")}
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as "chart" | "stat");
                setSourceDocId("");
              }}
              disabled={!canEdit}
            >
              <option value="chart">Chart</option>
              <option value="stat">Statistic</option>
            </select>
          </label>
          <label className="block text-xs">
            Title
            <input
              className={cn(fieldClass, "mt-1 w-full")}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className="block text-xs">
            Source
            <select
              className={cn(fieldClass, "mt-1 w-full")}
              value={sourceDocId}
              onChange={(event) => setSourceDocId(event.target.value)}
            >
              <option value="">Choose a {kind === "chart" ? "chart" : "view"}</option>
              {sources.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.name}
                </option>
              ))}
            </select>
          </label>
          {kind === "stat" ? (
            <>
              <label className="block text-xs">
                Aggregate
                <select
                  className={cn(fieldClass, "mt-1 w-full")}
                  value={aggregate}
                  onChange={(event) => setAggregate(event.target.value as "count" | "sum")}
                >
                  <option value="count">Record count</option>
                  <option value="sum">Sum a number property</option>
                </select>
              </label>
              {aggregate === "sum" ? (
                <label className="block text-xs">
                  Number property
                  <select
                    className={cn(fieldClass, "mt-1 w-full")}
                    value={propertyId}
                    onChange={(event) => setPropertyId(event.target.value)}
                  >
                    <option value="">Choose a property</option>
                    {(properties ?? [])
                      .filter((property) => property.type === "number")
                      .map((property) => (
                        <option key={property.id} value={property.id}>
                          {property.name}
                        </option>
                      ))}
                  </select>
                </label>
              ) : null}
            </>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={addTile}
              disabled={!sourceDocId || (kind === "stat" && aggregate === "sum" && !propertyId)}
            >
              Add tile
            </Button>
          </div>
        </div>
      </Dialog>
    </section>
  );
}
