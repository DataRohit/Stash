import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { purgeDocCollab } from "./documents";

const MAX_TAGS = 8;
const MAX_TAG_LENGTH = 24;
const MAX_TITLE_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 280;

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
  const claimedOrg = identity.org_id;
  if (typeof claimedOrg === "string" && claimedOrg !== clerkOrgId) {
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

async function purgeProject(ctx: MutationCtx, projectId: Doc<"projects">["_id"]) {
  const grants = await accessRowsFor(ctx, projectId);
  for (const grant of grants) {
    await ctx.db.delete(grant._id);
  }
  const documents = await ctx.db
    .query("documents")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .collect();
  for (const document of documents) {
    if (document.storageId) {
      await ctx.storage.delete(document.storageId);
    }
    if (document.kind === "file") {
      await purgeDocCollab(ctx, document._id);
    }
    await ctx.db.delete(document._id);
  }
  const project = await ctx.db.get(projectId);
  if (project?.imageStorageId) {
    await ctx.storage.delete(project.imageStorageId);
  }
  await ctx.db.delete(projectId);
}

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
    if (!project) {
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
    return {
      id: project._id,
      clerkOrgId: project.clerkOrgId,
      title: project.title,
      description: project.description,
      tags: project.tags,
      imageUrl: project.imageStorageId ? await ctx.storage.getUrl(project.imageStorageId) : null,
      createdAt: project.createdAt,
      isAdmin: caller.isAdmin,
      accessUserIds: access.map((row) => row.userId),
    };
  },
});

export const countByOrg = query({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    const caller = await callerFor(ctx, args.clerkOrgId);
    if (!caller) {
      return 0;
    }
    const rows = await ctx.db
      .query("projects")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .collect();
    return rows.length;
  },
});

export const create = mutation({
  args: {
    clerkOrgId: v.string(),
    title: v.string(),
    description: v.string(),
    tags: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireAdmin(ctx, args.clerkOrgId);
    const now = Date.now();
    return await ctx.db.insert("projects", {
      clerkOrgId: args.clerkOrgId,
      title: args.title.trim().slice(0, MAX_TITLE_LENGTH),
      description: args.description.trim().slice(0, MAX_DESCRIPTION_LENGTH),
      tags: normalizeTags(args.tags),
      imageStorageId: null,
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
    await ctx.db.patch(project._id, {
      title: args.title.trim().slice(0, MAX_TITLE_LENGTH),
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
    await purgeProject(ctx, project._id);
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

export const deleteAllByOrg = mutation({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.clerkOrgId);
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .collect();
    for (const project of projects) {
      await purgeProject(ctx, project._id);
    }
  },
});

export const revokeAllAccessForUser = mutation({
  args: { clerkOrgId: v.string(), userId: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.clerkOrgId);
    const grants = await ctx.db
      .query("projectAccess")
      .withIndex("by_org_user", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId).eq("userId", args.userId),
      )
      .collect();
    for (const grant of grants) {
      await ctx.db.delete(grant._id);
    }
  },
});
