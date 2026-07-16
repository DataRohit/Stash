"use client";

import { useConvex } from "convex/react";
import {
  BarChart3,
  Download,
  FileSpreadsheet,
  FileText,
  Globe,
  Loader2,
  Package,
  Printer,
} from "lucide-react";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import type * as Y from "yjs";
import { referencedAssetIds } from "@/app/dashboard/projects/[id]/editor/lib/doc-html";
import {
  type BundleNode,
  exportBoardHtml,
  exportBoardMarkdown,
  exportBoardPdf,
  exportChartHtml,
  exportChartPdf,
  exportChartSvg,
  exportHtml,
  exportMarkdown,
  exportPdf,
  exportProjectZip,
  exportSheetCsv,
  exportSheetHtml,
  exportSheetPdf,
  exportViewCsv,
  exportViewHtml,
  exportViewPdf,
  type ViewExportModel,
} from "@/app/dashboard/projects/[id]/editor/lib/export-doc";
import type { TreeNode } from "@/app/dashboard/projects/[id]/editor/tree-utils";
import { useAnchoredPosition, useOutsideClose } from "@/components/ui/floating";
import { notify } from "@/components/ui/toast";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { type ChartData, resolveChartData } from "@/lib/chart-data";
import { inspectChart } from "@/lib/chart-model";
import { cn } from "@/lib/utils";
import { inspectView, type ViewFilter } from "@/lib/view-model";

type ExportMenuProps = {
  projectId: Id<"projects">;
  fileNode: TreeNode;
  content: string;
  nodes: TreeNode[];
  ydoc?: Y.Doc;
};

type Action = "md" | "csv" | "svg" | "html" | "pdf" | "zip";

export function ExportMenu({ projectId, fileNode, content, nodes, ydoc }: ExportMenuProps) {
  const convex = useConvex();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Action | null>(null);
  const floatingRef = useRef<HTMLDivElement>(null);
  const ref = useOutsideClose(() => setOpen(false), floatingRef);
  const position = useAnchoredPosition({
    open,
    anchorRef: ref,
    floatingRef,
    estimatedHeight: 400,
    requestedWidth: 240,
    align: "end",
  });

  const run = async (action: Action, task: () => Promise<void> | void) => {
    if (busy) {
      return;
    }
    setBusy(action);
    try {
      await task();
      if (action !== "pdf") {
        notify.success(action === "zip" ? "Project exported" : "Export ready");
      }
      setOpen(false);
    } catch (error) {
      const message = error instanceof Error && error.message === "empty-project";
      notify.error("Export failed", {
        description: message
          ? "This project has no files to export yet."
          : "Something went wrong preparing the download.",
      });
    } finally {
      setBusy(null);
    }
  };

  const exportZip = () =>
    run("zip", async () => {
      const bundle = await convex.query(api.documents.exportBundle, { projectId });
      if (!bundle) {
        throw new Error("empty-project");
      }
      await exportProjectZip(bundle.projectTitle, bundle.nodes as BundleNode[]);
    });

  const nodesWithRenderedAssets = async () => {
    const documentIds = referencedAssetIds(fileNode, content, nodes) as Id<"documents">[];
    if (documentIds.length === 0) {
      return nodes;
    }
    const assetUrls = await convex.query(api.documents.getAssetUrls, { documentIds });
    const urlById = new Map<string, string>(assetUrls.map((asset) => [asset.id, asset.url]));
    return nodes.map((node) => {
      const assetUrl = urlById.get(node.id);
      return assetUrl ? { ...node, assetUrl } : node;
    });
  };

  const isMd = fileNode.fileType === "md";
  const isSheet = fileNode.fileType === "sheet";
  const isBoard = fileNode.fileType === "board";
  const isView = fileNode.fileType === "view";
  const isChart = fileNode.fileType === "chart";

  const loadChartModel = async (): Promise<ChartData> => {
    if (!ydoc) throw new Error("chart-not-ready");
    const config = inspectChart(ydoc);
    const result = await convex.query(api.charts.sourceData, {
      projectId,
      sourceDocId: config.sourceDocId,
    });
    return resolveChartData(config, result.source);
  };

  const loadViewModel = async (): Promise<ViewExportModel> => {
    if (!ydoc) throw new Error("view-not-ready");
    const config = inspectView(ydoc);
    const properties = await convex.query(api.structuredSurfaces.listProperties, {
      projectId,
      includeDeleted: true,
    });
    const records: ViewExportModel["records"] = [];
    let cursor: string | null = null;
    let done = false;
    while (!done) {
      const page: {
        page: ViewExportModel["records"];
        isDone: boolean;
        continueCursor: string;
      } = await convex.query(api.structuredSurfaces.listRecords, {
        projectId,
        paginationOpts: { numItems: 50, cursor },
      });
      records.push(...page.page);
      done = page.isDone;
      cursor = page.continueCursor;
    }
    if (config.datePropertyId === "boardDue") {
      let cardCursor: string | null = null;
      let cardsDone = false;
      while (!cardsDone) {
        const page: {
          page: Array<{
            id: string;
            name: string;
            fileType: "card";
            updatedAt: number;
            boardDue?: number;
          }>;
          isDone: boolean;
          continueCursor: string;
        } = await convex.query(api.structuredSurfaces.listBoardCardRecords, {
          projectId,
          paginationOpts: { numItems: 50, cursor: cardCursor },
        });
        records.push(
          ...page.page.map((card) => ({
            id: card.id,
            name: card.name,
            fileType: card.fileType,
            updatedAt: card.updatedAt,
            properties: [
              {
                propertyId: "boardDue",
                displayValue: card.boardDue ? new Date(card.boardDue).toISOString() : "",
                dateValue: card.boardDue,
              },
            ],
          })),
        );
        cardsDone = page.isDone;
        cardCursor = page.continueCursor;
      }
    }
    const valueFor = (record: ViewExportModel["records"][number], propertyId: string) => {
      if (propertyId === "title") return record.name;
      if (propertyId === "fileType") return record.fileType ?? "Unknown";
      if (propertyId === "updatedAt") return String(record.updatedAt);
      return record.properties.find((value) => value.propertyId === propertyId)?.displayValue ?? "";
    };
    const matches = (record: ViewExportModel["records"][number], filter: ViewFilter) => {
      const value = valueFor(record, filter.propertyId);
      const left = value.toLocaleLowerCase();
      const right = filter.value.trim().toLocaleLowerCase();
      if (filter.operator === "is-empty") return value.length === 0;
      if (filter.operator === "is-not-empty") return value.length > 0;
      if (filter.operator === "contains") return left.includes(right);
      if (filter.operator === "equals") return left === right;
      if (filter.operator === "not-equals") return left !== right;
      const propertyValue = record.properties.find(
        (property) => property.propertyId === filter.propertyId,
      );
      const numeric =
        filter.propertyId === "updatedAt"
          ? record.updatedAt
          : filter.operator === "before"
            ? (propertyValue?.dateEndValue ?? propertyValue?.dateValue ?? Date.parse(value))
            : (propertyValue?.dateValue ?? Date.parse(value));
      const target = Date.parse(filter.value);
      if (!Number.isFinite(numeric) || !Number.isFinite(target)) return false;
      return filter.operator === "before" ? numeric < target : numeric > target;
    };
    const activeProperties = new Set(
      properties.filter((property) => !property.deleted).map((property) => String(property.id)),
    );
    const builtinProperties = new Set([
      "title",
      "fileType",
      "updatedAt",
      "boardDue",
      "boardColumn",
    ]);
    const filtered = records.filter((record) =>
      config.filters.every(
        (filter) =>
          (!builtinProperties.has(filter.propertyId) && !activeProperties.has(filter.propertyId)) ||
          matches(record, filter),
      ),
    );
    filtered.sort((left, right) => {
      for (const sort of config.sorts) {
        if (!builtinProperties.has(sort.propertyId) && !activeProperties.has(sort.propertyId)) {
          continue;
        }
        const result = valueFor(left, sort.propertyId).localeCompare(
          valueFor(right, sort.propertyId),
          undefined,
          { numeric: true, sensitivity: "base" },
        );
        if (result !== 0) return sort.direction === "asc" ? result : -result;
      }
      return left.name.localeCompare(right.name);
    });
    return { config, properties, records: filtered };
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label="Export"
        aria-pressed={open}
        className={cn(
          "flex size-8 cursor-pointer items-center justify-center rounded-sm border border-hairline transition-colors",
          open
            ? "bg-foreground/[0.08] text-foreground"
            : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground",
        )}
      >
        {busy ? (
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        ) : (
          <Download className="size-4" aria-hidden="true" />
        )}
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={floatingRef}
              className="fixed z-[180] overflow-hidden rounded-lg border border-hairline bg-surface p-1 shadow-xl"
              style={position}
            >
              <p className="px-2 py-1.5 font-medium font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
                Export this file
              </p>
              {isMd ? (
                <ExportItem
                  icon={<FileText className="size-4 text-accent" aria-hidden="true" />}
                  label="Markdown"
                  hint=".md"
                  loading={busy === "md"}
                  disabled={Boolean(busy)}
                  onClick={() => run("md", () => exportMarkdown(fileNode, content))}
                />
              ) : null}
              {isBoard && ydoc ? (
                <ExportItem
                  icon={<FileText className="size-4 text-accent" aria-hidden="true" />}
                  label="Board as Markdown"
                  hint=".md"
                  loading={busy === "md"}
                  disabled={Boolean(busy)}
                  onClick={() => run("md", () => exportBoardMarkdown(fileNode, ydoc))}
                />
              ) : null}
              {isSheet && ydoc ? (
                <ExportItem
                  icon={<FileSpreadsheet className="size-4 text-accent" aria-hidden="true" />}
                  label="Spreadsheet"
                  hint=".csv"
                  loading={busy === "csv"}
                  disabled={Boolean(busy)}
                  onClick={() => run("csv", () => exportSheetCsv(fileNode, ydoc))}
                />
              ) : null}
              {isView && ydoc ? (
                <ExportItem
                  icon={<FileSpreadsheet className="size-4 text-accent" aria-hidden="true" />}
                  label="View records"
                  hint=".csv"
                  loading={busy === "csv"}
                  disabled={Boolean(busy)}
                  onClick={() =>
                    run("csv", async () => exportViewCsv(fileNode, await loadViewModel()))
                  }
                />
              ) : null}
              {isChart && ydoc ? (
                <ExportItem
                  icon={<BarChart3 className="size-4 text-warning" aria-hidden="true" />}
                  label="Chart image"
                  hint=".svg"
                  loading={busy === "svg"}
                  disabled={Boolean(busy)}
                  onClick={() =>
                    run("svg", async () => exportChartSvg(fileNode, await loadChartModel()))
                  }
                />
              ) : null}
              <ExportItem
                icon={<Globe className="size-4 text-info" aria-hidden="true" />}
                label="Web page"
                hint=".html"
                loading={busy === "html"}
                disabled={Boolean(busy)}
                onClick={() =>
                  run("html", async () =>
                    isSheet && ydoc
                      ? exportSheetHtml(fileNode, ydoc)
                      : isBoard && ydoc
                        ? exportBoardHtml(fileNode, ydoc)
                        : isView && ydoc
                          ? exportViewHtml(fileNode, await loadViewModel())
                          : isChart && ydoc
                            ? exportChartHtml(fileNode, await loadChartModel())
                            : exportHtml(fileNode, content, await nodesWithRenderedAssets()),
                  )
                }
              />
              <ExportItem
                icon={<Printer className="size-4 text-warning" aria-hidden="true" />}
                label="Print / PDF"
                hint="print"
                loading={busy === "pdf"}
                disabled={Boolean(busy)}
                onClick={() =>
                  run("pdf", async () =>
                    isSheet && ydoc
                      ? exportSheetPdf(fileNode, ydoc)
                      : isBoard && ydoc
                        ? exportBoardPdf(fileNode, ydoc)
                        : isView && ydoc
                          ? exportViewPdf(fileNode, await loadViewModel())
                          : isChart && ydoc
                            ? exportChartPdf(fileNode, await loadChartModel())
                            : exportPdf(fileNode, content, await nodesWithRenderedAssets()),
                  )
                }
              />
              <div className="my-1 h-px bg-hairline" />
              <p className="px-2 py-1.5 font-medium font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
                Export project
              </p>
              <ExportItem
                icon={<Package className="size-4 text-muted-foreground" aria-hidden="true" />}
                label="Whole project"
                hint=".zip"
                loading={busy === "zip"}
                disabled={Boolean(busy)}
                onClick={exportZip}
              />
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function ExportItem({
  icon,
  label,
  hint,
  loading,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  loading: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-foreground/[0.04] disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="flex size-5 shrink-0 items-center justify-center">
        {loading ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
        {hint}
      </span>
    </button>
  );
}
