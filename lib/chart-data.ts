import type { ChartConfig, ChartType } from "./chart-model";

export const MAX_CHART_SOURCE_ROWS = 500;

export type ChartSource = {
  documentId: string;
  name: string;
  columns: Array<{ id: string; name: string }>;
  rows: Array<{ id: string; values: string[] }>;
  truncated: boolean;
};

type ChartResolvedSeries = {
  id: string;
  name: string;
  color: string;
  values: Array<number | null>;
  role: "bar" | "line";
};

export type ChartData = {
  status: "ok" | "no-source" | "empty";
  type: ChartType;
  title: string;
  sourceName: string | null;
  categories: string[];
  series: ChartResolvedSeries[];
  droppedSeries: number;
  truncated: boolean;
};

function parseNumber(raw: string): number | null {
  const trimmed = raw.trim().replace(/,/g, "");
  if (trimmed.length === 0) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

function dataRows(config: ChartConfig, source: ChartSource): ChartSource["rows"] {
  const body = config.headerRow ? source.rows.slice(1) : source.rows;
  const startIndex = config.startRowId ? body.findIndex((row) => row.id === config.startRowId) : -1;
  const endIndex = config.endRowId ? body.findIndex((row) => row.id === config.endRowId) : -1;
  const from = startIndex >= 0 ? startIndex : 0;
  const to = endIndex >= 0 ? endIndex : body.length - 1;
  return from <= to ? body.slice(from, to + 1) : body.slice(to, from + 1);
}

export function resolveChartData(config: ChartConfig, source: ChartSource | null): ChartData {
  const base = {
    type: config.type,
    title: config.title,
    sourceName: source?.name ?? null,
    droppedSeries: 0,
    truncated: source?.truncated ?? false,
  };
  if (!source) {
    return { ...base, status: "no-source", categories: [], series: [] };
  }
  const columnIndex = new Map(source.columns.map((column, index) => [column.id, index]));
  const labelIndex = config.labelColId ? columnIndex.get(config.labelColId) : undefined;
  const activeSeries = config.series.filter((series) => columnIndex.has(series.colId));
  const droppedSeries = config.series.length - activeSeries.length;
  const seriesColumns = activeSeries.map((series) => ({
    definition: series,
    index: columnIndex.get(series.colId) as number,
  }));
  const header = config.headerRow ? source.rows[0] : undefined;
  const rows = dataRows(config, source);
  const categories: string[] = [];
  const values: Array<Array<number | null>> = seriesColumns.map(() => []);
  for (const [rowNumber, row] of rows.entries()) {
    const parsed = seriesColumns.map(({ index }) => parseNumber(row.values[index] ?? ""));
    if (parsed.every((value) => value === null)) continue;
    const label = labelIndex !== undefined ? (row.values[labelIndex] ?? "").trim() : "";
    categories.push(label.length > 0 ? label : `Row ${rowNumber + 1}`);
    parsed.forEach((value, seriesIndex) => {
      values[seriesIndex]?.push(value);
    });
  }
  const series: ChartResolvedSeries[] = seriesColumns.map(({ definition, index }, seriesIndex) => ({
    id: definition.id,
    name: (header?.values[index] ?? "").trim() || source.columns[index]?.name || "Series",
    color: definition.color,
    values: values[seriesIndex] ?? [],
    role: definition.role,
  }));
  const hasNumbers = series.some((entry) => entry.values.some((value) => value !== null));
  if (series.length === 0 || categories.length === 0 || !hasNumbers) {
    return { ...base, status: "empty", categories, series, droppedSeries };
  }
  return { ...base, status: "ok", categories, series, droppedSeries };
}
