"use client";

import { useQuery } from "convex/react";
import {
  AreaChart,
  BarChart3,
  Check,
  ChevronDown,
  LineChart,
  PieChart,
  Plus,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import type { TreeNode } from "@/app/dashboard/projects/[id]/editor/tree-utils";
import { ChartView } from "@/components/chart-view";
import { DataLoader } from "@/components/ui/data-state";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { resolveChartData } from "@/lib/chart-data";
import {
  type ChartType,
  chartColor,
  chartId,
  getChartRoots,
  inspectChart,
  MAX_CHART_SERIES,
} from "@/lib/chart-model";
import { fieldClass } from "@/lib/ui";
import { cn } from "@/lib/utils";

type SelectOption = { value: string; label: string };

const CHART_TYPES: Array<{ id: ChartType; label: string; icon: typeof LineChart }> = [
  { id: "bar", label: "Bar", icon: BarChart3 },
  { id: "line", label: "Line", icon: LineChart },
  { id: "area", label: "Area", icon: AreaChart },
  { id: "pie", label: "Pie", icon: PieChart },
];

function Select({
  label,
  value,
  options,
  disabled = false,
  onChange,
}: {
  label: string;
  value: string;
  options: SelectOption[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  const selected = options.find((option) => option.value === value);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          fieldClass,
          "flex h-9 w-full cursor-pointer items-center justify-between gap-2 text-left text-xs disabled:cursor-not-allowed disabled:opacity-60",
        )}
      >
        <span className="truncate">{selected?.label ?? "Select"}</span>
        <ChevronDown
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180")}
        />
      </button>
      {open ? (
        <div
          role="listbox"
          aria-label={label}
          className="absolute top-full right-0 left-0 z-50 mt-1 max-h-56 overflow-auto rounded-md border border-hairline bg-surface p-1 shadow-xl"
        >
          {options.map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={option.value === value}
              key={option.value}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
              className={cn(
                "flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-2 text-left text-xs hover:bg-foreground/[0.06]",
                option.value === value && "bg-foreground/[0.08]",
              )}
            >
              <Check className={cn("size-3.5 shrink-0", option.value !== value && "opacity-0")} />
              <span className="truncate">{option.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PanelLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-1.5 block font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
      {children}
    </span>
  );
}

export function ChartEditor({
  projectId,
  ydoc,
  awareness,
  ready,
  canEdit,
  nodes,
}: {
  projectId: Id<"projects">;
  ydoc: Y.Doc;
  awareness: Awareness;
  ready: boolean;
  canEdit: boolean;
  nodes: TreeNode[];
}) {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const update = () => setRevision((current) => current + 1);
    ydoc.on("update", update);
    awareness.on("change", update);
    return () => {
      ydoc.off("update", update);
      awareness.off("change", update);
    };
  }, [awareness, ydoc]);
  const config = useMemo(() => {
    void revision;
    if (!ready) return null;
    try {
      return inspectChart(ydoc);
    } catch {
      return null;
    }
  }, [ready, revision, ydoc]);
  const sourceResult = useQuery(api.charts.sourceData, {
    projectId,
    sourceDocId: config?.sourceDocId ?? null,
  });
  const source = sourceResult?.source ?? null;
  const data = useMemo(() => (config ? resolveChartData(config, source) : null), [config, source]);

  const sheetNodes = useMemo(
    () => nodes.filter((node) => node.kind === "file" && node.fileType === "sheet"),
    [nodes],
  );

  if (!ready || !config || !data) {
    return <DataLoader label="Loading chart" className="h-full" />;
  }

  const roots = getChartRoots(ydoc);
  const edit = (mutate: () => void) => {
    if (!canEdit) return;
    ydoc.transact(mutate, "chart-edit");
  };
  const setType = (type: ChartType) => edit(() => roots.config.set("type", type));
  const setTitle = (title: string) => edit(() => roots.config.set("title", title.slice(0, 200)));
  const setSource = (sourceDocId: string) =>
    edit(() => {
      roots.config.set("sourceDocId", sourceDocId || null);
      roots.config.set("labelColId", null);
      for (const key of [...roots.series.keys()]) roots.series.delete(key);
      roots.seriesOrder.delete(0, roots.seriesOrder.length);
    });
  const setLabel = (colId: string) => edit(() => roots.config.set("labelColId", colId || null));
  const addSeries = () => {
    if (config.series.length >= MAX_CHART_SERIES) return;
    const usedColumns = new Set(config.series.map((series) => series.colId));
    const nextColumn =
      source?.columns.find((column) => !usedColumns.has(column.id)) ?? source?.columns[0];
    if (!nextColumn) return;
    edit(() => {
      const id = chartId();
      const entry = new Y.Map<unknown>();
      entry.set("colId", nextColumn.id);
      entry.set("color", chartColor(config.series.length));
      roots.series.set(id, entry);
      roots.seriesOrder.push([id]);
    });
  };
  const setSeriesColumn = (id: string, colId: string) =>
    edit(() => roots.series.get(id)?.set("colId", colId));
  const setSeriesColor = (id: string, color: string) =>
    edit(() => roots.series.get(id)?.set("color", color));
  const removeSeries = (id: string) =>
    edit(() => {
      roots.series.delete(id);
      const index = roots.seriesOrder.toArray().indexOf(id);
      if (index >= 0) roots.seriesOrder.delete(index, 1);
    });

  const removedSource = Boolean(config.sourceDocId && !source && sourceResult !== undefined);
  const sourceOptions: SelectOption[] = [
    { value: "", label: "None" },
    ...sheetNodes.map((node) => ({ value: node.id, label: node.name })),
    ...(removedSource
      ? [{ value: config.sourceDocId as string, label: "Removed spreadsheet" }]
      : []),
  ];
  const columnOptions: SelectOption[] = (source?.columns ?? []).map((column) => ({
    value: column.id,
    label: column.name || "Column",
  }));
  const labelOptions: SelectOption[] = [{ value: "", label: "Row number" }, ...columnOptions];

  return (
    <div className="flex h-full min-h-0 flex-col bg-background lg:flex-row">
      <aside className="thin-scrollbar flex max-h-72 shrink-0 flex-col gap-5 overflow-auto border-hairline border-b p-4 lg:max-h-none lg:w-80 lg:border-r lg:border-b-0">
        <div>
          <PanelLabel>Chart type</PanelLabel>
          <div className="grid grid-cols-4 gap-1.5">
            {CHART_TYPES.map(({ id, label, icon: Icon }) => (
              <button
                type="button"
                key={id}
                disabled={!canEdit}
                aria-pressed={config.type === id}
                onClick={() => setType(id)}
                className={cn(
                  "flex cursor-pointer flex-col items-center gap-1 rounded-md border py-2 text-[10px] transition-colors disabled:cursor-not-allowed",
                  config.type === id
                    ? "border-accent/50 bg-accent/10 text-foreground"
                    : "border-hairline text-muted-foreground hover:bg-foreground/[0.04]",
                )}
              >
                <Icon className="size-4" />
                {label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <PanelLabel>Title</PanelLabel>
          <input
            key={config.title}
            defaultValue={config.title}
            disabled={!canEdit}
            maxLength={200}
            onBlur={(event) => setTitle(event.currentTarget.value)}
            placeholder="Untitled chart"
            className={cn(fieldClass, "h-9 w-full text-sm")}
          />
        </div>
        <div>
          <PanelLabel>Source spreadsheet</PanelLabel>
          <Select
            label="Source spreadsheet"
            value={config.sourceDocId ?? ""}
            options={sourceOptions}
            disabled={!canEdit}
            onChange={setSource}
          />
        </div>
        <div>
          <PanelLabel>{config.type === "pie" ? "Slice labels" : "Category axis"}</PanelLabel>
          <Select
            label="Category axis"
            value={config.labelColId ?? ""}
            options={labelOptions}
            disabled={!canEdit || !source}
            onChange={setLabel}
          />
        </div>
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <PanelLabel>{config.type === "pie" ? "Values" : "Series"}</PanelLabel>
            <button
              type="button"
              disabled={!canEdit || !source || config.series.length >= MAX_CHART_SERIES}
              onClick={addSeries}
              className="flex cursor-pointer items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] text-accent hover:bg-accent/10 disabled:cursor-not-allowed disabled:text-muted-foreground"
            >
              <Plus className="size-3.5" /> Add
            </button>
          </div>
          {config.series.length === 0 ? (
            <p className="rounded-md border border-hairline border-dashed px-3 py-4 text-center text-[11px] text-muted-foreground">
              {source ? "Add a data series to plot." : "Select a source spreadsheet first."}
            </p>
          ) : (
            <div className="space-y-2">
              {config.series.map((series, index) => (
                <div key={series.id} className="flex items-center gap-2">
                  <input
                    type="color"
                    value={series.color}
                    disabled={!canEdit}
                    aria-label={`Series ${index + 1} color`}
                    onChange={(event) => setSeriesColor(series.id, event.currentTarget.value)}
                    className="size-8 shrink-0 cursor-pointer rounded-sm border border-hairline bg-transparent p-0.5 disabled:cursor-not-allowed"
                  />
                  <div className="min-w-0 flex-1">
                    <Select
                      label={`Series ${index + 1} column`}
                      value={series.colId}
                      options={
                        columnOptions.some((option) => option.value === series.colId)
                          ? columnOptions
                          : [...columnOptions, { value: series.colId, label: "Removed column" }]
                      }
                      disabled={!canEdit || !source}
                      onChange={(colId) => setSeriesColumn(series.id, colId)}
                    />
                  </div>
                  <button
                    type="button"
                    disabled={!canEdit}
                    onClick={() => removeSeries(series.id)}
                    aria-label={`Remove series ${index + 1}`}
                    className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-sm border border-hairline text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        {config.type === "pie" && config.series.length > 1 ? (
          <p className="text-[11px] text-muted-foreground">
            A pie chart plots the first series only.
          </p>
        ) : null}
      </aside>
      <div className="min-h-0 flex-1">
        {config.sourceDocId ? (
          <ChartView model={data} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <BarChart3 className="size-8 text-muted-foreground/50" />
            <p className="font-medium text-sm">Choose a source spreadsheet</p>
            <p className="max-w-xs text-muted-foreground text-xs">
              Charts visualize live data from a spreadsheet in this project. Pick a source, then add
              series to plot.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
