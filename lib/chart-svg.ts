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

export type ChartScene = {
  width: number;
  height: number;
  label: string;
  nodes: ChartSceneNode[];
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

function emptyScene(title: string, message: string): ChartScene {
  const nodes: ChartSceneNode[] = [];
  if (title) nodes.push(textNode(CHART_WIDTH / 2, 40, title, { size: 17, weight: 600 }));
  nodes.push(textNode(CHART_WIDTH / 2, CHART_HEIGHT / 2, message, { size: 14, opacity: 0.6 }));
  return { width: CHART_WIDTH, height: CHART_HEIGHT, label: title || "Chart", nodes };
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
): ChartSceneNode[] {
  const nodes: ChartSceneNode[] = [];
  const step = (plot.right - plot.left) / data.categories.length;
  const groupWidth = step * 0.7;
  const barWidth = groupWidth / data.series.length;
  const zero = scaleY(0);
  data.categories.forEach((_, categoryIndex) => {
    const groupStart = plot.left + step * categoryIndex + (step - groupWidth) / 2;
    data.series.forEach((series, seriesIndex) => {
      const value = series.values[categoryIndex];
      if (value === null || value === undefined) return;
      const y = scaleY(value);
      nodes.push({
        t: "rect",
        x: round(groupStart + barWidth * seriesIndex),
        y: round(Math.min(y, zero)),
        w: round(Math.max(1, barWidth - 1.5)),
        h: round(Math.max(1, Math.abs(y - zero))),
        rx: 2,
        fill: series.color,
      });
    });
  });
  return nodes;
}

function lineNodes(
  data: ChartData,
  plot: Plot,
  scaleY: (value: number) => number,
  area: boolean,
): ChartSceneNode[] {
  const nodes: ChartSceneNode[] = [];
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
    for (const point of points) {
      if (point)
        nodes.push({
          t: "circle",
          cx: round(point.x),
          cy: round(point.y),
          r: 3,
          fill: series.color,
        });
    }
  }
  return nodes;
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
  if (data.title) nodes.push(textNode(CHART_WIDTH / 2, 34, data.title, { size: 17, weight: 600 }));
  let angle = -Math.PI / 2;
  for (const slice of slices) {
    const sweep = (slice.value / total) * Math.PI * 2;
    const end = angle + sweep;
    const large = sweep > Math.PI ? 1 : 0;
    const x0 = cx + radius * Math.cos(angle);
    const y0 = cy + radius * Math.sin(angle);
    const x1 = cx + radius * Math.cos(end);
    const y1 = cy + radius * Math.sin(end);
    const xi0 = cx + inner * Math.cos(end);
    const yi0 = cy + inner * Math.sin(end);
    const xi1 = cx + inner * Math.cos(angle);
    const yi1 = cy + inner * Math.sin(angle);
    nodes.push({
      t: "path",
      d: `M${round(x0)} ${round(y0)} A${radius} ${radius} 0 ${large} 1 ${round(x1)} ${round(y1)} L${round(xi0)} ${round(yi0)} A${inner} ${inner} 0 ${large} 0 ${round(xi1)} ${round(yi1)} Z`,
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
  return { width: CHART_WIDTH, height: CHART_HEIGHT, label: data.title || "Pie chart", nodes };
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
  for (const series of data.series) {
    for (const value of series.values) {
      if (value === null || value === undefined) continue;
      min = Math.min(min, value);
      max = Math.max(max, value);
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
  nodes.push(
    ...(data.type === "bar"
      ? barNodes(data, plot, scaleY)
      : lineNodes(data, plot, scaleY, data.type === "area")),
  );
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
