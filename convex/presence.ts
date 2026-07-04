import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { accessForProject, requireProjectAccess } from "./documents";

const PRESENCE_TTL = 15 * 1000;
const PRESENCE_SWEEP_TTL = 60 * 1000;

export const heartbeat = mutation({
  args: {
    documentId: v.id("documents"),
    sessionId: v.string(),
    name: v.string(),
    email: v.union(v.string(), v.null()),
    color: v.string(),
    image: v.union(v.string(), v.null()),
    state: v.string(),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (doc?.kind !== "file") {
      return;
    }
    const access = await requireProjectAccess(ctx, doc.projectId);
    const existing = await ctx.db
      .query("presence")
      .withIndex("by_document_session", (q) =>
        q.eq("documentId", args.documentId).eq("sessionId", args.sessionId),
      )
      .unique();
    const row = {
      documentId: args.documentId,
      sessionId: args.sessionId.slice(0, 80),
      userId: access.userId,
      name: args.name.slice(0, 80),
      email: args.email?.slice(0, 120) ?? undefined,
      color: args.color.slice(0, 32),
      image: args.image,
      state: args.state.slice(0, 4096),
      lastSeen: Date.now(),
    };
    if (existing) {
      await ctx.db.patch(existing._id, row);
    } else {
      await ctx.db.insert("presence", row);
    }
  },
});

export const leave = mutation({
  args: {
    documentId: v.id("documents"),
    sessionId: v.string(),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (doc?.kind !== "file") {
      return;
    }
    await requireProjectAccess(ctx, doc.projectId);
    const existing = await ctx.db
      .query("presence")
      .withIndex("by_document_session", (q) =>
        q.eq("documentId", args.documentId).eq("sessionId", args.sessionId),
      )
      .unique();
    if (existing) {
      await ctx.db.delete(existing._id);
    }
  },
});

export const list = query({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (doc?.kind !== "file" || !(await accessForProject(ctx, doc.projectId))) {
      return [];
    }
    const cutoff = Date.now() - PRESENCE_TTL;
    const rows = await ctx.db
      .query("presence")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    const freshestByUser = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      if (row.lastSeen < cutoff) {
        continue;
      }
      const current = freshestByUser.get(row.userId);
      if (!current || row.lastSeen > current.lastSeen) {
        freshestByUser.set(row.userId, row);
      }
    }
    return [...freshestByUser.values()]
      .sort((a, b) => a.lastSeen - b.lastSeen)
      .map((row) => ({
        sessionId: row.sessionId ?? row.userId,
        userId: row.userId,
        name: row.name,
        email: row.email ?? null,
        color: row.color,
        image: row.image,
        state: row.state,
      }));
  },
});

export const sweepStale = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - PRESENCE_SWEEP_TTL;
    const rows = await ctx.db.query("presence").collect();
    for (const row of rows) {
      if (row.lastSeen < cutoff) {
        await ctx.db.delete(row._id);
      }
    }
  },
});
