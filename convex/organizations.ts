import { v } from "convex/values";
import type { QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";

const MAX_TAGS = 8;
const MAX_TAG_LENGTH = 24;
const MAX_DESCRIPTION_LENGTH = 280;

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

export const get = query({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return null;
    }
    const doc = await findByClerkOrgId(ctx, args.clerkOrgId);
    if (!doc) {
      return null;
    }
    return { description: doc.description, tags: doc.tags };
  },
});

export const upsertDetails = mutation({
  args: {
    clerkOrgId: v.string(),
    description: v.string(),
    tags: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthenticated");
    }
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
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthenticated");
    }
    const existing = await findByClerkOrgId(ctx, args.clerkOrgId);
    if (existing) {
      await ctx.db.delete(existing._id);
    }
  },
});
