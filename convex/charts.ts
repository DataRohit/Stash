import { v } from "convex/values";
import * as Y from "yjs";
import type { ChartSource } from "../lib/chart-data";
import { inspectChart } from "../lib/chart-model";
import { chartSourceFromSheet } from "../lib/doc-projection";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { query } from "./_generated/server";
import { accessForProject, documentState, isInactiveTree } from "./documents";
import { viewChartSource } from "./viewChartSource";

type SourceArgs = {
  projectId: Id<"projects">;
  sourceDocId: string | null;
  sourceType?: "sheet" | "view";
  groupPropertyId?: string | null;
  valuePropertyId?: string | null;
  aggregate?: "count" | "sum";
};

async function resolveSource(ctx: QueryCtx, args: SourceArgs): Promise<ChartSource | null> {
  if (!args.sourceDocId) return null;
  const sourceId = ctx.db.normalizeId("documents", args.sourceDocId);
  const source = sourceId ? await ctx.db.get(sourceId) : null;
  const sourceType = args.sourceType ?? "sheet";
  if (
    source?.kind !== "file" ||
    source.projectId !== args.projectId ||
    source.fileType !== sourceType ||
    (await isInactiveTree(ctx, source))
  ) {
    return null;
  }
  const state = await documentState(ctx, source);
  if (!state) return null;
  if (sourceType === "sheet") {
    const sheet = new Y.Doc();
    Y.applyUpdate(sheet, new Uint8Array(state));
    const model = chartSourceFromSheet(sheet, source._id, source.name);
    sheet.destroy();
    return model;
  }
  return await viewChartSource(ctx, args.projectId, source, state, {
    groupPropertyId: args.groupPropertyId,
    valuePropertyId: args.valuePropertyId,
    aggregate: args.aggregate ?? "count",
  });
}

export const sourceData = query({
  args: {
    projectId: v.id("projects"),
    sourceDocId: v.union(v.string(), v.null()),
    sourceType: v.optional(v.union(v.literal("sheet"), v.literal("view"))),
    groupPropertyId: v.optional(v.union(v.string(), v.null())),
    valuePropertyId: v.optional(v.union(v.string(), v.null())),
    aggregate: v.optional(v.union(v.literal("count"), v.literal("sum"))),
  },
  handler: async (ctx, args): Promise<{ source: ChartSource | null }> => {
    const access = await accessForProject(ctx, args.projectId);
    if (!access) return { source: null };
    return { source: await resolveSource(ctx, args) };
  },
});

export const dashboardChartData = query({
  args: { projectId: v.id("projects"), chartDocumentId: v.string() },
  handler: async (ctx, args) => {
    const access = await accessForProject(ctx, args.projectId);
    if (!access) return null;
    const id = ctx.db.normalizeId("documents", args.chartDocumentId);
    const document = id ? await ctx.db.get(id) : null;
    if (
      document?.kind !== "file" ||
      document.projectId !== args.projectId ||
      document.fileType !== "chart" ||
      (await isInactiveTree(ctx, document))
    ) {
      return { status: "missing" as const };
    }
    const state = await documentState(ctx, document);
    if (!state) return { status: "missing" as const };
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, new Uint8Array(state));
    const config = inspectChart(ydoc);
    ydoc.destroy();
    const source = await resolveSource(ctx, {
      projectId: args.projectId,
      sourceDocId: config.sourceDocId,
      sourceType: config.sourceType,
      groupPropertyId: config.groupPropertyId,
      valuePropertyId: config.valuePropertyId,
      aggregate: config.aggregate,
    });
    return { status: "ok" as const, config, source };
  },
});

export const dashboardStatData = query({
  args: {
    projectId: v.id("projects"),
    viewDocumentId: v.string(),
    aggregate: v.union(v.literal("count"), v.literal("sum")),
    propertyId: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const access = await accessForProject(ctx, args.projectId);
    if (!access) return null;
    const source = await resolveSource(ctx, {
      projectId: args.projectId,
      sourceDocId: args.viewDocumentId,
      sourceType: "view",
      aggregate: args.aggregate,
      valuePropertyId: args.propertyId,
    });
    if (!source) return { status: "missing" as const };
    const value = source.rows.reduce((sum, row) => sum + (Number(row.values[1]) || 0), 0);
    return { status: "ok" as const, value, truncated: source.truncated === true };
  },
});
