import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { purgeDocCollabBatch } from "./documents";
import {
  clampInt,
  DEFAULT_MAX_COLLABORATORS,
  DEFAULT_MAX_PROJECTS,
  HARD_MAX_COLLABORATORS,
  HARD_MAX_PROJECTS,
} from "./limits";

const MAX_TAGS = 8;
const MAX_TAG_LENGTH = 24;
const MAX_TITLE_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 280;
const PURGE_GRANT_BATCH = 200;
const PURGE_DOC_BATCH = 20;

type Caller = { userId: string; isAdmin: boolean };

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

async function callerFor(ctx: QueryCtx, clerkOrgId: string): Promise<Caller | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    return null;
  }
  if (identity.org_id !== clerkOrgId) {
    return null;
  }
  return {
    userId: identity.subject,
    isAdmin: identity.org_role === "org:admin",
  };
}

async function requireAdmin(ctx: MutationCtx, clerkOrgId: string): Promise<string> {
  const caller = await callerFor(ctx, clerkOrgId);
  if (!caller?.isAdmin) {
    throw new Error("Forbidden");
  }
  return caller.userId;
}

function accessRowsFor(ctx: QueryCtx, projectId: Doc<"projects">["_id"]) {
  return ctx.db
    .query("projectAccess")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .collect();
}

function acceptedMemberFor(ctx: QueryCtx, clerkOrgId: string, userId: string) {
  return ctx.db
    .query("members")
    .withIndex("by_org_user", (q) => q.eq("clerkOrgId", clerkOrgId).eq("memberUserId", userId))
    .first();
}

export async function purgeAccessForUser(
  ctx: MutationCtx,
  clerkOrgId: string,
  userId: string,
): Promise<void> {
  const grants = await ctx.db
    .query("projectAccess")
    .withIndex("by_org_user", (q) => q.eq("clerkOrgId", clerkOrgId).eq("userId", userId))
    .collect();
  for (const grant of grants) {
    await ctx.db.delete(grant._id);
  }
}

async function tombstoneProject(ctx: MutationCtx, projectId: Doc<"projects">["_id"]) {
  const project = await ctx.db.get(projectId);
  if (!project || project.deletedAt) {
    return;
  }
  await ctx.db.patch(projectId, { deletedAt: Date.now() });
  await ctx.scheduler.runAfter(0, internal.projects.purgeBatch, { projectId });
}

export const purgeBatch = internalMutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const grants = await ctx.db
      .query("projectAccess")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(PURGE_GRANT_BATCH);
    for (const grant of grants) {
      await ctx.db.delete(grant._id);
    }
    if (grants.length > 0) {
      await ctx.scheduler.runAfter(0, internal.projects.purgeBatch, { projectId: args.projectId });
      return;
    }
    const documents = await ctx.db
      .query("documents")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(PURGE_DOC_BATCH);
    for (const document of documents) {
      if (document.kind === "file") {
        const hasMoreCollab = await purgeDocCollabBatch(ctx, document._id);
        if (hasMoreCollab) {
          await ctx.scheduler.runAfter(0, internal.projects.purgeBatch, {
            projectId: args.projectId,
          });
          return;
        }
      }
      if (document.storageId) {
        await ctx.storage.delete(document.storageId);
      }
      await ctx.db.delete(document._id);
    }
    if (documents.length > 0) {
      await ctx.scheduler.runAfter(0, internal.projects.purgeBatch, { projectId: args.projectId });
      return;
    }
    const project = await ctx.db.get(args.projectId);
    if (project?.imageStorageId) {
      await ctx.storage.delete(project.imageStorageId);
    }
    await ctx.db.delete(args.projectId);
  },
});

export const resumePurges = internalMutation({
  args: {},
  handler: async (ctx) => {
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_deleted", (q) => q.gt("deletedAt", 0))
      .take(100);
    for (const project of projects) {
      await ctx.scheduler.runAfter(0, internal.projects.purgeBatch, { projectId: project._id });
    }
  },
});

export const listByOrg = query({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    const caller = await callerFor(ctx, args.clerkOrgId);
    if (!caller) {
      return [];
    }

    let projects: Doc<"projects">[];
    if (caller.isAdmin) {
      projects = await ctx.db
        .query("projects")
        .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
        .collect();
    } else {
      const grants = await ctx.db
        .query("projectAccess")
        .withIndex("by_org_user", (q) =>
          q.eq("clerkOrgId", args.clerkOrgId).eq("userId", caller.userId),
        )
        .collect();
      const docs = await Promise.all(grants.map((grant) => ctx.db.get(grant.projectId)));
      projects = docs.filter((doc): doc is Doc<"projects"> => doc !== null);
    }
    projects = projects.filter((project) => !project.deletedAt);

    projects.sort((a, b) => b.createdAt - a.createdAt);

    return Promise.all(
      projects.map(async (project) => {
        const owner = await ctx.db
          .query("members")
          .withIndex("by_org_user", (q) =>
            q.eq("clerkOrgId", project.clerkOrgId).eq("memberUserId", project.createdBy),
          )
          .unique();
        const ownerName = owner
          ? [owner.firstName, owner.lastName].filter(Boolean).join(" ").trim() || owner.email
          : null;
        return {
          id: project._id,
          title: project.title,
          description: project.description,
          tags: project.tags,
          imageUrl: project.imageStorageId
            ? await ctx.storage.getUrl(project.imageStorageId)
            : null,
          createdAt: project.createdAt,
          ownerName,
          ownerEmail: owner?.email ?? null,
          ownerImageUrl: owner?.imageUrl ?? null,
          accessCount: caller.isAdmin ? (await accessRowsFor(ctx, project._id)).length : 0,
        };
      }),
    );
  },
});

export const get = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project || project.deletedAt) {
      return null;
    }
    const caller = await callerFor(ctx, project.clerkOrgId);
    if (!caller) {
      return null;
    }
    if (!caller.isAdmin) {
      const grant = await ctx.db
        .query("projectAccess")
        .withIndex("by_project_user", (q) =>
          q.eq("projectId", project._id).eq("userId", caller.userId),
        )
        .unique();
      if (!grant) {
        return null;
      }
    }
    const access = caller.isAdmin ? await accessRowsFor(ctx, project._id) : [];
    const viewerMember = await acceptedMemberFor(ctx, project.clerkOrgId, caller.userId);
    return {
      id: project._id,
      clerkOrgId: project.clerkOrgId,
      title: project.title,
      description: project.description,
      tags: project.tags,
      imageUrl: project.imageStorageId ? await ctx.storage.getUrl(project.imageStorageId) : null,
      createdAt: project.createdAt,
      isAdmin: caller.isAdmin,
      viewerIsOwner: viewerMember?.isOwner === true,
      accessUserIds: access.map((row) => row.userId),
      maxCollaborators: project.maxCollaborators ?? DEFAULT_MAX_COLLABORATORS,
    };
  },
});

async function orgLimits(ctx: QueryCtx, clerkOrgId: string) {
  const row = await ctx.db
    .query("organizations")
    .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", clerkOrgId))
    .unique();
  return {
    maxProjects: typeof row?.maxProjects === "number" ? row.maxProjects : null,
    maxCollaborators:
      typeof row?.maxCollaborators === "number" ? row.maxCollaborators : DEFAULT_MAX_COLLABORATORS,
  };
}

async function activeProjectsFor(ctx: QueryCtx, clerkOrgId: string): Promise<Doc<"projects">[]> {
  const rows = await ctx.db
    .query("projects")
    .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", clerkOrgId))
    .collect();
  return rows.filter((row) => !row.deletedAt);
}

export const countByOrg = query({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    const caller = await callerFor(ctx, args.clerkOrgId);
    if (!caller) {
      return 0;
    }
    return (await activeProjectsFor(ctx, args.clerkOrgId)).length;
  },
});

export const create = mutation({
  args: {
    clerkOrgId: v.string(),
    title: v.string(),
    description: v.string(),
    tags: v.array(v.string()),
    maxProjects: v.number(),
  },
  handler: async (ctx, args) => {
    const userId = await requireAdmin(ctx, args.clerkOrgId);
    const title = args.title.trim();
    if (title.length < 2) {
      throw new Error("invalid-title");
    }
    const limits = await orgLimits(ctx, args.clerkOrgId);
    const fallbackCap = Math.min(
      clampInt(args.maxProjects, 0, HARD_MAX_PROJECTS),
      DEFAULT_MAX_PROJECTS,
    );
    const cap = limits.maxProjects ?? fallbackCap;
    const existing = await activeProjectsFor(ctx, args.clerkOrgId);
    if (existing.length >= cap) {
      throw new Error("too-many-projects");
    }
    const now = Date.now();
    return await ctx.db.insert("projects", {
      clerkOrgId: args.clerkOrgId,
      title: title.slice(0, MAX_TITLE_LENGTH),
      description: args.description.trim().slice(0, MAX_DESCRIPTION_LENGTH),
      tags: normalizeTags(args.tags),
      imageStorageId: null,
      totalBytes: 0,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const update = mutation({
  args: {
    projectId: v.id("projects"),
    title: v.string(),
    description: v.string(),
    tags: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) {
      throw new Error("Not found");
    }
    await requireAdmin(ctx, project.clerkOrgId);
    const title = args.title.trim();
    if (title.length < 2) {
      throw new Error("invalid-title");
    }
    await ctx.db.patch(project._id, {
      title: title.slice(0, MAX_TITLE_LENGTH),
      description: args.description.trim().slice(0, MAX_DESCRIPTION_LENGTH),
      tags: normalizeTags(args.tags),
      updatedAt: Date.now(),
    });
  },
});

export const remove = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) {
      return;
    }
    await requireAdmin(ctx, project.clerkOrgId);
    await tombstoneProject(ctx, project._id);
  },
});

export const generateUploadUrl = mutation({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.clerkOrgId);
    return await ctx.storage.generateUploadUrl();
  },
});

export const setImage = mutation({
  args: { projectId: v.id("projects"), storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) {
      throw new Error("Not found");
    }
    await requireAdmin(ctx, project.clerkOrgId);
    if (project.imageStorageId && project.imageStorageId !== args.storageId) {
      await ctx.storage.delete(project.imageStorageId);
    }
    await ctx.db.patch(project._id, { imageStorageId: args.storageId, updatedAt: Date.now() });
  },
});

export const removeImage = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) {
      return;
    }
    await requireAdmin(ctx, project.clerkOrgId);
    if (project.imageStorageId) {
      await ctx.storage.delete(project.imageStorageId);
      await ctx.db.patch(project._id, { imageStorageId: null, updatedAt: Date.now() });
    }
  },
});

export const grantAccess = mutation({
  args: { projectId: v.id("projects"), userId: v.string() },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) {
      throw new Error("Not found");
    }
    await requireAdmin(ctx, project.clerkOrgId);
    const existing = await ctx.db
      .query("projectAccess")
      .withIndex("by_project_user", (q) => q.eq("projectId", project._id).eq("userId", args.userId))
      .unique();
    if (existing) {
      return;
    }
    const member = await acceptedMemberFor(ctx, project.clerkOrgId, args.userId);
    if (member?.status !== "accepted") {
      throw new Error("not-a-member");
    }
    if (member.isOwner || member.role === "org:admin") {
      throw new Error("already-privileged");
    }
    const grants = await accessRowsFor(ctx, project._id);
    const limits = await orgLimits(ctx, project.clerkOrgId);
    const cap = Math.min(
      project.maxCollaborators ?? limits.maxCollaborators,
      limits.maxCollaborators,
    );
    if (grants.length >= cap) {
      throw new Error("too-many-collaborators");
    }
    await ctx.db.insert("projectAccess", {
      projectId: project._id,
      clerkOrgId: project.clerkOrgId,
      userId: args.userId,
      createdAt: Date.now(),
    });
  },
});

export const revokeAccess = mutation({
  args: { projectId: v.id("projects"), userId: v.string() },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) {
      return;
    }
    await requireAdmin(ctx, project.clerkOrgId);
    const existing = await ctx.db
      .query("projectAccess")
      .withIndex("by_project_user", (q) => q.eq("projectId", project._id).eq("userId", args.userId))
      .unique();
    if (existing) {
      await ctx.db.delete(existing._id);
    }
  },
});

export const setMaxCollaborators = mutation({
  args: { projectId: v.id("projects"), maxCollaborators: v.number() },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) {
      throw new Error("Not found");
    }
    await requireAdmin(ctx, project.clerkOrgId);
    const limits = await orgLimits(ctx, project.clerkOrgId);
    await ctx.db.patch(project._id, {
      maxCollaborators: Math.min(
        clampInt(args.maxCollaborators, 0, HARD_MAX_COLLABORATORS),
        limits.maxCollaborators,
      ),
    });
  },
});

export const deleteAllByOrg = mutation({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.clerkOrgId);
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .collect();
    for (const project of projects) {
      await tombstoneProject(ctx, project._id);
    }
  },
});

export const revokeAllAccessForUser = mutation({
  args: { clerkOrgId: v.string(), userId: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.clerkOrgId);
    await purgeAccessForUser(ctx, args.clerkOrgId, args.userId);
  },
});
