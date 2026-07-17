import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { accessForProject, isInactiveTree } from "./documents";
import { enforceWriteRateLimit } from "./writeRateLimit";

const WATCH_WRITE_LIMIT = { capacity: 30, refillPerSecond: 1 };
const UNREAD_LIMIT = 200;

export const getState = query({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (!doc || doc.kind === "folder" || (await isInactiveTree(ctx, doc))) return null;
    const access = await accessForProject(ctx, doc.projectId);
    if (!access) return null;
    const [watch, preference] = await Promise.all([
      ctx.db
        .query("documentWatches")
        .withIndex("by_document_user", (q) =>
          q.eq("documentId", doc._id).eq("userId", access.userId),
        )
        .unique(),
      ctx.db
        .query("watchPreferences")
        .withIndex("by_user_org", (q) =>
          q.eq("userId", access.userId).eq("clerkOrgId", doc.clerkOrgId),
        )
        .unique(),
    ]);
    return { watching: Boolean(watch), autoWatch: preference?.autoWatch ?? true };
  },
});

export const setWatching = mutation({
  args: { documentId: v.id("documents"), watching: v.boolean() },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (!doc || doc.kind === "folder" || (await isInactiveTree(ctx, doc))) {
      throw new Error("not-found");
    }
    const access = await accessForProject(ctx, doc.projectId);
    if (!access) throw new Error("forbidden");
    if (!(await enforceWriteRateLimit(ctx, "watches", doc._id, access.userId, WATCH_WRITE_LIMIT))) {
      throw new Error("rate-limited");
    }
    const rows = await ctx.db
      .query("documentWatches")
      .withIndex("by_document_user", (q) => q.eq("documentId", doc._id).eq("userId", access.userId))
      .collect();
    if (args.watching && rows.length === 0) {
      await ctx.db.insert("documentWatches", {
        clerkOrgId: doc.clerkOrgId,
        userId: access.userId,
        projectId: doc.projectId,
        documentId: doc._id,
        createdAt: Date.now(),
      });
    }
    if (!args.watching) {
      for (const row of rows) await ctx.db.delete(row._id);
    }
    return args.watching;
  },
});

export const setAutoWatch = mutation({
  args: { clerkOrgId: v.string(), autoWatch: v.boolean() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || identity.org_id !== args.clerkOrgId) throw new Error("forbidden");
    const existing = await ctx.db
      .query("watchPreferences")
      .withIndex("by_user_org", (q) =>
        q.eq("userId", identity.subject).eq("clerkOrgId", args.clerkOrgId),
      )
      .unique();
    const value = {
      clerkOrgId: args.clerkOrgId,
      userId: identity.subject,
      autoWatch: args.autoWatch,
      updatedAt: Date.now(),
    };
    if (existing) await ctx.db.patch(existing._id, value);
    else await ctx.db.insert("watchPreferences", value);
  },
});

export const getPreferences = query({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || identity.org_id !== args.clerkOrgId) return null;
    const row = await ctx.db
      .query("watchPreferences")
      .withIndex("by_user_org", (q) =>
        q.eq("userId", identity.subject).eq("clerkOrgId", args.clerkOrgId),
      )
      .unique();
    return { autoWatch: row?.autoWatch ?? true };
  },
});

export const listUnread = query({
  args: { projectId: v.optional(v.id("projects")), documentIds: v.array(v.id("documents")) },
  handler: async (ctx, args) => {
    if (args.documentIds.length > UNREAD_LIMIT) throw new Error("too-many-items");
    const identity = await ctx.auth.getUserIdentity();
    if (!identity?.org_id) return { documentIds: [], projectIds: [] };
    const requested = new Set<Id<"documents">>(args.documentIds);
    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_recipient_org_read", (q) =>
        q
          .eq("recipientUserId", identity.subject)
          .eq("clerkOrgId", identity.org_id as string)
          .eq("readAt", null),
      )
      .order("desc")
      .take(UNREAD_LIMIT);
    const documentIds = new Set<Id<"documents">>();
    const projectIds = new Set<Id<"projects">>();
    for (const row of rows) {
      if (row.actorUserId === identity.subject) continue;
      if (args.projectId && row.projectId !== args.projectId) continue;
      if (requested.size > 0 && !requested.has(row.documentId)) continue;
      const doc = await ctx.db.get(row.documentId);
      if (
        !doc ||
        (await isInactiveTree(ctx, doc)) ||
        !(await accessForProject(ctx, row.projectId))
      ) {
        continue;
      }
      documentIds.add(row.documentId);
      projectIds.add(row.projectId);
    }
    return { documentIds: [...documentIds], projectIds: [...projectIds] };
  },
});
