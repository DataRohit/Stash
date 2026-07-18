import type { ChartData } from "./chart-data";

const CHART_WIDTH = 820;
const CHART_HEIGHT = 460;
const FONT_FAMILY = "ui-sans-serif, system-ui, sans-serif";
const AXIS_COLOR = "currentColor";
const PALETTE = [
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
];

export type ChartSceneNode =
  | {
      t: "rect";
      x: number;
      y: number;
      w: number;
      h: number;
      rx?: number;
      fill: string;
      fillOpacity?: number;
    }
  | {
      t: "line";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      stroke: string;
      strokeOpacity?: number;
    }
  | {
      t: "path";
      d: string;
      fill: string;
      fillOpacity?: number;
      stroke?: string;
      strokeWidth?: number;
      round?: boolean;
    }
  | { t: "circle"; cx: number; cy: number; r: number; fill: string }
  | {
      t: "text";
      x: number;
      y: number;
      text: string;
      anchor: "start" | "middle" | "end";
      size: number;
      opacity?: number;
      weight?: number;
    };

type MarkMeta = { category: string; series: string; value: number; color: string };

export type ChartMark =
  | ({ kind: "rect"; x: number; y: number; w: number; h: number } & MarkMeta)
  | ({ kind: "point"; x: number; y: number } & MarkMeta)
  | ({
      kind: "slice";
      cx: number;
      cy: number;
      r0: number;
      r1: number;
      a0: number;
      a1: number;
      percent: number;
    } & MarkMeta);

export type ChartScene = {
  width: number;
  height: number;
  label: string;
  nodes: ChartSceneNode[];
  marks: ChartMark[];
};

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function trimZero(value: number): string {
  return String(Number(value.toFixed(2)));
}

function formatTick(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${trimZero(value / 1_000_000)}M`;
  if (abs >= 1_000) return `${trimZero(value / 1_000)}k`;
  return trimZero(value);
}

function truncateLabel(label: string, max: number): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

function niceTicks(min: number, max: number, count: number): number[] {
  if (min === max) {
    const pad = Math.abs(min) > 0 ? Math.abs(min) * 0.5 : 1;
    return niceTicks(min - pad, max + pad, count);
  }
  const rawStep = (max - min) / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step = (normalized >= 5 ? 5 : normalized >= 2 ? 2 : 1) * magnitude;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let value = start; value <= end + step / 2; value += step) {
    ticks.push(Number(value.toFixed(10)));
  }
  return ticks;
}

function textNode(
  x: number,
  y: number,
  text: string,
  options: {
    anchor?: "start" | "middle" | "end";
    size?: number;
    opacity?: number;
    weight?: number;
  } = {},
): ChartSceneNode {
  return {
    t: "text",
    x: round(x),
    y: round(y),
    text,
    anchor: options.anchor ?? "middle",
    size: options.size ?? 12,
    opacity: options.opacity ?? 1,
    weight: options.weight ?? 400,
  };
}

function legendNodes(entries: Array<{ name: string; color: string }>, y: number): ChartSceneNode[] {
  if (entries.length === 0) return [];
  const items = entries.slice(0, 12);
  const gap = 18;
  const swatch = 11;
  const widths = items.map(
    (entry) => swatch + 6 + truncateLabel(entry.name, 18).length * 6.6 + gap,
  );
  const total = widths.reduce((sum, width) => sum + width, 0) - gap;
  let cursor = Math.max(12, (CHART_WIDTH - total) / 2);
  const nodes: ChartSceneNode[] = [];
  items.forEach((entry, index) => {
    nodes.push({
      t: "rect",
      x: round(cursor),
      y: round(y - swatch + 1),
      w: swatch,
      h: swatch,
      rx: 2.5,
      fill: entry.color,
    });
    nodes.push(
      textNode(cursor + swatch + 5, y, truncateLabel(entry.name, 18), {
        anchor: "start",
        size: 12,
        opacity: 0.85,
      }),
    );
    cursor += widths[index] ?? 0;
  });
  return nodes;
}

export function slicePath(slice: {
  cx: number;
  cy: number;
  r0: number;
  r1: number;
  a0: number;
  a1: number;
}): string {
  const { cx, cy, r0, r1, a0, a1 } = slice;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const x0 = cx + r1 * Math.cos(a0);
  const y0 = cy + r1 * Math.sin(a0);
  const x1 = cx + r1 * Math.cos(a1);
  const y1 = cy + r1 * Math.sin(a1);
  const xi0 = cx + r0 * Math.cos(a1);
  const yi0 = cy + r0 * Math.sin(a1);
  const xi1 = cx + r0 * Math.cos(a0);
  const yi1 = cy + r0 * Math.sin(a0);
  return `M${round(x0)} ${round(y0)} A${r1} ${r1} 0 ${large} 1 ${round(x1)} ${round(y1)} L${round(xi0)} ${round(yi0)} A${r0} ${r0} 0 ${large} 0 ${round(xi1)} ${round(yi1)} Z`;
}

function emptyScene(title: string, message: string): ChartScene {
  const nodes: ChartSceneNode[] = [];
  if (title) nodes.push(textNode(CHART_WIDTH / 2, 40, title, { size: 17, weight: 600 }));
  nodes.push(textNode(CHART_WIDTH / 2, CHART_HEIGHT / 2, message, { size: 14, opacity: 0.6 }));
  return { width: CHART_WIDTH, height: CHART_HEIGHT, label: title || "Chart", nodes, marks: [] };
}

type Plot = { left: number; right: number; top: number; bottom: number };

function axisNodes(
  data: ChartData,
  plot: Plot,
  scaleY: (value: number) => number,
  ticks: number[],
): ChartSceneNode[] {
  const nodes: ChartSceneNode[] = [];
  for (const tick of ticks) {
    const y = scaleY(tick);
    nodes.push({
      t: "line",
      x1: round(plot.left),
      y1: round(y),
      x2: round(plot.right),
      y2: round(y),
      stroke: AXIS_COLOR,
      strokeOpacity: tick === 0 ? 0.28 : 0.1,
    });
    nodes.push(
      textNode(plot.left - 8, y + 4, formatTick(tick), { anchor: "end", size: 11, opacity: 0.55 }),
    );
  }
  const step = data.categories.length > 0 ? (plot.right - plot.left) / data.categories.length : 0;
  const skip = Math.ceil(data.categories.length / 14);
  data.categories.forEach((category, index) => {
    if (index % skip !== 0) return;
    nodes.push(
      textNode(plot.left + step * (index + 0.5), plot.bottom + 18, truncateLabel(category, 12), {
        size: 11,
        opacity: 0.6,
      }),
    );
  });
  return nodes;
}

function barNodes(
  data: ChartData,
  plot: Plot,
  scaleY: (value: number) => number,
): { nodes: ChartSceneNode[]; marks: ChartMark[] } {
  const nodes: ChartSceneNode[] = [];
  const marks: ChartMark[] = [];
  const step = (plot.right - plot.left) / data.categories.length;
  const groupWidth = step * 0.7;
  const barWidth = groupWidth / data.series.length;
  const zero = scaleY(0);
  data.categories.forEach((category, categoryIndex) => {
    const groupStart = plot.left + step * categoryIndex + (step - groupWidth) / 2;
    data.series.forEach((series, seriesIndex) => {
      const value = series.values[categoryIndex];
      if (value === null || value === undefined) return;
      const y = scaleY(value);
      const rect = {
        x: round(groupStart + barWidth * seriesIndex),
        y: round(Math.min(y, zero)),
        w: round(Math.max(1, barWidth - 1.5)),
        h: round(Math.max(1, Math.abs(y - zero))),
      };
      nodes.push({ t: "rect", ...rect, rx: 2, fill: series.color });
      marks.push({
        kind: "rect",
        ...rect,
        category,
        series: series.name,
        value,
        color: series.color,
      });
    });
  });
  return { nodes, marks };
}

function stackedBarNodes(
  data: ChartData,
  plot: Plot,
  scaleY: (value: number) => number,
): { nodes: ChartSceneNode[]; marks: ChartMark[] } {
  const nodes: ChartSceneNode[] = [];
  const marks: ChartMark[] = [];
  const step = (plot.right - plot.left) / data.categories.length;
  const width = step * 0.62;
  data.categories.forEach((category, categoryIndex) => {
    let positive = 0;
    let negative = 0;
    data.series.forEach((series) => {
      const value = series.values[categoryIndex];
      if (value === null || value === undefined) return;
      const from = value >= 0 ? positive : negative;
      const to = from + value;
      if (value >= 0) positive = to;
      else negative = to;
      const y0 = scaleY(from);
      const y1 = scaleY(to);
      const rect = {
        x: round(plot.left + step * categoryIndex + (step - width) / 2),
        y: round(Math.min(y0, y1)),
        w: round(Math.max(1, width)),
        h: round(Math.max(1, Math.abs(y1 - y0))),
      };
      nodes.push({ t: "rect", ...rect, rx: 1, fill: series.color });
      marks.push({
        kind: "rect",
        ...rect,
        category,
        series: series.name,
        value,
        color: series.color,
      });
    });
  });
  return { nodes, marks };
}

function scatterNodes(
  data: ChartData,
  plot: Plot,
  scaleY: (value: number) => number,
): { nodes: ChartSceneNode[]; marks: ChartMark[] } {
  const nodes: ChartSceneNode[] = [];
  const marks: ChartMark[] = [];
  const xSeries = data.series[0];
  if (!xSeries) return { nodes, marks };
  const xValues = xSeries.values.filter((value): value is number => value !== null);
  const minX = Math.min(...xValues, 0);
  const maxX = Math.max(...xValues, 1);
  const spanX = maxX - minX || 1;
  const scaleX = (value: number) => plot.left + ((value - minX) / spanX) * (plot.right - plot.left);
  const ySeries = data.series.length > 1 ? data.series.slice(1) : data.series;
  for (const series of ySeries) {
    series.values.forEach((value, index) => {
      const rawX = data.series.length > 1 ? xSeries.values[index] : index;
      if (value === null || rawX === null || rawX === undefined) return;
      const x = round(scaleX(rawX));
      const y = round(scaleY(value));
      nodes.push({ t: "circle", cx: x, cy: y, r: 4, fill: series.color });
      marks.push({
        kind: "point",
        x,
        y,
        category: data.categories[index] ?? String(rawX),
        series: series.name,
        value,
        color: series.color,
      });
    });
  }
  return { nodes, marks };
}

function comboNodes(
  data: ChartData,
  plot: Plot,
  scaleY: (value: number) => number,
): { nodes: ChartSceneNode[]; marks: ChartMark[] } {
  const bars = { ...data, series: data.series.filter((series) => series.role === "bar") };
  const lines = { ...data, series: data.series.filter((series) => series.role === "line") };
  const barBody = bars.series.length ? barNodes(bars, plot, scaleY) : { nodes: [], marks: [] };
  const lineBody = lines.series.length
    ? lineNodes(lines, plot, scaleY, false)
    : { nodes: [], marks: [] };
  return {
    nodes: [...barBody.nodes, ...lineBody.nodes],
    marks: [...barBody.marks, ...lineBody.marks],
  };
}

function lineNodes(
  data: ChartData,
  plot: Plot,
  scaleY: (value: number) => number,
  area: boolean,
): { nodes: ChartSceneNode[]; marks: ChartMark[] } {
  const nodes: ChartSceneNode[] = [];
  const marks: ChartMark[] = [];
  const step = (plot.right - plot.left) / data.categories.length;
  const zero = scaleY(0);
  for (const series of data.series) {
    const points = data.categories.map((_, index) => {
      const value = series.values[index];
      if (value === null || value === undefined) return null;
      return { x: plot.left + step * (index + 0.5), y: scaleY(value) };
    });
    const segments: string[] = [];
    let open = false;
    for (const point of points) {
      if (!point) {
        open = false;
        continue;
      }
      segments.push(`${open ? "L" : "M"}${round(point.x)} ${round(point.y)}`);
      open = true;
    }
    if (segments.length === 0) continue;
    if (area) {
      const present = points.filter((point): point is { x: number; y: number } => point !== null);
      const first = present[0];
      const last = present[present.length - 1];
      if (first && last) {
        nodes.push({
          t: "path",
          d: `${segments.join(" ")} L${round(last.x)} ${round(zero)} L${round(first.x)} ${round(zero)} Z`,
          fill: series.color,
          fillOpacity: 0.16,
        });
      }
    }
    nodes.push({
      t: "path",
      d: segments.join(" "),
      fill: "none",
      stroke: series.color,
      strokeWidth: 2.5,
      round: true,
    });
    points.forEach((point, index) => {
      if (!point) return;
      nodes.push({
        t: "circle",
        cx: round(point.x),
        cy: round(point.y),
        r: 3,
        fill: series.color,
      });
      const value = series.values[index];
      if (value === null || value === undefined) return;
      marks.push({
        kind: "point",
        x: round(point.x),
        y: round(point.y),
        category: data.categories[index] ?? "",
        series: series.name,
        value,
        color: series.color,
      });
    });
  }
  return { nodes, marks };
}

function pieScene(data: ChartData): ChartScene {
  const series = data.series[0];
  if (!series) return emptyScene(data.title, "No data to chart");
  const slices = data.categories
    .map((label, index) => ({
      label,
      value: series.values[index],
      color: PALETTE[index % PALETTE.length] ?? "#3b82f6",
    }))
    .filter(
      (slice): slice is { label: string; value: number; color: string } =>
        slice.value !== null && slice.value !== undefined && slice.value > 0,
    );
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  if (total <= 0) return emptyScene(data.title, "No positive values to chart");
  const cx = CHART_WIDTH / 2;
  const cy = 250;
  const radius = 150;
  const inner = 78;
  const nodes: ChartSceneNode[] = [];
  const marks: ChartMark[] = [];
  if (data.title) nodes.push(textNode(CHART_WIDTH / 2, 34, data.title, { size: 17, weight: 600 }));
  let angle = -Math.PI / 2;
  for (const slice of slices) {
    const sweep = (slice.value / total) * Math.PI * 2;
    const end = angle + sweep;
    marks.push({
      kind: "slice",
      cx,
      cy,
      r0: inner,
      r1: radius,
      a0: angle,
      a1: end,
      percent: (slice.value / total) * 100,
      category: slice.label,
      series: series.name,
      value: slice.value,
      color: slice.color,
    });
    nodes.push({
      t: "path",
      d: slicePath({ cx, cy, r0: inner, r1: radius, a0: angle, a1: end }),
      fill: slice.color,
    });
    if (sweep > 0.25) {
      const mid = angle + sweep / 2;
      const labelRadius = (radius + inner) / 2;
      nodes.push(
        textNode(
          cx + labelRadius * Math.cos(mid),
          cy + labelRadius * Math.sin(mid) + 4,
          `${Math.round((slice.value / total) * 100)}%`,
          { size: 12, weight: 600, opacity: 0.95 },
        ),
      );
    }
    angle = end;
  }
  nodes.push(
    ...legendNodes(
      slices.map((slice) => ({ name: slice.label, color: slice.color })),
      CHART_HEIGHT - 20,
    ),
  );
  return {
    width: CHART_WIDTH,
    height: CHART_HEIGHT,
    label: data.title || "Pie chart",
    nodes,
    marks,
  };
}

export function buildChartScene(data: ChartData): ChartScene {
  if (data.status === "no-source") {
    return emptyScene(data.title, "Source spreadsheet is unavailable");
  }
  if (data.status === "empty") {
    return emptyScene(data.title, "No numeric data in the selected range");
  }
  if (data.type === "pie") {
    return pieScene(data);
  }
  const plot: Plot = {
    left: 64,
    right: CHART_WIDTH - 24,
    top: data.title ? 56 : 28,
    bottom: CHART_HEIGHT - 58,
  };
  let min = 0;
  let max = 0;
  if (data.type === "stacked-bar") {
    data.categories.forEach((_, index) => {
      let positive = 0;
      let negative = 0;
      for (const series of data.series) {
        const value = series.values[index] ?? 0;
        if (value >= 0) positive += value;
        else negative += value;
      }
      min = Math.min(min, negative);
      max = Math.max(max, positive);
    });
  } else {
    for (const series of data.series) {
      for (const value of series.values) {
        if (value === null || value === undefined) continue;
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
    }
  }
  const ticks = niceTicks(min, max, 5);
  const domainMin = Math.min(min, ticks[0] ?? 0);
  const domainMax = Math.max(max, ticks[ticks.length - 1] ?? 1);
  const span = domainMax - domainMin || 1;
  const scaleY = (value: number) =>
    plot.bottom - ((value - domainMin) / span) * (plot.bottom - plot.top);
  const nodes: ChartSceneNode[] = [];
  if (data.title) nodes.push(textNode(CHART_WIDTH / 2, 32, data.title, { size: 17, weight: 600 }));
  nodes.push(...axisNodes(data, plot, scaleY, ticks));
  const body =
    data.type === "bar"
      ? barNodes(data, plot, scaleY)
      : data.type === "stacked-bar"
        ? stackedBarNodes(data, plot, scaleY)
        : data.type === "scatter"
          ? scatterNodes(data, plot, scaleY)
          : data.type === "combo"
            ? comboNodes(data, plot, scaleY)
            : lineNodes(data, plot, scaleY, data.type === "area");
  nodes.push(...body.nodes);
  nodes.push(
    ...legendNodes(
      data.series.map((series) => ({ name: series.name, color: series.color })),
      CHART_HEIGHT - 20,
    ),
  );
  return {
    width: CHART_WIDTH,
    height: CHART_HEIGHT,
    label: data.title || `${data.type} chart`,
    nodes,
    marks: body.marks,
  };
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function serializeNode(node: ChartSceneNode): string {
  if (node.t === "rect") {
    return `<rect x="${node.x}" y="${node.y}" width="${node.w}" height="${node.h}"${node.rx ? ` rx="${node.rx}"` : ""} fill="${escapeXml(node.fill)}"${node.fillOpacity !== undefined ? ` fill-opacity="${node.fillOpacity}"` : ""} />`;
  }
  if (node.t === "line") {
    return `<line x1="${node.x1}" y1="${node.y1}" x2="${node.x2}" y2="${node.y2}" stroke="${escapeXml(node.stroke)}"${node.strokeOpacity !== undefined ? ` stroke-opacity="${node.strokeOpacity}"` : ""} />`;
  }
  if (node.t === "path") {
    return `<path d="${node.d}" fill="${escapeXml(node.fill)}"${node.fillOpacity !== undefined ? ` fill-opacity="${node.fillOpacity}"` : ""}${node.stroke ? ` stroke="${escapeXml(node.stroke)}"` : ""}${node.strokeWidth ? ` stroke-width="${node.strokeWidth}"` : ""}${node.round ? ` stroke-linejoin="round" stroke-linecap="round"` : ""} />`;
  }
  if (node.t === "circle") {
    return `<circle cx="${node.cx}" cy="${node.cy}" r="${node.r}" fill="${escapeXml(node.fill)}" />`;
  }
  return `<text x="${node.x}" y="${node.y}" fill="currentColor" fill-opacity="${node.opacity}" font-size="${node.size}" font-weight="${node.weight}" text-anchor="${node.anchor}" font-family="${FONT_FAMILY}">${escapeXml(node.text)}</text>`;
}

export function renderChartSvg(data: ChartData): string {
  const scene = buildChartScene(data);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${scene.width} ${scene.height}" width="100%" role="img" aria-label="${escapeXml(scene.label)}">`,
    ...scene.nodes.map(serializeNode),
    "</svg>",
  ].join("");
}
