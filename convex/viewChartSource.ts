import * as Y from "yjs";
import type { ChartSource } from "../lib/chart-data";
import { MAX_CHART_SOURCE_ROWS } from "../lib/chart-data";
import { inspectView } from "../lib/view-model";
import {
  aggregateViewRecords,
  applyViewFilters,
  type ViewRecordSummary,
} from "../lib/view-records";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { isInactiveTree } from "./documents";

export type ViewChartOptions = {
  groupPropertyId?: string | null;
  valuePropertyId?: string | null;
  aggregate?: "count" | "sum";
};

export async function viewChartSource(
  ctx: QueryCtx,
  projectId: Id<"projects">,
  sourceDoc: Doc<"documents">,
  state: ArrayBuffer,
  options: ViewChartOptions,
): Promise<ChartSource> {
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, new Uint8Array(state));
  const config = inspectView(ydoc);
  ydoc.destroy();
  const referenced = new Set(
    [
      ...config.filters.map((filter) => filter.propertyId),
      options.groupPropertyId ?? "",
      options.valuePropertyId ?? "",
    ].filter(Boolean),
  );
  const [propertyRows, documents] = await Promise.all([
    ctx.db
      .query("documentProperties")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect(),
    ctx.db
      .query("documents")
      .withIndex("by_project_kind", (q) => q.eq("projectId", projectId).eq("kind", "file"))
      .order("desc")
      .take(MAX_CHART_SOURCE_ROWS + 1),
  ]);
  const truncated = documents.length > MAX_CHART_SOURCE_ROWS;
  const candidates: Doc<"documents">[] = [];
  for (const document of documents.slice(0, MAX_CHART_SOURCE_ROWS)) {
    if (!(await isInactiveTree(ctx, document))) candidates.push(document);
  }
  const valuesByDocument = new Map<string, ViewRecordSummary["properties"]>();
  await Promise.all(
    [...referenced].map(async (propertyId) => {
      const id = ctx.db.normalizeId("documentProperties", propertyId);
      if (!id) return;
      const values = await ctx.db
        .query("documentPropertyValues")
        .withIndex("by_project_property", (q) => q.eq("projectId", projectId).eq("propertyId", id))
        .collect();
      for (const value of values) {
        const rows = valuesByDocument.get(value.documentId) ?? [];
        rows.push({
          propertyId: value.propertyId,
          displayValue: value.displayValue,
          dateValue: value.dateValue,
          dateEndValue: value.dateEndValue,
        });
        valuesByDocument.set(value.documentId, rows);
      }
    }),
  );
  const records: ViewRecordSummary[] = candidates.map((document) => ({
    id: document._id,
    name: document.name,
    fileType: document.fileType ?? null,
    updatedAt: document.updatedAt,
    properties: valuesByDocument.get(document._id) ?? [],
  }));
  const activeProperties = new Set(
    propertyRows.filter((property) => !property.deletedAt).map((property) => String(property._id)),
  );
  const filtered = applyViewFilters(records, config.filters, activeProperties);
  const groupDefinition = options.groupPropertyId
    ? propertyRows.find((property) => String(property._id) === options.groupPropertyId)
    : undefined;
  const entries = aggregateViewRecords(filtered, {
    ...options,
    groupOptions: groupDefinition?.options.map((option) => option.name),
  });
  return {
    documentId: sourceDoc._id,
    name: sourceDoc.name,
    columns: [
      { id: "group", name: "Group" },
      { id: "value", name: options.aggregate === "sum" ? "Total" : "Count" },
    ],
    rows: entries.map(([label, value], index) => ({
      id: `aggregate:${index}`,
      values: [label, String(value)],
    })),
    truncated,
  };
}
