import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import { liveDocumentBytes } from "./documents";

const PROJECT_WALK_BATCH = 25;
const PROJECT_DOCUMENT_BATCH = 100;
const STORAGE_SWEEP_BATCH = 50;
const STORAGE_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

type ReconciliationResult = {
  projectId: Id<"projects">;
  scanned: number;
  accumulatedBytes: number;
  completed: boolean;
  restarted: boolean;
  stale: boolean;
  previousBytes: number | null;
  actualBytes: number | null;
  driftBytes: number | null;
  patched: boolean;
};

export const reconcileProjectBytes = internalMutation({
  args: {
    projectId: v.id("projects"),
    reconciliationId: v.optional(v.id("projectByteReconciliations")),
    generation: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<ReconciliationResult> => {
    const project = await ctx.db.get(args.projectId);
    if (!project) {
      if (args.reconciliationId) {
        const stale = await ctx.db.get(args.reconciliationId);
        if (stale) {
          await ctx.db.delete(stale._id);
        }
      }
      return {
        projectId: args.projectId,
        scanned: 0,
        accumulatedBytes: 0,
        completed: true,
        restarted: false,
        stale: false,
        previousBytes: null,
        actualBytes: null,
        driftBytes: null,
        patched: false,
      };
    }

    let reconciliation = args.reconciliationId
      ? await ctx.db.get(args.reconciliationId)
      : await ctx.db
          .query("projectByteReconciliations")
          .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
          .unique();

    if (
      reconciliation &&
      (reconciliation.projectId !== args.projectId ||
        (args.generation !== undefined && reconciliation.generation !== args.generation))
    ) {
      return {
        projectId: args.projectId,
        scanned: 0,
        accumulatedBytes: 0,
        completed: false,
        restarted: false,
        stale: true,
        previousBytes: project.totalBytes ?? null,
        actualBytes: null,
        driftBytes: null,
        patched: false,
      };
    }

    if (!args.reconciliationId) {
      const generation = (reconciliation?.generation ?? 0) + 1;
      const value = {
        projectId: args.projectId,
        generation,
        cursor: null,
        totalBytes: 0,
        startVersion: project.byteVersion ?? 0,
        scanned: 0,
        updatedAt: Date.now(),
      };
      if (reconciliation) {
        await ctx.db.patch(reconciliation._id, value);
      } else {
        const reconciliationId = await ctx.db.insert("projectByteReconciliations", value);
        reconciliation = await ctx.db.get(reconciliationId);
      }
      if (reconciliation) {
        reconciliation = { ...reconciliation, ...value };
      }
    }

    if (!reconciliation) {
      throw new Error("reconciliation-missing");
    }

    const currentVersion = project.byteVersion ?? 0;
    if (currentVersion !== reconciliation.startVersion) {
      const generation = reconciliation.generation + 1;
      await ctx.db.patch(reconciliation._id, {
        generation,
        cursor: null,
        totalBytes: 0,
        startVersion: currentVersion,
        scanned: 0,
        updatedAt: Date.now(),
      });
      await ctx.scheduler.runAfter(0, internal.maintenance.reconcileProjectBytes, {
        projectId: args.projectId,
        reconciliationId: reconciliation._id,
        generation,
      });
      return {
        projectId: args.projectId,
        scanned: 0,
        accumulatedBytes: 0,
        completed: false,
        restarted: true,
        stale: false,
        previousBytes: project.totalBytes ?? null,
        actualBytes: null,
        driftBytes: null,
        patched: false,
      };
    }

    const page = await ctx.db
      .query("documents")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .paginate({
        cursor: reconciliation.cursor,
        numItems: PROJECT_DOCUMENT_BATCH,
        maximumRowsRead: PROJECT_DOCUMENT_BATCH,
      });
    const pageBytes = liveDocumentBytes(page.page);
    const accumulatedBytes = reconciliation.totalBytes + pageBytes;
    const scanned = reconciliation.scanned + page.page.length;

    if (!page.isDone) {
      await ctx.db.patch(reconciliation._id, {
        cursor: page.continueCursor,
        totalBytes: accumulatedBytes,
        scanned,
        updatedAt: Date.now(),
      });
      await ctx.scheduler.runAfter(0, internal.maintenance.reconcileProjectBytes, {
        projectId: args.projectId,
        reconciliationId: reconciliation._id,
        generation: reconciliation.generation,
      });
      return {
        projectId: args.projectId,
        scanned: page.page.length,
        accumulatedBytes,
        completed: false,
        restarted: false,
        stale: false,
        previousBytes: project.totalBytes ?? null,
        actualBytes: null,
        driftBytes: null,
        patched: false,
      };
    }

    const previousBytes = project.totalBytes ?? null;
    const driftBytes = accumulatedBytes - (previousBytes ?? 0);
    const patched = previousBytes !== accumulatedBytes;
    if (patched) {
      await ctx.db.patch(project._id, { totalBytes: accumulatedBytes });
    }
    await ctx.db.delete(reconciliation._id);
    return {
      projectId: args.projectId,
      scanned: page.page.length,
      accumulatedBytes,
      completed: true,
      restarted: false,
      stale: false,
      previousBytes,
      actualBytes: accumulatedBytes,
      driftBytes,
      patched,
    };
  },
});

export const walkProjectBytes = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("projects")
      .withIndex("by_created")
      .paginate({
        cursor: args.cursor ?? null,
        numItems: PROJECT_WALK_BATCH,
        maximumRowsRead: PROJECT_WALK_BATCH,
      });
    for (const project of page.page) {
      await ctx.scheduler.runAfter(0, internal.maintenance.reconcileProjectBytes, {
        projectId: project._id,
      });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.maintenance.walkProjectBytes, {
        cursor: page.continueCursor,
      });
    }
    return {
      scheduled: page.page.length,
      isDone: page.isDone,
      nextCursor: page.isDone ? null : page.continueCursor,
    };
  },
});

export const sweepOrphanStorage = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    cutoff: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const cutoff = args.cutoff ?? Date.now() - STORAGE_ORPHAN_GRACE_MS;
    const dryRun = args.dryRun ?? true;
    const page = await ctx.db.system
      .query("_storage")
      .withIndex("by_creation_time", (q) => q.lte("_creationTime", cutoff))
      .paginate({
        cursor: args.cursor ?? null,
        numItems: STORAGE_SWEEP_BATCH,
        maximumRowsRead: STORAGE_SWEEP_BATCH,
      });
    let referenced = 0;
    let candidates = 0;
    let deleted = 0;
    for (const blob of page.page) {
      const document = await ctx.db
        .query("documents")
        .withIndex("by_storage", (q) => q.eq("storageId", blob._id))
        .first();
      const project = document
        ? null
        : await ctx.db
            .query("projects")
            .withIndex("by_image_storage", (q) => q.eq("imageStorageId", blob._id))
            .first();
      if (document || project) {
        referenced += 1;
        continue;
      }
      candidates += 1;
      if (!dryRun) {
        await ctx.storage.delete(blob._id);
        deleted += 1;
      }
    }
    if (!dryRun && !page.isDone) {
      await ctx.scheduler.runAfter(0, internal.maintenance.sweepOrphanStorage, {
        cursor: page.continueCursor,
        cutoff,
        dryRun: false,
      });
    }
    return {
      dryRun,
      cutoff,
      scanned: page.page.length,
      referenced,
      candidates,
      deleted,
      isDone: page.isDone,
      nextCursor: page.isDone ? null : page.continueCursor,
    };
  },
});
