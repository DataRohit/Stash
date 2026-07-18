import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { DEFAULT_MAX_COLLABORATORS, DEFAULT_MAX_PROJECT_BYTES } from "./limits";
import { secretMatches } from "./secrets";

const PAGE_MAX = 100;
const USAGE_PROJECT_MAX = 500;
const ACTIVITY_SAMPLE_MAX = 2_000;

export type OrganizationEventInput = {
  clerkOrgId: string;
  actorUserId: string | null;
  actorName: string;
  kind: string;
  projectId?: Id<"projects">;
  projectName?: string;
  targetId?: string;
  targetName: string;
  metadata?: string;
  createdAt?: number;
};

export async function recordOrganizationEvent(
  ctx: MutationCtx,
  input: OrganizationEventInput,
): Promise<Id<"organizationEvents">> {
  const eventId = await ctx.db.insert("organizationEvents", {
    clerkOrgId: input.clerkOrgId,
    actorUserId: input.actorUserId,
    actorName: input.actorName.slice(0, 160),
    kind: input.kind.slice(0, 80),
    projectId: input.projectId,
    projectName: input.projectName?.slice(0, 160),
    targetId: input.targetId?.slice(0, 160),
    targetName: input.targetName.slice(0, 240),
    metadata: input.metadata?.slice(0, 4_000),
    createdAt: input.createdAt ?? Date.now(),
  });
  const endpoints = await ctx.db
    .query("webhookEndpoints")
    .withIndex("by_org", (q) => q.eq("clerkOrgId", input.clerkOrgId))
    .take(25);
  const now = Date.now();
  for (const endpoint of endpoints) {
    if (endpoint.disabledAt || !endpoint.eventKinds.includes(input.kind)) continue;
    const existing = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_event_endpoint", (q) =>
        q.eq("eventId", eventId).eq("endpointId", endpoint._id),
      )
      .unique();
    if (existing) continue;
    await ctx.db.insert("webhookDeliveries", {
      clerkOrgId: input.clerkOrgId,
      endpointId: endpoint._id,
      eventId,
      eventKind: input.kind,
      state: "pending",
      attemptCount: 0,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }
  return eventId;
}

async function requireAdmin(ctx: QueryCtx, clerkOrgId: string): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity || identity.org_id !== clerkOrgId || identity.org_role !== "org:admin") {
    throw new Error("Forbidden");
  }
  return identity.subject;
}

export const recordInternal = internalMutation({
  args: {
    clerkOrgId: v.string(),
    actorUserId: v.union(v.string(), v.null()),
    actorName: v.string(),
    kind: v.string(),
    projectId: v.optional(v.id("projects")),
    projectName: v.optional(v.string()),
    targetId: v.optional(v.string()),
    targetName: v.string(),
    metadata: v.optional(v.string()),
    createdAt: v.optional(v.number()),
  },
  handler: recordOrganizationEvent,
});

export const recordTrusted = mutation({
  args: {
    secret: v.string(),
    clerkOrgId: v.string(),
    actorUserId: v.union(v.string(), v.null()),
    actorName: v.string(),
    kind: v.string(),
    targetId: v.optional(v.string()),
    targetName: v.string(),
    metadata: v.optional(v.string()),
    createdAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (!secretMatches(args.secret, process.env.CONVEX_PURGE_SECRET)) {
      throw new Error("Forbidden");
    }
    return await recordOrganizationEvent(ctx, {
      clerkOrgId: args.clerkOrgId,
      actorUserId: args.actorUserId,
      actorName: args.actorName,
      kind: args.kind,
      targetId: args.targetId,
      targetName: args.targetName,
      metadata: args.metadata,
      createdAt: args.createdAt,
    });
  },
});

export const list = query({
  args: {
    clerkOrgId: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
    kind: v.optional(v.string()),
    actorUserId: v.optional(v.string()),
    projectId: v.optional(v.id("projects")),
    from: v.optional(v.number()),
    to: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.clerkOrgId);
    const limit = Math.max(1, Math.min(PAGE_MAX, Math.floor(args.limit ?? 50)));
    const page = await ctx.db
      .query("organizationEvents")
      .withIndex("by_org_time", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .order("desc")
      .filter((q) =>
        q.and(
          args.kind ? q.eq(q.field("kind"), args.kind) : true,
          args.actorUserId ? q.eq(q.field("actorUserId"), args.actorUserId) : true,
          args.projectId ? q.eq(q.field("projectId"), args.projectId) : true,
          args.from ? q.gte(q.field("createdAt"), args.from) : true,
          args.to ? q.lte(q.field("createdAt"), args.to) : true,
        ),
      )
      .paginate({ cursor: args.cursor ?? null, numItems: limit, maximumRowsRead: limit * 5 });
    return {
      items: page.page.map((event) => ({
        id: event._id,
        actorUserId: event.actorUserId,
        actorName: event.actorName,
        kind: event.kind,
        projectId: event.projectId,
        projectName: event.projectName,
        targetId: event.targetId,
        targetName: event.targetName,
        metadata: event.metadata,
        createdAt: event.createdAt,
      })),
      nextCursor: page.isDone ? null : page.continueCursor,
    };
  },
});

export const filterOptions = query({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.clerkOrgId);
    const events = await ctx.db
      .query("organizationEvents")
      .withIndex("by_org_time", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .order("desc")
      .take(ACTIVITY_SAMPLE_MAX);
    const actors = new Map<string, string>();
    const projects = new Map<string, string>();
    for (const event of events) {
      if (event.actorUserId && !actors.has(event.actorUserId)) {
        actors.set(event.actorUserId, event.actorName);
      }
      if (event.projectId && !projects.has(event.projectId)) {
        projects.set(event.projectId, event.projectName ?? "Untitled project");
      }
    }
    return {
      actors: [...actors].map(([id, name]) => ({ id, name })).slice(0, 250),
      projects: [...projects].map(([id, name]) => ({ id, name })).slice(0, 250),
    };
  },
});

export const usage = query({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.clerkOrgId);
    const [organization, projects, members, recentEvents] = await Promise.all([
      ctx.db
        .query("organizations")
        .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
        .unique(),
      ctx.db
        .query("projects")
        .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
        .take(USAGE_PROJECT_MAX),
      ctx.db
        .query("members")
        .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
        .take(1_000),
      ctx.db
        .query("organizationEvents")
        .withIndex("by_org_time", (q) => q.eq("clerkOrgId", args.clerkOrgId))
        .order("desc")
        .take(ACTIVITY_SAMPLE_MAX),
    ]);
    const activeProjects = projects.filter((project) => !project.deletedAt);
    const counts = new Map<string, number>();
    for (const event of recentEvents) {
      if (event.projectId) counts.set(event.projectId, (counts.get(event.projectId) ?? 0) + 1);
    }
    const accepted = members.filter((member) => member.status === "accepted");
    const guestCount = accepted.filter((member) => member.role === "org:guest").length;
    return {
      seats: accepted.length,
      guests: guestCount,
      pendingInvitations: members.length - accepted.length,
      projectCount: activeProjects.length,
      projectLimit: organization?.maxProjects ?? 5,
      guestLimit: organization?.maxGuests ?? 5,
      historyRetentionDays: organization?.historyRetentionDays ?? 30,
      trashRetentionDays: 30,
      storageBytes: activeProjects.reduce((sum, project) => sum + (project.totalBytes ?? 0), 0),
      projects: activeProjects
        .map((project) => ({
          id: project._id,
          title: project.title,
          storageBytes: project.totalBytes ?? 0,
          storageLimit:
            project.maxSizeBytes ?? organization?.maxSizeBytes ?? DEFAULT_MAX_PROJECT_BYTES,
          collaboratorLimit:
            project.maxCollaborators ?? organization?.maxCollaborators ?? DEFAULT_MAX_COLLABORATORS,
          activityCount: counts.get(project._id) ?? 0,
        }))
        .sort((a, b) => b.activityCount - a.activityCount || b.storageBytes - a.storageBytes),
      sampledEventCount: recentEvents.length,
      projectsTruncated: projects.length === USAGE_PROJECT_MAX,
    };
  },
});

export const prune = internalMutation({
  args: { cutoff: v.number(), cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("organizationEvents")
      .withIndex("by_created", (q) => q.lt("createdAt", args.cutoff))
      .paginate({ cursor: args.cursor ?? null, numItems: 200, maximumRowsRead: 200 });
    for (const event of page.page) await ctx.db.delete(event._id);
    return { deleted: page.page.length, nextCursor: page.isDone ? null : page.continueCursor };
  },
});

export const pruneScheduled = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())), cutoff: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const cutoff = args.cutoff ?? now - 30 * 24 * 60 * 60 * 1_000;
    const page = await ctx.db
      .query("organizationEvents")
      .withIndex("by_created", (q) => q.lt("createdAt", cutoff))
      .paginate({ cursor: args.cursor ?? null, numItems: 200, maximumRowsRead: 200 });
    const retentionByOrg = new Map<string, number>();
    for (const event of page.page) {
      let days = retentionByOrg.get(event.clerkOrgId);
      if (days === undefined) {
        const organization = await ctx.db
          .query("organizations")
          .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", event.clerkOrgId))
          .unique();
        days = organization?.historyRetentionDays ?? 30;
        retentionByOrg.set(event.clerkOrgId, days);
      }
      if (event.createdAt < now - days * 24 * 60 * 60 * 1_000) await ctx.db.delete(event._id);
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.audit.pruneScheduled, {
        cursor: page.continueCursor,
        cutoff,
      });
    }
    return page.page.length;
  },
});
