import * as Y from "yjs";

const CHART_TYPES = ["line", "bar", "area", "pie"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export const MAX_CHART_SERIES = 12;
const MAX_CHART_TITLE_LENGTH = 200;
export const MAX_CHART_STATE_BYTES = 128 * 1024;
export const MAX_CHART_STORED_BYTES = 192 * 1024;

const CHART_COLOR_PALETTE = [
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#06b6d4",
  "#ef4444",
  "#a855f7",
  "#0ea5e9",
  "#84cc16",
] as const;

type ChartSeries = {
  id: string;
  colId: string;
  color: string;
};

export type ChartConfig = {
  type: ChartType;
  title: string;
  sourceDocId: string | null;
  labelColId: string | null;
  headerRow: boolean;
  startRowId: string | null;
  endRowId: string | null;
  series: ChartSeries[];
};

const CONFIG_KEYS = new Set([
  "type",
  "title",
  "sourceDocId",
  "labelColId",
  "headerRow",
  "startRowId",
  "endRowId",
]);

export type ChartRoots = {
  config: Y.Map<unknown>;
  series: Y.Map<Y.Map<unknown>>;
  seriesOrder: Y.Array<string>;
};

export class ChartValidationError extends Error {
  constructor() {
    super("invalid-update");
    this.name = "ChartValidationError";
  }
}

export function chartId(): string {
  return crypto.randomUUID();
}

export function chartColor(index: number): string {
  return CHART_COLOR_PALETTE[Math.abs(index) % CHART_COLOR_PALETTE.length] ?? "#3b82f6";
}

export function getChartRoots(ydoc: Y.Doc): ChartRoots {
  return {
    config: ydoc.getMap("chartConfig"),
    series: ydoc.getMap<Y.Map<unknown>>("chartSeries"),
    seriesOrder: ydoc.getArray<string>("chartSeriesOrder"),
  };
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_:-]{1,128}$/.test(value);
}

function isColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function uniqueIds(values: unknown[], cap: number): string[] {
  if (values.length > cap * 4) throw new ChartValidationError();
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!isId(value)) throw new ChartValidationError();
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  if (result.length > cap) throw new ChartValidationError();
  return result;
}

export function inspectChart(ydoc: Y.Doc): ChartConfig {
  const roots = getChartRoots(ydoc);
  const type = roots.config.get("type");
  const title = roots.config.get("title");
  const sourceDocId = roots.config.get("sourceDocId");
  const labelColId = roots.config.get("labelColId");
  const headerRow = roots.config.get("headerRow") ?? true;
  const startRowId = roots.config.get("startRowId") ?? null;
  const endRowId = roots.config.get("endRowId") ?? null;
  if (
    !CHART_TYPES.includes(type as ChartType) ||
    typeof title !== "string" ||
    title.length > MAX_CHART_TITLE_LENGTH ||
    !(sourceDocId === null || isId(sourceDocId)) ||
    !(labelColId === null || isId(labelColId)) ||
    typeof headerRow !== "boolean" ||
    !(startRowId === null || isId(startRowId)) ||
    !(endRowId === null || isId(endRowId)) ||
    [...roots.config.keys()].some((key) => !CONFIG_KEYS.has(key))
  ) {
    throw new ChartValidationError();
  }
  const order = uniqueIds(roots.seriesOrder.toArray(), MAX_CHART_SERIES);
  if (roots.series.size > MAX_CHART_SERIES) throw new ChartValidationError();
  const series = order.map((id) => {
    const entry = roots.series.get(id);
    if (!(entry instanceof Y.Map)) throw new ChartValidationError();
    const colId = entry.get("colId");
    const color = entry.get("color");
    if (
      !isId(colId) ||
      !isColor(color) ||
      [...entry.keys()].some((key) => key !== "colId" && key !== "color")
    ) {
      throw new ChartValidationError();
    }
    return { id, colId, color };
  });
  return {
    type: type as ChartType,
    title,
    sourceDocId: sourceDocId as string | null,
    labelColId: labelColId as string | null,
    headerRow,
    startRowId: startRowId as string | null,
    endRowId: endRowId as string | null,
    series,
  };
}

export function seedChart(ydoc: Y.Doc): void {
  const roots = getChartRoots(ydoc);
  if (roots.config.has("type")) return;
  ydoc.transact(() => {
    roots.config.set("type", "bar");
    roots.config.set("title", "");
    roots.config.set("sourceDocId", null);
    roots.config.set("labelColId", null);
    roots.config.set("headerRow", true);
    roots.config.set("startRowId", null);
    roots.config.set("endRowId", null);
  }, "seed");
}

export function replaceChartState(current: Y.Doc, target: Y.Doc): void {
  const currentRoots = getChartRoots(current);
  const targetConfig = inspectChart(target);
  current.transact(() => {
    for (const key of [...currentRoots.config.keys()]) currentRoots.config.delete(key);
    currentRoots.config.set("type", targetConfig.type);
    currentRoots.config.set("title", targetConfig.title);
    currentRoots.config.set("sourceDocId", targetConfig.sourceDocId);
    currentRoots.config.set("labelColId", targetConfig.labelColId);
    currentRoots.config.set("headerRow", targetConfig.headerRow);
    currentRoots.config.set("startRowId", targetConfig.startRowId);
    currentRoots.config.set("endRowId", targetConfig.endRowId);
    for (const key of [...currentRoots.series.keys()]) currentRoots.series.delete(key);
    currentRoots.seriesOrder.delete(0, currentRoots.seriesOrder.length);
    for (const series of targetConfig.series) {
      const entry = new Y.Map<unknown>();
      entry.set("colId", series.colId);
      entry.set("color", series.color);
      currentRoots.series.set(series.id, entry);
    }
    currentRoots.seriesOrder.insert(
      0,
      targetConfig.series.map((series) => series.id),
    );
  }, "replace-chart");
}
