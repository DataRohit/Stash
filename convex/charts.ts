import { v } from "convex/values";
import * as Y from "yjs";
import type { ChartSource } from "../lib/chart-data";
import { chartSourceFromSheet } from "../lib/doc-projection";
import { query } from "./_generated/server";
import { accessForProject, documentState, isInactiveTree } from "./documents";

export const sourceData = query({
  args: {
    projectId: v.id("projects"),
    sourceDocId: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args): Promise<{ source: ChartSource | null }> => {
    const access = await accessForProject(ctx, args.projectId);
    if (!access || !args.sourceDocId) {
      return { source: null };
    }
    const sourceId = ctx.db.normalizeId("documents", args.sourceDocId);
    const source = sourceId ? await ctx.db.get(sourceId) : null;
    if (
      source?.kind !== "file" ||
      source.projectId !== args.projectId ||
      source.fileType !== "sheet" ||
      (await isInactiveTree(ctx, source))
    ) {
      return { source: null };
    }
    const state = await documentState(ctx, source);
    if (!state) return { source: null };
    const sheet = new Y.Doc();
    Y.applyUpdate(sheet, new Uint8Array(state));
    const model = chartSourceFromSheet(sheet, source._id, source.name);
    sheet.destroy();
    return { source: model };
  },
});
