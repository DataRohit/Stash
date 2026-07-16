"use client";

import { Minus, Plus, RotateCcw } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useMemo, useRef, useState } from "react";
import type { ChartData } from "@/lib/chart-data";
import { buildChartScene, type ChartMark, type ChartSceneNode, slicePath } from "@/lib/chart-svg";
import { cn } from "@/lib/utils";

const CHART_TYPE_LABEL: Record<ChartData["type"], string> = {
  line: "Line chart",
  bar: "Bar chart",
  area: "Area chart",
  pie: "Pie chart",
};

const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
const POINT_RADIUS = 14;

function nodeKey(node: ChartSceneNode): string {
  if (node.t === "rect") return `rect:${node.x}:${node.y}:${node.w}:${node.h}`;
  if (node.t === "line") return `line:${node.x1}:${node.y1}:${node.x2}:${node.y2}`;
  if (node.t === "path") return `path:${node.d.length}:${node.d.slice(0, 24)}:${node.fill}`;
  if (node.t === "circle") return `circle:${node.cx}:${node.cy}:${node.r}`;
  return `text:${node.x}:${node.y}:${node.text}`;
}

function keyedNodes(nodes: ChartSceneNode[]): Array<{ key: string; node: ChartSceneNode }> {
  const seen = new Map<string, number>();
  return nodes.map((node) => {
    const base = nodeKey(node);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return { key: count === 0 ? base : `${base}#${count}`, node };
  });
}

function markKey(mark: ChartMark): string {
  return `${mark.kind}:${mark.category}:${mark.series}:${mark.value}`;
}

function normalizeAngle(angle: number): number {
  const full = Math.PI * 2;
  return ((angle % full) + full) % full;
}

function hitMark(marks: ChartMark[], x: number, y: number): ChartMark | null {
  let nearest: { mark: ChartMark; distance: number } | null = null;
  for (const mark of marks) {
    if (mark.kind === "rect") {
      if (x >= mark.x && x <= mark.x + mark.w && y >= mark.y && y <= mark.y + mark.h) {
        return mark;
      }
      continue;
    }
    if (mark.kind === "point") {
      const distance = Math.hypot(mark.x - x, mark.y - y);
      if (distance <= POINT_RADIUS && (!nearest || distance < nearest.distance)) {
        nearest = { mark, distance };
      }
      continue;
    }
    const distance = Math.hypot(x - mark.cx, y - mark.cy);
    if (distance < mark.r0 || distance > mark.r1) continue;
    const angle = normalizeAngle(Math.atan2(y - mark.cy, x - mark.cx));
    const start = normalizeAngle(mark.a0);
    const sweep = mark.a1 - mark.a0;
    if (normalizeAngle(angle - start) <= sweep) return mark;
  }
  return nearest?.mark ?? null;
}

function SceneNode({ node, dimmed }: { node: ChartSceneNode; dimmed: boolean }) {
  const fade = dimmed ? 0.25 : 1;
  if (node.t === "rect") {
    return (
      <rect
        x={node.x}
        y={node.y}
        width={node.w}
        height={node.h}
        rx={node.rx}
        fill={node.fill}
        fillOpacity={(node.fillOpacity ?? 1) * fade}
      />
    );
  }
  if (node.t === "line") {
    return (
      <line
        x1={node.x1}
        y1={node.y1}
        x2={node.x2}
        y2={node.y2}
        stroke={node.stroke}
        strokeOpacity={node.strokeOpacity}
      />
    );
  }
  if (node.t === "path") {
    return (
      <path
        d={node.d}
        fill={node.fill}
        fillOpacity={(node.fillOpacity ?? 1) * fade}
        stroke={node.stroke}
        strokeOpacity={fade}
        strokeWidth={node.strokeWidth}
        strokeLinejoin={node.round ? "round" : undefined}
        strokeLinecap={node.round ? "round" : undefined}
      />
    );
  }
  if (node.t === "circle") {
    return <circle cx={node.cx} cy={node.cy} r={node.r} fill={node.fill} fillOpacity={fade} />;
  }
  return (
    <text
      x={node.x}
      y={node.y}
      fill="currentColor"
      fillOpacity={node.opacity}
      fontSize={node.size}
      fontWeight={node.weight}
      textAnchor={node.anchor}
      fontFamily="ui-sans-serif, system-ui, sans-serif"
    >
      {node.text}
    </text>
  );
}

function Highlight({ mark }: { mark: ChartMark }) {
  if (mark.kind === "rect") {
    return (
      <rect
        x={mark.x - 1}
        y={mark.y - 1}
        width={mark.w + 2}
        height={mark.h + 2}
        rx={3}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeOpacity={0.9}
      />
    );
  }
  if (mark.kind === "point") {
    return (
      <circle
        cx={mark.x}
        cy={mark.y}
        r={6}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeOpacity={0.9}
      />
    );
  }
  return (
    <path
      d={slicePath(mark)}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeOpacity={0.9}
      strokeLinejoin="round"
    />
  );
}

export function ChartView({
  model,
  className,
  interactive = true,
}: {
  model: ChartData;
  className?: string;
  interactive?: boolean;
}) {
  const scene = useMemo(() => buildChartScene(model), [model]);
  const nodes = useMemo(() => keyedNodes(scene.nodes), [scene]);
  const svgRef = useRef<SVGSVGElement>(null);
  const panRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [hover, setHover] = useState<{ mark: ChartMark; left: number; top: number } | null>(null);

  const viewWidth = scene.width / zoom;
  const viewHeight = scene.height / zoom;
  const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), Math.max(0, max));
  const originX = clamp(offset.x, scene.width - viewWidth);
  const originY = clamp(offset.y, scene.height - viewHeight);

  const toScene = (event: { clientX: number; clientY: number }) => {
    const svg = svgRef.current;
    const matrix = svg?.getScreenCTM();
    if (!svg || !matrix || matrix.a === 0) return null;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    const rect = svg.getBoundingClientRect();
    return { x: point.x, y: point.y, scale: matrix.a, rect };
  };

  const zoomTo = (next: number) => {
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    setZoom(clamped);
    if (clamped === MIN_ZOOM) setOffset({ x: 0, y: 0 });
  };

  const reset = () => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    setHover(null);
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const pan = panRef.current;
    if (pan && pan.pointerId === event.pointerId) {
      const scale = svgRef.current?.getScreenCTM()?.a;
      if (!scale) return;
      const dx = (event.clientX - pan.x) / scale;
      const dy = (event.clientY - pan.y) / scale;
      panRef.current = { pointerId: pan.pointerId, x: event.clientX, y: event.clientY };
      setOffset((current) => ({
        x: clamp(current.x - dx, scene.width - viewWidth),
        y: clamp(current.y - dy, scene.height - viewHeight),
      }));
      return;
    }
    if (!interactive || scene.marks.length === 0) return;
    const point = toScene(event);
    if (!point) return;
    const mark = hitMark(scene.marks, point.x, point.y);
    setHover(
      mark
        ? {
            mark,
            left: event.clientX - point.rect.left,
            top: event.clientY - point.rect.top,
          }
        : null,
    );
  };

  const onWheel = (event: React.WheelEvent<SVGSVGElement>) => {
    if (!interactive) return;
    const point = toScene(event);
    if (!point) return;
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * (event.deltaY < 0 ? 1.2 : 1 / 1.2)));
    if (next === zoom) return;
    const nextWidth = scene.width / next;
    const nextHeight = scene.height / next;
    setZoom(next);
    setOffset({
      x: clamp(point.x - (point.x - originX) * (nextWidth / viewWidth), scene.width - nextWidth),
      y: clamp(
        point.y - (point.y - originY) * (nextHeight / viewHeight),
        scene.height - nextHeight,
      ),
    });
  };

  const zoomed = zoom > MIN_ZOOM;
  const activeKey = hover ? markKey(hover.mark) : null;

  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-background text-foreground", className)}>
      <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-hairline border-b px-4">
        <span className="truncate font-medium text-sm">
          {model.title || CHART_TYPE_LABEL[model.type]}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden font-mono text-[10px] text-muted-foreground uppercase tracking-widest sm:inline">
            {model.sourceName ? `Source · ${model.sourceName}` : "No source"}
          </span>
          {interactive && scene.marks.length > 0 ? (
            <div className="flex items-center gap-0.5 rounded-sm border border-hairline p-0.5">
              <button
                type="button"
                onClick={() => zoomTo(zoom / 1.5)}
                disabled={!zoomed}
                aria-label="Zoom out"
                className="flex size-6 cursor-pointer items-center justify-center rounded-xs text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Minus className="size-3.5" />
              </button>
              <span className="w-9 text-center font-mono text-[10px] text-muted-foreground tabular-nums">
                {Math.round(zoom * 100)}%
              </span>
              <button
                type="button"
                onClick={() => zoomTo(zoom * 1.5)}
                disabled={zoom >= MAX_ZOOM}
                aria-label="Zoom in"
                className="flex size-6 cursor-pointer items-center justify-center rounded-xs text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Plus className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={reset}
                disabled={!zoomed}
                aria-label="Reset zoom"
                className="flex size-6 cursor-pointer items-center justify-center rounded-xs text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              >
                <RotateCcw className="size-3.5" />
              </button>
            </div>
          ) : null}
        </div>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4">
        <svg
          ref={svgRef}
          viewBox={`${originX} ${originY} ${viewWidth} ${viewHeight}`}
          preserveAspectRatio="xMidYMid meet"
          className={cn(
            "size-full touch-none",
            zoomed ? "cursor-grab active:cursor-grabbing" : undefined,
          )}
          role="img"
          aria-label={scene.label}
          onWheel={onWheel}
          onPointerMove={onPointerMove}
          onPointerLeave={() => setHover(null)}
          onPointerDown={(event) => {
            if (!zoomed || event.button !== 0) return;
            panRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerUp={(event) => {
            if (panRef.current?.pointerId === event.pointerId) panRef.current = null;
          }}
          onPointerCancel={() => {
            panRef.current = null;
          }}
        >
          {nodes.map((entry) => (
            <SceneNode
              key={entry.key}
              node={entry.node}
              dimmed={Boolean(activeKey) && entry.node.t !== "text" && entry.node.t !== "line"}
            />
          ))}
          {hover ? <Highlight mark={hover.mark} /> : null}
        </svg>
        {hover ? (
          <div
            role="tooltip"
            className="pointer-events-none absolute z-10 max-w-56 -translate-x-1/2 -translate-y-[calc(100%+0.75rem)] rounded-md border border-hairline bg-surface px-2.5 py-1.5 shadow-xl"
            style={{ left: hover.left, top: hover.top }}
          >
            <p className="truncate font-medium text-xs">{hover.mark.category}</p>
            <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span
                aria-hidden="true"
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: hover.mark.color }}
              />
              <span className="truncate">{hover.mark.series}</span>
              <span className="ml-auto shrink-0 font-mono text-foreground tabular-nums">
                {hover.mark.value.toLocaleString()}
                {hover.mark.kind === "slice" ? ` · ${Math.round(hover.mark.percent)}%` : ""}
              </span>
            </p>
          </div>
        ) : null}
      </div>
      {model.droppedSeries > 0 || model.truncated ? (
        <div className="shrink-0 border-hairline border-t bg-warning/5 px-4 py-1.5 text-[11px] text-warning">
          {model.droppedSeries > 0
            ? `${model.droppedSeries} series reference a removed column and were skipped.`
            : null}
          {model.droppedSeries > 0 && model.truncated ? " " : null}
          {model.truncated ? "Source data was truncated for charting." : null}
        </div>
      ) : null}
    </div>
  );
}
