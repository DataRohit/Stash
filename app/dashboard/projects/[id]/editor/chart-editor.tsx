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
import { createPortal } from "react-dom";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import type { TreeNode } from "@/app/dashboard/projects/[id]/editor/tree-utils";
import { ChartView } from "@/components/chart-view";
import { ColorPicker } from "@/components/ui/color-picker";
import { DataLoader } from "@/components/ui/data-state";
import { useAnchoredPosition, useOutsideClose } from "@/components/ui/floating";
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
  { id: "scatter", label: "Scatter", icon: LineChart },
  { id: "stacked-bar", label: "Stacked", icon: BarChart3 },
  { id: "combo", label: "Combo", icon: BarChart3 },
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
  const floatingRef = useRef<HTMLDivElement>(null);
  const ref = useOutsideClose(() => setOpen(false), floatingRef);
  const position = useAnchoredPosition({ open, anchorRef: ref, floatingRef, estimatedHeight: 224 });
  const selected = options.find((option) => option.value === value);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={selected?.label ?? label}
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
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={floatingRef}
              role="listbox"
              aria-label={label}
              className="fixed z-[180] max-h-56 space-y-1 overflow-auto rounded-md border border-hairline bg-surface p-1 shadow-xl"
              style={position}
            >
              {options.map((option) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  key={option.value}
                  title={option.label}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-2 text-left text-xs hover:bg-foreground/[0.06]",
                    option.value === value && "bg-foreground/[0.08]",
                  )}
                >
                  <Check
                    className={cn("size-3.5 shrink-0", option.value !== value && "opacity-0")}
                  />
                  <span className="truncate">{option.label}</span>
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
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
    sourceType: config?.sourceType,
    groupPropertyId: config?.groupPropertyId,
    valuePropertyId: config?.valuePropertyId,
    aggregate: config?.aggregate,
  });
  const propertyResult = useQuery(api.structuredSurfaces.listProperties, { projectId });
  const source = sourceResult?.source ?? null;
  const data = useMemo(() => (config ? resolveChartData(config, source) : null), [config, source]);

  const sheetNodes = useMemo(
    () => nodes.filter((node) => node.kind === "file" && node.fileType === config?.sourceType),
    [config?.sourceType, nodes],
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
  const setSourceType = (sourceType: "sheet" | "view") =>
    edit(() => {
      roots.config.set("sourceType", sourceType);
      roots.config.set("sourceDocId", null);
      roots.config.set("labelColId", sourceType === "view" ? "group" : null);
      roots.config.set("headerRow", sourceType === "sheet");
      for (const key of [...roots.series.keys()]) roots.series.delete(key);
      roots.seriesOrder.delete(0, roots.seriesOrder.length);
      if (sourceType === "view") {
        const id = chartId();
        const entry = new Y.Map<unknown>();
        entry.set("colId", "value");
        entry.set("color", chartColor(0));
        entry.set("role", "bar");
        roots.series.set(id, entry);
        roots.seriesOrder.push([id]);
      }
    });
  const setAggregateField = (key: "groupPropertyId" | "valuePropertyId", value: string) =>
    edit(() => roots.config.set(key, value || null));
  const setLabel = (colId: string) => edit(() => roots.config.set("labelColId", colId || null));
  const setHeaderRow = (value: boolean) =>
    edit(() => {
      roots.config.set("headerRow", value);
      roots.config.set("startRowId", null);
      roots.config.set("endRowId", null);
    });
  const setRowBound = (key: "startRowId" | "endRowId", rowId: string) =>
    edit(() => roots.config.set(key, rowId || null));
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
      entry.set("role", config.type === "combo" && config.series.length > 0 ? "line" : "bar");
      roots.series.set(id, entry);
      roots.seriesOrder.push([id]);
    });
  };
  const setSeriesColumn = (id: string, colId: string) =>
    edit(() => roots.series.get(id)?.set("colId", colId));
  const setSeriesColor = (id: string, color: string) =>
    edit(() => roots.series.get(id)?.set("color", color));
  const setSeriesRole = (id: string, role: "bar" | "line") =>
    edit(() => roots.series.get(id)?.set("role", role));
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
      ? [{ value: config.sourceDocId as string, label: `Removed ${config.sourceType}` }]
      : []),
  ];
  const columnOptions: SelectOption[] = (source?.columns ?? []).map((column) => ({
    value: column.id,
    label: column.name || "Column",
  }));
  const labelOptions: SelectOption[] = [{ value: "", label: "Row number" }, ...columnOptions];
  const bodyRows = source ? (config.headerRow ? source.rows.slice(1) : source.rows) : [];
  const labelColumnIndex = source?.columns.findIndex((column) => column.id === config.labelColId);
  const rowOptions: SelectOption[] = bodyRows.map((row, index) => {
    const offset = config.headerRow ? 2 : 1;
    const text =
      labelColumnIndex !== undefined && labelColumnIndex >= 0
        ? (row.values[labelColumnIndex] ?? "").trim()
        : "";
    return {
      value: row.id,
      label: text ? `Row ${index + offset} — ${text}` : `Row ${index + offset}`,
    };
  });
  const properties = (propertyResult ?? []).filter((property) => !property.deleted);
  const propertyOptions = [
    { value: "", label: "None" },
    ...properties.map((property) => ({ value: property.id, label: property.name })),
  ];
  const numericPropertyOptions = [
    { value: "", label: "Choose number property" },
    ...properties
      .filter((property) => property.type === "number")
      .map((property) => ({ value: property.id, label: property.name })),
  ];

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
          <PanelLabel>Data source</PanelLabel>
          <div className="grid grid-cols-2 gap-1.5">
            {(["sheet", "view"] as const).map((sourceType) => (
              <button
                type="button"
                key={sourceType}
                disabled={!canEdit}
                aria-pressed={config.sourceType === sourceType}
                onClick={() => setSourceType(sourceType)}
                className={cn(
                  "h-9 rounded-md border text-xs capitalize",
                  config.sourceType === sourceType
                    ? "border-accent/50 bg-accent/10"
                    : "border-hairline",
                )}
              >
                {sourceType === "sheet" ? "Spreadsheet" : "Team view"}
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
          <PanelLabel>
            Source {config.sourceType === "sheet" ? "spreadsheet" : "team view"}
          </PanelLabel>
          <Select
            label="Source spreadsheet"
            value={config.sourceDocId ?? ""}
            options={sourceOptions}
            disabled={!canEdit}
            onChange={setSource}
          />
        </div>
        {config.sourceType === "view" ? (
          <div className="space-y-3">
            <div>
              <PanelLabel>Group records by</PanelLabel>
              <Select
                label="Group records by"
                value={config.groupPropertyId ?? ""}
                options={propertyOptions}
                disabled={!canEdit}
                onChange={(value) => setAggregateField("groupPropertyId", value)}
              />
            </div>
            <div>
              <PanelLabel>Calculation</PanelLabel>
              <Select
                label="Calculation"
                value={config.aggregate}
                options={[
                  { value: "count", label: "Count records" },
                  { value: "sum", label: "Sum a number property" },
                ]}
                disabled={!canEdit}
                onChange={(value) => edit(() => roots.config.set("aggregate", value))}
              />
            </div>
            {config.aggregate === "sum" ? (
              <div>
                <PanelLabel>Number property</PanelLabel>
                <Select
                  label="Number property"
                  value={config.valuePropertyId ?? ""}
                  options={numericPropertyOptions}
                  disabled={!canEdit}
                  onChange={(value) => setAggregateField("valuePropertyId", value)}
                />
              </div>
            ) : null}
          </div>
        ) : null}
        {config.sourceType === "sheet" ? (
          <div>
            <button
              type="button"
              disabled={!canEdit || !source}
              aria-pressed={config.headerRow}
              onClick={() => setHeaderRow(!config.headerRow)}
              className="flex w-full cursor-pointer items-start gap-2.5 rounded-md border border-hairline p-2.5 text-left transition-colors hover:bg-foreground/[0.03] disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span
                className={cn(
                  "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-xs border border-hairline",
                  config.headerRow && "border-accent bg-accent text-accent-foreground",
                )}
              >
                {config.headerRow ? <Check className="size-3" /> : null}
              </span>
              <span className="min-w-0">
                <span className="block font-medium text-xs">First row is a header</span>
                <span className="mt-0.5 block text-[11px] text-muted-foreground">
                  Excludes row 1 from the chart and names each series after its header cell.
                </span>
              </span>
            </button>
          </div>
        ) : null}
        {config.sourceType === "sheet" ? (
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
        ) : null}
        {config.sourceType === "sheet" ? (
          <div>
            <PanelLabel>Rows to plot</PanelLabel>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="w-8 shrink-0 text-[11px] text-muted-foreground">From</span>
                <div className="min-w-0 flex-1">
                  <Select
                    label="First row to plot"
                    value={config.startRowId ?? ""}
                    options={[{ value: "", label: "First row" }, ...rowOptions]}
                    disabled={!canEdit || !source}
                    onChange={(rowId) => setRowBound("startRowId", rowId)}
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-8 shrink-0 text-[11px] text-muted-foreground">To</span>
                <div className="min-w-0 flex-1">
                  <Select
                    label="Last row to plot"
                    value={config.endRowId ?? ""}
                    options={[{ value: "", label: "Last row" }, ...rowOptions]}
                    disabled={!canEdit || !source}
                    onChange={(rowId) => setRowBound("endRowId", rowId)}
                  />
                </div>
              </div>
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Narrow the range to leave out totals or notes below your data.
            </p>
          </div>
        ) : null}
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
                <div
                  key={series.id}
                  className="space-y-2 rounded-md border border-hairline bg-surface/40 p-2"
                >
                  <div className="flex items-center gap-2">
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
                      className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-sm border border-hairline text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                  <ColorPicker
                    label={`Series ${index + 1} color`}
                    value={series.color}
                    disabled={!canEdit}
                    onChange={(color) => setSeriesColor(series.id, color)}
                  />
                  {config.type === "combo" ? (
                    <Select
                      label={`Series ${index + 1} rendering`}
                      value={series.role}
                      options={[
                        { value: "bar", label: "Bar" },
                        { value: "line", label: "Line" },
                      ]}
                      disabled={!canEdit}
                      onChange={(value) => setSeriesRole(series.id, value as "bar" | "line")}
                    />
                  ) : null}
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
            <p className="font-medium text-sm">Choose a data source</p>
            <p className="max-w-xs text-muted-foreground text-xs">
              Charts visualize live spreadsheet ranges or grouped team-view records in this project.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
