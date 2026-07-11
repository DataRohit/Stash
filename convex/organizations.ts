import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import {
  clampInt,
  HARD_MAX_COLLABORATORS,
  HARD_MAX_PROJECT_BYTES,
  HARD_MAX_PROJECTS,
  MIN_PROJECT_BYTES,
} from "./limits";

const MAX_TAGS = 8;
const MAX_TAG_LENGTH = 24;
const MAX_DESCRIPTION_LENGTH = 280;
const MIN_PURGE_SECRET_LENGTH = 32;

function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    if (tag.length === 0 || tag.length > MAX_TAG_LENGTH) {
      continue;
    }
    const key = tag.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(tag);
    if (result.length >= MAX_TAGS) {
      break;
    }
  }
  return result;
}

function findByClerkOrgId(ctx: QueryCtx, clerkOrgId: string) {
  return ctx.db
    .query("organizations")
    .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", clerkOrgId))
    .unique();
}

async function requireOrgAdmin(ctx: QueryCtx, clerkOrgId: string): Promise<void> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new Error("Unauthenticated");
  }
  if (identity.org_id !== clerkOrgId || identity.org_role !== "org:admin") {
    throw new Error("Forbidden");
  }
}

async function ensureRow(ctx: MutationCtx, clerkOrgId: string) {
  const existing = await findByClerkOrgId(ctx, clerkOrgId);
  if (existing) {
    return existing;
  }
  const id = await ctx.db.insert("organizations", {
    clerkOrgId,
    description: "",
    tags: [],
    updatedAt: Date.now(),
  });
  return await ctx.db.get(id);
}

export const get = query({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || identity.org_id !== args.clerkOrgId) {
      return null;
    }
    const doc = await findByClerkOrgId(ctx, args.clerkOrgId);
    if (!doc) {
      return null;
    }
    return {
      description: doc.description,
      tags: doc.tags,
      publicSharingEnabled: doc.publicSharingEnabled !== false,
    };
  },
});

export const upsertDetails = mutation({
  args: {
    clerkOrgId: v.string(),
    description: v.string(),
    tags: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOrgAdmin(ctx, args.clerkOrgId);
    const description = args.description.trim().slice(0, MAX_DESCRIPTION_LENGTH);
    const tags = normalizeTags(args.tags);
    const existing = await findByClerkOrgId(ctx, args.clerkOrgId);
    if (existing) {
      await ctx.db.patch(existing._id, { description, tags, updatedAt: Date.now() });
      return;
    }
    await ctx.db.insert("organizations", {
      clerkOrgId: args.clerkOrgId,
      description,
      tags,
      updatedAt: Date.now(),
    });
  },
});

export const remove = mutation({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    await requireOrgAdmin(ctx, args.clerkOrgId);
    const existing = await findByClerkOrgId(ctx, args.clerkOrgId);
    if (existing) {
      await ctx.db.delete(existing._id);
    }
  },
});

export const setPlanLimits = mutation({
  args: {
    clerkOrgId: v.string(),
    maxProjects: v.number(),
    maxCollaborators: v.number(),
    maxSizeBytes: v.number(),
  },
  handler: async (ctx, args) => {
    await requireOrgAdmin(ctx, args.clerkOrgId);
    const row = await ensureRow(ctx, args.clerkOrgId);
    if (!row) {
      return;
    }
    await ctx.db.patch(row._id, {
      maxProjects: clampInt(args.maxProjects, 0, HARD_MAX_PROJECTS),
      maxCollaborators: clampInt(args.maxCollaborators, 0, HARD_MAX_COLLABORATORS),
      maxSizeBytes: clampInt(args.maxSizeBytes, MIN_PROJECT_BYTES, HARD_MAX_PROJECT_BYTES),
      updatedAt: Date.now(),
    });
  },
});

export const setPublicSharing = mutation({
  args: { clerkOrgId: v.string(), enabled: v.boolean() },
  handler: async (ctx, args) => {
    await requireOrgAdmin(ctx, args.clerkOrgId);
    const row = await ensureRow(ctx, args.clerkOrgId);
    if (!row) {
      return;
    }
    await ctx.db.patch(row._id, {
      publicSharingEnabled: args.enabled,
      updatedAt: Date.now(),
    });
  },
});

export const claimReconcile = mutation({
  args: { clerkOrgId: v.string(), staleMs: v.number() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || identity.org_id !== args.clerkOrgId) {
      return false;
    }
    const now = Date.now();
    const row = await ensureRow(ctx, args.clerkOrgId);
    if (!row) {
      return false;
    }
    if (row.reconciledAt && now - row.reconciledAt < args.staleMs) {
      return false;
    }
    await ctx.db.patch(row._id, { reconciledAt: now });
    return true;
  },
});

export const purgeDeletedOrg = mutation({
  args: { clerkOrgId: v.string(), secret: v.string() },
  handler: async (ctx, args) => {
    const expected = process.env.CONVEX_PURGE_SECRET;
    if (
      !expected ||
      expected.length < MIN_PURGE_SECRET_LENGTH ||
      args.secret.length < MIN_PURGE_SECRET_LENGTH ||
      args.secret !== expected
    ) {
      throw new Error("Forbidden");
    }
    const members = await ctx.db
      .query("members")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .collect();
    for (const member of members) {
      await ctx.db.delete(member._id);
    }
    const templates = await ctx.db
      .query("orgTemplates")
      .withIndex("by_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .collect();
    for (const template of templates) await ctx.db.delete(template._id);
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .collect();
    for (const project of projects) {
      if (!project.deletedAt) {
        await ctx.db.patch(project._id, { deletedAt: Date.now() });
      }
      await ctx.scheduler.runAfter(0, internal.projects.purgeBatch, { projectId: project._id });
    }
    const row = await findByClerkOrgId(ctx, args.clerkOrgId);
    if (row) {
      await ctx.db.delete(row._id);
    }
  },
});
