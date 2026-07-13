import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { action, internalMutation, mutation, query } from "./_generated/server";
import { recordProjectEvent } from "./activity";
import {
  addProjectBytes,
  isInactive,
  purgeDocCollabBatch,
  purgeRecentDocumentBatch,
} from "./documents";
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
const STUCK_CLONE_MS = 15 * 60 * 1000;

type Caller = { userId: string; isAdmin: boolean };
type GrantLevel = "viewer" | "editor";

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

async function lastSavedAtFor(
  ctx: QueryCtx,
  projectId: Doc<"projects">["_id"],
): Promise<number | null> {
  const docs = await ctx.db
    .query("documents")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .collect();
  let latest: number | null = null;
  for (const doc of docs) {
    if (doc.kind !== "folder" && !isInactive(doc)) {
      latest = latest === null ? doc.updatedAt : Math.max(latest, doc.updatedAt);
    }
  }
  return latest;
}

async function privilegedMemberIds(ctx: QueryCtx, clerkOrgId: string): Promise<string[]> {
  const members = await ctx.db
    .query("members")
    .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", clerkOrgId))
    .collect();
  const ids: string[] = [];
  for (const member of members) {
    if (
      member.status === "accepted" &&
      member.memberUserId !== null &&
      (member.isOwner || member.role === "org:admin")
    ) {
      ids.push(member.memberUserId);
    }
  }
  return ids;
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
    const events = await ctx.db
      .query("projectEvents")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(PURGE_GRANT_BATCH);
    for (const event of events) await ctx.db.delete(event._id);
    if (events.length > 0) {
      await ctx.scheduler.runAfter(0, internal.projects.purgeBatch, { projectId: args.projectId });
      return;
    }
    const preferences = await ctx.db
      .query("notificationPreferences")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(PURGE_GRANT_BATCH);
    for (const preference of preferences) await ctx.db.delete(preference._id);
    if (preferences.length > 0) {
      await ctx.scheduler.runAfter(0, internal.projects.purgeBatch, { projectId: args.projectId });
      return;
    }
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
    const recentDocuments = await ctx.db
      .query("recentDocuments")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(PURGE_GRANT_BATCH);
    for (const recentDocument of recentDocuments) {
      await ctx.db.delete(recentDocument._id);
    }
    if (recentDocuments.length > 0) {
      await ctx.scheduler.runAfter(0, internal.projects.purgeBatch, { projectId: args.projectId });
      return;
    }
    const documents = await ctx.db
      .query("documents")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(PURGE_DOC_BATCH);
    let freed = 0;
    const accountFreed = async () => {
      if (freed === 0) {
        return;
      }
      const project = await ctx.db.get(args.projectId);
      if (project) {
        await addProjectBytes(ctx, project, -freed);
      }
      freed = 0;
    };
    for (const document of documents) {
      const hasMoreRecent = await purgeRecentDocumentBatch(ctx, document._id);
      if (hasMoreRecent) {
        await accountFreed();
        await ctx.scheduler.runAfter(0, internal.projects.purgeBatch, {
          projectId: args.projectId,
        });
        return;
      }
      if (document.kind === "file") {
        const hasMoreCollab = await purgeDocCollabBatch(ctx, document._id);
        if (hasMoreCollab) {
          await accountFreed();
          await ctx.scheduler.runAfter(0, internal.projects.purgeBatch, {
            projectId: args.projectId,
          });
          return;
        }
      }
      if (document.storageId) {
        await ctx.storage.delete(document.storageId);
      }
      freed += document.size;
      await ctx.db.delete(document._id);
    }
    if (documents.length > 0) {
      await accountFreed();
      await ctx.scheduler.runAfter(0, internal.projects.purgeBatch, { projectId: args.projectId });
      return;
    }
    const project = await ctx.db.get(args.projectId);
    if (project?.imageStorageId) {
      await ctx.storage.delete(project.imageStorageId);
    }
    const reconciliation = await ctx.db
      .query("projectByteReconciliations")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .unique();
    if (reconciliation) {
      await ctx.db.delete(reconciliation._id);
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
    projects = projects.filter(
      (project) =>
        !project.deletedAt &&
        (caller.isAdmin || !project.cloneState || project.cloneState === "ready"),
    );

    projects.sort((a, b) => b.createdAt - a.createdAt);

    const privilegedIds = caller.isAdmin ? await privilegedMemberIds(ctx, args.clerkOrgId) : [];

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
          accessCount: caller.isAdmin
            ? new Set([
                ...privilegedIds,
                ...(await accessRowsFor(ctx, project._id)).map((row) => row.userId),
              ]).size
            : 0,
          cloneState: project.cloneState ?? "ready",
          cloneCopied: project.cloneCopied ?? 0,
          cloneTotal: project.cloneTotal ?? 0,
          cloneError: project.cloneError ?? null,
        };
      }),
    );
  },
});

export const get = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project || project.deletedAt || (project.cloneState && project.cloneState !== "ready")) {
      return null;
    }
    const caller = await callerFor(ctx, project.clerkOrgId);
    if (!caller) {
      return null;
    }
    let viewerLevel: GrantLevel = "editor";
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
      viewerLevel = grant.level ?? "editor";
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
      lastSavedAt: await lastSavedAtFor(ctx, project._id),
      isAdmin: caller.isAdmin,
      viewerLevel,
      viewerIsOwner: viewerMember?.isOwner === true,
      access: access.map((row) => ({
        userId: row.userId,
        level: row.level ?? ("editor" as const),
      })),
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
      byteVersion: 0,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const prepareDuplicate = internalMutation({
  args: { sourceProjectId: v.id("projects") },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.sourceProjectId);
    if (!source || source.deletedAt || (source.cloneState && source.cloneState !== "ready"))
      throw new Error("not-found");
    const userId = await requireAdmin(ctx, source.clerkOrgId);
    const projects = (
      await ctx.db
        .query("projects")
        .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", source.clerkOrgId))
        .collect()
    ).filter((item) => !item.deletedAt);
    const limits = await orgLimits(ctx, source.clerkOrgId);
    if (projects.length >= (limits.maxProjects ?? DEFAULT_MAX_PROJECTS))
      throw new Error("too-many-projects");
    const titles = new Set(projects.map((item) => item.title.toLowerCase()));
    let title = `${source.title} (copy)`;
    for (let index = 2; titles.has(title.toLowerCase()); index += 1)
      title = `${source.title} (copy ${index})`;
    const docs = await ctx.db
      .query("documents")
      .withIndex("by_project", (q) => q.eq("projectId", source._id))
      .collect();
    const byId = new Map(docs.map((doc) => [doc._id, doc]));
    const visible = docs.filter((doc) => {
      let current: Doc<"documents"> | undefined = doc;
      const seen = new Set<string>();
      while (current && !seen.has(current._id)) {
        seen.add(current._id);
        if (isInactive(current)) return false;
        current = current.parentId ? byId.get(current.parentId) : undefined;
      }
      return true;
    });
    const now = Date.now();
    const projectId = await ctx.db.insert("projects", {
      clerkOrgId: source.clerkOrgId,
      title,
      description: source.description,
      tags: source.tags,
      imageStorageId: null,
      maxSizeBytes: source.maxSizeBytes,
      maxCollaborators: source.maxCollaborators,
      totalBytes: 0,
      byteVersion: 0,
      cloneState: "copying",
      cloneCopied: 0,
      cloneTotal: visible.length,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    return {
      projectId,
      sourceImageStorageId: source.imageStorageId,
      docs: visible.map((doc) => ({
        id: doc._id,
        parentId: doc.parentId,
        kind: doc.kind,
        name: doc.name,
        fileType: doc.fileType,
        content: doc.content,
        contentState: doc.contentState,
        storageId: doc.storageId,
        mimeType: doc.mimeType,
        size: doc.size,
      })),
    };
  },
});

export const insertDuplicateNode = internalMutation({
  args: {
    projectId: v.id("projects"),
    parentId: v.union(v.id("documents"), v.null()),
    kind: v.union(v.literal("folder"), v.literal("file"), v.literal("asset")),
    name: v.string(),
    fileType: v.union(v.literal("md"), v.literal("html"), v.literal("doc"), v.null()),
    content: v.string(),
    contentState: v.optional(v.bytes()),
    storageId: v.union(v.id("_storage"), v.null()),
    mimeType: v.union(v.string(), v.null()),
    size: v.number(),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (project?.cloneState !== "copying") throw new Error("clone-stopped");
    const now = Date.now();
    const id = await ctx.db.insert("documents", {
      projectId: project._id,
      clerkOrgId: project.clerkOrgId,
      parentId: args.parentId,
      kind: args.kind,
      name: args.name,
      fileType: args.fileType,
      content: args.content,
      contentSeq: args.kind === "file" && args.contentState ? 1 : undefined,
      contentState: args.contentState,
      storageId: args.storageId,
      mimeType: args.mimeType,
      size: args.size,
      createdAt: now,
      updatedAt: now,
    });
    if (args.kind === "file" && args.contentState)
      await ctx.db.insert("yjsUpdates", {
        documentId: id,
        seq: 1,
        update: args.contentState,
        createdAt: now,
      });
    await ctx.db.patch(project._id, {
      cloneCopied: (project.cloneCopied ?? 0) + 1,
      updatedAt: now,
    });
    await addProjectBytes(ctx, project, args.size);
    return id;
  },
});

export const finishDuplicate = internalMutation({
  args: { projectId: v.id("projects"), imageStorageId: v.union(v.id("_storage"), v.null()) },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (project?.cloneState !== "copying" || project.cloneCopied !== project.cloneTotal)
      throw new Error("clone-incomplete");
    await ctx.db.patch(project._id, {
      imageStorageId: args.imageStorageId,
      cloneState: "ready",
      cloneError: undefined,
      updatedAt: Date.now(),
    });
  },
});

export const failDuplicate = internalMutation({
  args: { projectId: v.id("projects"), error: v.string() },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (project && project.cloneState === "copying") {
      await ctx.db.patch(project._id, {
        cloneState: "failed",
        cloneError: args.error.slice(0, 40),
        updatedAt: Date.now(),
      });
      await ctx.scheduler.runAfter(60_000, internal.projects.cleanupFailedDuplicate, {
        projectId: project._id,
      });
    }
  },
});

export const cleanupFailedDuplicate = internalMutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (project?.cloneState !== "failed" || project.deletedAt) return;
    await ctx.db.patch(project._id, { deletedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.projects.purgeBatch, { projectId: project._id });
  },
});

export const reapStuckClones = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - STUCK_CLONE_MS;
    const copying = await ctx.db
      .query("projects")
      .withIndex("by_clone_state", (q) => q.eq("cloneState", "copying"))
      .collect();
    for (const project of copying) {
      if (project.deletedAt || project.updatedAt >= cutoff) continue;
      await ctx.db.patch(project._id, {
        cloneState: "failed",
        cloneError: "timed-out",
        updatedAt: Date.now(),
      });
      await ctx.scheduler.runAfter(60_000, internal.projects.cleanupFailedDuplicate, {
        projectId: project._id,
      });
    }
  },
});

export const duplicateProject = action({
  args: { sourceProjectId: v.id("projects") },
  handler: async (ctx, args): Promise<string> => {
    const prepared = await ctx.runMutation(internal.projects.prepareDuplicate, args);
    const mapped = new Map<string, Doc<"documents">["_id"]>();
    try {
      const pending = [...prepared.docs];
      while (pending.length > 0) {
        const index = pending.findIndex((node) => !node.parentId || mapped.has(node.parentId));
        if (index < 0) throw new Error("invalid-tree");
        const node = pending.splice(index, 1)[0];
        if (!node) throw new Error("invalid-tree");
        let storageId = null;
        if (node.storageId) {
          const blob = await ctx.storage.get(node.storageId);
          if (!blob) throw new Error("missing-asset");
          storageId = await ctx.storage.store(blob);
        }
        const id = await ctx.runMutation(internal.projects.insertDuplicateNode, {
          projectId: prepared.projectId,
          parentId: node.parentId ? (mapped.get(node.parentId) ?? null) : null,
          kind: node.kind,
          name: node.name,
          fileType: node.fileType,
          content: node.content,
          contentState: node.contentState,
          storageId,
          mimeType: node.mimeType,
          size: node.size,
        });
        mapped.set(node.id, id);
      }
      let imageStorageId = null;
      if (prepared.sourceImageStorageId) {
        const blob = await ctx.storage.get(prepared.sourceImageStorageId);
        if (blob) imageStorageId = await ctx.storage.store(blob);
      }
      await ctx.runMutation(internal.projects.finishDuplicate, {
        projectId: prepared.projectId,
        imageStorageId,
      });
      return prepared.projectId;
    } catch (error) {
      const message = error instanceof Error ? error.message : "clone-failed";
      await ctx.runMutation(internal.projects.failDuplicate, {
        projectId: prepared.projectId,
        error: message,
      });
      throw error;
    }
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
  args: {
    projectId: v.id("projects"),
    userId: v.string(),
    level: v.optional(v.union(v.literal("viewer"), v.literal("editor"))),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) {
      throw new Error("Not found");
    }
    const actorUserId = await requireAdmin(ctx, project.clerkOrgId);
    const level: GrantLevel = args.level ?? "editor";
    const existing = await ctx.db
      .query("projectAccess")
      .withIndex("by_project_user", (q) => q.eq("projectId", project._id).eq("userId", args.userId))
      .unique();
    if (existing) {
      if ((existing.level ?? "editor") !== level) {
        await ctx.db.patch(existing._id, { level });
      }
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
      level,
      createdAt: Date.now(),
    });
    const memberName =
      [member.firstName, member.lastName].filter(Boolean).join(" ").trim() || member.email;
    await recordProjectEvent(ctx, {
      projectId: project._id,
      clerkOrgId: project.clerkOrgId,
      kind: "access_granted",
      actorUserId,
      memberUserId: args.userId,
      targetName: memberName,
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
    const actorUserId = await requireAdmin(ctx, project.clerkOrgId);
    const existing = await ctx.db
      .query("projectAccess")
      .withIndex("by_project_user", (q) => q.eq("projectId", project._id).eq("userId", args.userId))
      .unique();
    if (existing) {
      const member = await acceptedMemberFor(ctx, project.clerkOrgId, args.userId);
      await ctx.db.delete(existing._id);
      const memberName = member
        ? [member.firstName, member.lastName].filter(Boolean).join(" ").trim() || member.email
        : args.userId;
      await recordProjectEvent(ctx, {
        projectId: project._id,
        clerkOrgId: project.clerkOrgId,
        kind: "access_revoked",
        actorUserId,
        memberUserId: args.userId,
        targetName: memberName,
      });
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
