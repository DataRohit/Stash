import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { recordOrganizationEvent } from "./audit";
import { accessForProject, requireProjectEditor, syncDocumentNode } from "./documents";

const MAX_IMPORT_ENTRIES = 1_000;
const MAX_MANIFEST_BYTES = 64 * 1024;

export const createJob = mutation({
  args: {
    projectId: v.id("projects"),
    source: v.union(v.literal("notion"), v.literal("confluence"), v.literal("google")),
    manifest: v.string(),
    totalEntries: v.number(),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectEditor(ctx, args.projectId);
    const totalEntries = Math.floor(args.totalEntries);
    if (totalEntries < 1 || totalEntries > MAX_IMPORT_ENTRIES) throw new Error("invalid-import");
    if (new TextEncoder().encode(args.manifest).byteLength > MAX_MANIFEST_BYTES)
      throw new Error("manifest-too-large");
    const active = await ctx.db
      .query("importJobs")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(20);
    if (active.some((job) => job.createdBy === access.userId && job.state === "running")) {
      throw new Error("import-already-running");
    }
    const now = Date.now();
    return await ctx.db.insert("importJobs", {
      clerkOrgId: access.project.clerkOrgId,
      projectId: args.projectId,
      source: args.source,
      state: "preview",
      manifest: args.manifest,
      totalEntries,
      processedEntries: 0,
      createdDocumentIds: [],
      createdBy: access.userId,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const start = mutation({
  args: { jobId: v.id("importJobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) throw new Error("not-found");
    const access = await requireProjectEditor(ctx, job.projectId);
    if (job.createdBy !== access.userId || job.state !== "preview")
      throw new Error("invalid-state");
    await ctx.db.patch(job._id, { state: "running", updatedAt: Date.now() });
  },
});

export const progress = mutation({
  args: {
    jobId: v.id("importJobs"),
    processedEntries: v.number(),
    createdDocumentIds: v.array(v.id("documents")),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) throw new Error("not-found");
    const access = await requireProjectEditor(ctx, job.projectId);
    if (job.createdBy !== access.userId || job.state !== "running")
      throw new Error("invalid-state");
    const processed = Math.floor(args.processedEntries);
    if (processed < job.processedEntries || processed > job.totalEntries)
      throw new Error("invalid-progress");
    const ids = [...new Set([...job.createdDocumentIds, ...args.createdDocumentIds])].slice(
      0,
      MAX_IMPORT_ENTRIES,
    );
    await ctx.db.patch(job._id, {
      processedEntries: processed,
      createdDocumentIds: ids,
      updatedAt: Date.now(),
    });
  },
});

export const finish = mutation({
  args: { jobId: v.id("importJobs"), reportDocumentId: v.optional(v.id("documents")) },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) throw new Error("not-found");
    const access = await requireProjectEditor(ctx, job.projectId);
    if (job.createdBy !== access.userId || job.state !== "running")
      throw new Error("invalid-state");
    await ctx.db.patch(job._id, {
      state: "completed",
      processedEntries: job.totalEntries,
      createdDocumentIds: args.reportDocumentId
        ? [...new Set([...job.createdDocumentIds, args.reportDocumentId])]
        : job.createdDocumentIds,
      updatedAt: Date.now(),
    });
    await recordOrganizationEvent(ctx, {
      clerkOrgId: job.clerkOrgId,
      actorUserId: access.userId,
      actorName: access.userId,
      kind: "import.completed",
      projectId: job.projectId,
      projectName: access.project.title,
      targetId: job._id,
      targetName: `${job.source} import`,
      metadata: JSON.stringify({ entries: job.totalEntries }),
    });
  },
});

export const fail = mutation({
  args: { jobId: v.id("importJobs"), error: v.string() },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return;
    const access = await requireProjectEditor(ctx, job.projectId);
    if (job.createdBy !== access.userId || job.state !== "running") return;
    await ctx.db.patch(job._id, {
      state: "failed",
      error: args.error.slice(0, 500),
      updatedAt: Date.now(),
    });
  },
});

export const cancel = mutation({
  args: { jobId: v.id("importJobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return;
    const access = await requireProjectEditor(ctx, job.projectId);
    if (job.createdBy !== access.userId || !["preview", "running", "failed"].includes(job.state)) {
      throw new Error("invalid-state");
    }
    const now = Date.now();
    for (const documentId of job.createdDocumentIds.slice(0, MAX_IMPORT_ENTRIES)) {
      const document = await ctx.db.get(documentId);
      if (document?.projectId === job.projectId && !document.trashedAt) {
        await ctx.db.patch(document._id, { trashedAt: now, updatedAt: now });
        await syncDocumentNode(ctx, document._id);
      }
    }
    await ctx.db.patch(job._id, { state: "cancelled", updatedAt: now });
  },
});

export const recent = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const access = await accessForProject(ctx, args.projectId);
    if (!access) return [];
    return (
      await ctx.db
        .query("importJobs")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .order("desc")
        .take(10)
    )
      .filter((job) => job.createdBy === access.userId || access.isAdmin)
      .map((job) => ({
        id: job._id,
        source: job.source,
        state: job.state,
        totalEntries: job.totalEntries,
        processedEntries: job.processedEntries,
        error: job.error,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      }));
  },
});
