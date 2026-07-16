import { useMemo } from "react";
import type { ChartData } from "@/lib/chart-data";
import { buildChartScene, type ChartSceneNode } from "@/lib/chart-svg";
import { cn } from "@/lib/utils";

const CHART_TYPE_LABEL: Record<ChartData["type"], string> = {
  line: "Line chart",
  bar: "Bar chart",
  area: "Area chart",
  pie: "Pie chart",
};

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

function SceneNode({ node }: { node: ChartSceneNode }) {
  if (node.t === "rect") {
    return (
      <rect
        x={node.x}
        y={node.y}
        width={node.w}
        height={node.h}
        rx={node.rx}
        fill={node.fill}
        fillOpacity={node.fillOpacity}
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
        fillOpacity={node.fillOpacity}
        stroke={node.stroke}
        strokeWidth={node.strokeWidth}
        strokeLinejoin={node.round ? "round" : undefined}
        strokeLinecap={node.round ? "round" : undefined}
      />
    );
  }
  if (node.t === "circle") {
    return <circle cx={node.cx} cy={node.cy} r={node.r} fill={node.fill} />;
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

export function ChartView({ model, className }: { model: ChartData; className?: string }) {
  const scene = useMemo(() => buildChartScene(model), [model]);
  const nodes = useMemo(() => keyedNodes(scene.nodes), [scene]);
  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-background text-foreground", className)}>
      <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-hairline border-b px-4">
        <span className="truncate font-medium text-sm">
          {model.title || CHART_TYPE_LABEL[model.type]}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
          {model.sourceName ? `Source · ${model.sourceName}` : "No source"}
        </span>
      </div>
      <div className="thin-scrollbar flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
        <svg
          viewBox={`0 0 ${scene.width} ${scene.height}`}
          className="mx-auto h-auto w-full max-w-3xl"
          role="img"
          aria-label={scene.label}
        >
          {nodes.map((entry) => (
            <SceneNode key={entry.key} node={entry.node} />
          ))}
        </svg>
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
