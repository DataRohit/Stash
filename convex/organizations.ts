import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { recordOrganizationEvent } from "./audit";
import { belongsToOrganization, isOrganizationAdmin } from "./auth";
import {
  clampInt,
  HARD_MAX_COLLABORATORS,
  HARD_MAX_GUESTS,
  HARD_MAX_HISTORY_RETENTION_DAYS,
  HARD_MAX_PROJECT_BYTES,
  HARD_MAX_PROJECTS,
  MIN_HISTORY_RETENTION_DAYS,
  MIN_PROJECT_BYTES,
} from "./limits";
import { secretMatches } from "./secrets";
import { enforceWriteRateLimit } from "./writeRateLimit";

const MAX_TAGS = 8;
const MAX_TAG_LENGTH = 24;
const MAX_DESCRIPTION_LENGTH = 280;
const ORG_PURGE_BATCH = 200;

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

async function requireOrgAdmin(ctx: QueryCtx, clerkOrgId: string) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new Error("Unauthenticated");
  }
  if (!isOrganizationAdmin(identity, clerkOrgId)) {
    throw new Error("Forbidden");
  }
  return identity;
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
    if (!identity || !belongsToOrganization(identity, args.clerkOrgId)) {
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
      offlineCachingEnabled: doc.offlineCachingEnabled === true,
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
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .collect();
    for (const project of projects) {
      if (!project.deletedAt) await ctx.db.patch(project._id, { deletedAt: Date.now() });
      await ctx.scheduler.runAfter(0, internal.projects.purgeBatch, { projectId: project._id });
    }
    const members = await ctx.db
      .query("members")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .collect();
    for (const member of members) await ctx.db.delete(member._id);
    const templates = await ctx.db
      .query("orgTemplates")
      .withIndex("by_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .collect();
    for (const template of templates) await ctx.db.delete(template._id);
    const existing = await findByClerkOrgId(ctx, args.clerkOrgId);
    if (existing) await ctx.db.delete(existing._id);
    await ctx.scheduler.runAfter(0, internal.organizations.purgeOrgResources, {
      clerkOrgId: args.clerkOrgId,
    });
  },
});

export const setPlanLimits = mutation({
  args: {
    secret: v.string(),
    clerkOrgId: v.string(),
    maxProjects: v.number(),
    maxCollaborators: v.number(),
    maxGuests: v.optional(v.number()),
    maxSizeBytes: v.number(),
    historyRetentionDays: v.number(),
  },
  handler: async (ctx, args) => {
    if (!secretMatches(args.secret, process.env.CONVEX_PURGE_SECRET)) {
      throw new Error("Forbidden");
    }
    const row = await ensureRow(ctx, args.clerkOrgId);
    if (!row) {
      return;
    }
    const next = {
      maxProjects: clampInt(args.maxProjects, 0, HARD_MAX_PROJECTS),
      maxCollaborators: clampInt(args.maxCollaborators, 0, HARD_MAX_COLLABORATORS),
      maxGuests: clampInt(args.maxGuests ?? 3, 0, HARD_MAX_GUESTS),
      maxSizeBytes: clampInt(args.maxSizeBytes, MIN_PROJECT_BYTES, HARD_MAX_PROJECT_BYTES),
      historyRetentionDays: clampInt(
        args.historyRetentionDays,
        MIN_HISTORY_RETENTION_DAYS,
        HARD_MAX_HISTORY_RETENTION_DAYS,
      ),
    };
    if (
      row.maxProjects === next.maxProjects &&
      row.maxCollaborators === next.maxCollaborators &&
      row.maxGuests === next.maxGuests &&
      row.maxSizeBytes === next.maxSizeBytes &&
      row.historyRetentionDays === next.historyRetentionDays
    ) {
      return;
    }
    await ctx.db.patch(row._id, {
      ...next,
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

export const setOfflineCaching = mutation({
  args: { clerkOrgId: v.string(), enabled: v.boolean() },
  handler: async (ctx, args) => {
    const identity = await requireOrgAdmin(ctx, args.clerkOrgId);
    const allowed = await enforceWriteRateLimit(
      ctx,
      "organization-offline-policy",
      args.clerkOrgId,
      identity.subject,
      { capacity: 10, refillPerSecond: 0.1 },
    );
    if (!allowed) throw new Error("rate-limited");
    const row = await ensureRow(ctx, args.clerkOrgId);
    if (!row || row.offlineCachingEnabled === args.enabled) {
      return;
    }
    await ctx.db.patch(row._id, {
      offlineCachingEnabled: args.enabled,
      updatedAt: Date.now(),
    });
    await recordOrganizationEvent(ctx, {
      clerkOrgId: args.clerkOrgId,
      actorUserId: identity.subject,
      actorName: identity.name ?? identity.email ?? identity.subject,
      kind: "organization.offline_policy_changed",
      targetId: row._id,
      targetName: args.enabled
        ? "Offline document access enabled"
        : "Offline document access disabled",
      metadata: JSON.stringify({ enabled: args.enabled }),
    });
  },
});

export const claimReconcile = mutation({
  args: { clerkOrgId: v.string(), staleMs: v.number() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || !isOrganizationAdmin(identity, args.clerkOrgId)) {
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
    if (!secretMatches(args.secret, process.env.CONVEX_PURGE_SECRET)) {
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
    await ctx.scheduler.runAfter(0, internal.organizations.purgeOrgResources, {
      clerkOrgId: args.clerkOrgId,
    });
  },
});

export const purgeOrgResources = internalMutation({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    const deliveries = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_org_time", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .take(ORG_PURGE_BATCH);
    for (const row of deliveries) await ctx.db.delete(row._id);
    if (deliveries.length) {
      await ctx.scheduler.runAfter(0, internal.organizations.purgeOrgResources, args);
      return;
    }
    const endpoints = await ctx.db
      .query("webhookEndpoints")
      .withIndex("by_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .take(ORG_PURGE_BATCH);
    for (const row of endpoints) await ctx.db.delete(row._id);
    if (endpoints.length) {
      await ctx.scheduler.runAfter(0, internal.organizations.purgeOrgResources, args);
      return;
    }
    const exports = await ctx.db
      .query("organizationExports")
      .withIndex("by_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .take(20);
    for (const row of exports) {
      for (const file of row.files ?? []) await ctx.storage.delete(file.storageId);
      if (row.manifestStorageId) await ctx.storage.delete(row.manifestStorageId);
      await ctx.db.delete(row._id);
    }
    if (exports.length) {
      await ctx.scheduler.runAfter(0, internal.organizations.purgeOrgResources, args);
      return;
    }
    const imports = await ctx.db
      .query("importJobs")
      .withIndex("by_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .take(ORG_PURGE_BATCH);
    for (const row of imports) await ctx.db.delete(row._id);
    if (imports.length) {
      await ctx.scheduler.runAfter(0, internal.organizations.purgeOrgResources, args);
      return;
    }
    const apiKeys = await ctx.db
      .query("apiKeys")
      .withIndex("by_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .take(ORG_PURGE_BATCH);
    for (const row of apiKeys) await ctx.db.delete(row._id);
    if (apiKeys.length) {
      await ctx.scheduler.runAfter(0, internal.organizations.purgeOrgResources, args);
      return;
    }
    const shares = await ctx.db
      .query("projectShares")
      .withIndex("by_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .take(ORG_PURGE_BATCH);
    for (const row of shares) await ctx.db.delete(row._id);
    if (shares.length) {
      await ctx.scheduler.runAfter(0, internal.organizations.purgeOrgResources, args);
      return;
    }
    const shareEvents = await ctx.db
      .query("projectShareEvents")
      .withIndex("by_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .take(ORG_PURGE_BATCH);
    for (const row of shareEvents) await ctx.db.delete(row._id);
    if (shareEvents.length) {
      await ctx.scheduler.runAfter(0, internal.organizations.purgeOrgResources, args);
      return;
    }
    const invitations = await ctx.db
      .query("guestInvitations")
      .withIndex("by_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .take(ORG_PURGE_BATCH);
    for (const row of invitations) await ctx.db.delete(row._id);
    if (invitations.length) {
      await ctx.scheduler.runAfter(0, internal.organizations.purgeOrgResources, args);
      return;
    }
    const events = await ctx.db
      .query("organizationEvents")
      .withIndex("by_org_time", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .take(ORG_PURGE_BATCH);
    for (const row of events) await ctx.db.delete(row._id);
    if (events.length)
      await ctx.scheduler.runAfter(0, internal.organizations.purgeOrgResources, args);
  },
});
