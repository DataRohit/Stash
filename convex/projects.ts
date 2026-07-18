import { v } from "convex/values";
import * as Y from "yjs";
import { isRasterAssetMimeType } from "../lib/asset-formats";
import { getBoardRoots, inspectBoard, MAX_BOARD_STORED_BYTES } from "../lib/board-model";
import { documentSize, project } from "../lib/doc-projection";
import { getViewRoots, inspectView, MAX_VIEW_STORED_BYTES } from "../lib/view-model";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { recordProjectEvent } from "./activity";
import {
  addProjectBytes,
  purgeDocCollabBatch,
  purgeRecentDocumentBatch,
  syncDocumentNode,
} from "./documents";
import {
  clampInt,
  DEFAULT_MAX_COLLABORATORS,
  DEFAULT_MAX_PROJECTS,
  HARD_MAX_COLLABORATORS,
  HARD_MAX_PROJECTS,
} from "./limits";
import { enforceWriteRateLimit } from "./writeRateLimit";

const MAX_TAGS = 8;
const MAX_TAG_LENGTH = 24;
const MAX_TITLE_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 280;
const PURGE_GRANT_BATCH = 200;
const PURGE_DOC_BATCH = 20;
const STUCK_CLONE_MS = 15 * 60 * 1000;
const MAX_PROJECT_IMAGE_BYTES = 2 * 1024 * 1024;

type Caller = { userId: string; isAdmin: boolean };
type CloneManifestNode = {
  id: Doc<"documents">["_id"];
  parentId: Doc<"documents">["parentId"];
  kind: Doc<"documents">["kind"];
  name: string;
  fileType: Doc<"documents">["fileType"];
  size: number;
  mimeType: string | null;
  trashedAt?: number;
  deletingAt?: number;
};
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
  const recent = await ctx.db
    .query("recentDocuments")
    .withIndex("by_user_org_time", (q) => q.eq("userId", userId).eq("clerkOrgId", clerkOrgId))
    .collect();
  for (const row of recent) await ctx.db.delete(row._id);
  const favorites = await ctx.db
    .query("favorites")
    .withIndex("by_user_org", (q) => q.eq("userId", userId).eq("clerkOrgId", clerkOrgId))
    .collect();
  for (const row of favorites) await ctx.db.delete(row._id);
  const watches = await ctx.db
    .query("documentWatches")
    .withIndex("by_user_org", (q) => q.eq("userId", userId).eq("clerkOrgId", clerkOrgId))
    .collect();
  for (const row of watches) await ctx.db.delete(row._id);
  const notifications = await ctx.db
    .query("notifications")
    .withIndex("by_recipient_org", (q) =>
      q.eq("recipientUserId", userId).eq("clerkOrgId", clerkOrgId),
    )
    .collect();
  for (const row of notifications) await ctx.db.delete(row._id);
  const preferences = await ctx.db
    .query("notificationPreferences")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const row of preferences) {
    if (row.clerkOrgId === clerkOrgId) await ctx.db.delete(row._id);
  }
  const emailPreference = await ctx.db
    .query("emailPreferences")
    .withIndex("by_user_org", (q) => q.eq("userId", userId).eq("clerkOrgId", clerkOrgId))
    .unique();
  if (emailPreference) await ctx.db.delete(emailPreference._id);
  const watchPreference = await ctx.db
    .query("watchPreferences")
    .withIndex("by_user_org", (q) => q.eq("userId", userId).eq("clerkOrgId", clerkOrgId))
    .unique();
  if (watchPreference) await ctx.db.delete(watchPreference._id);
  const digestRuns = await ctx.db
    .query("emailDigestRuns")
    .withIndex("by_user_org_day", (q) => q.eq("userId", userId).eq("clerkOrgId", clerkOrgId))
    .collect();
  for (const row of digestRuns) await ctx.db.delete(row._id);
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
    const projectShareEvents = await ctx.db
      .query("projectShareEvents")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(PURGE_GRANT_BATCH);
    for (const event of projectShareEvents) await ctx.db.delete(event._id);
    if (projectShareEvents.length > 0) {
      await ctx.scheduler.runAfter(0, internal.projects.purgeBatch, { projectId: args.projectId });
      return;
    }
    const importJobs = await ctx.db
      .query("importJobs")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(PURGE_GRANT_BATCH);
    for (const job of importJobs) await ctx.db.delete(job._id);
    if (importJobs.length > 0) {
      await ctx.scheduler.runAfter(0, internal.projects.purgeBatch, { projectId: args.projectId });
      return;
    }
    const guestInvitations = await ctx.db
      .query("guestInvitations")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(PURGE_GRANT_BATCH);
    for (const invitation of guestInvitations) await ctx.db.delete(invitation._id);
    if (guestInvitations.length > 0) {
      await ctx.scheduler.runAfter(0, internal.projects.purgeBatch, { projectId: args.projectId });
      return;
    }
    const projectShare = await ctx.db
      .query("projectShares")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .unique();
    if (projectShare) {
      await ctx.db.delete(projectShare._id);
      await ctx.scheduler.runAfter(0, internal.projects.purgeBatch, { projectId: args.projectId });
      return;
    }
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
    const favorites = await ctx.db
      .query("favorites")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(PURGE_GRANT_BATCH);
    for (const favorite of favorites) await ctx.db.delete(favorite._id);
    if (favorites.length > 0) {
      await ctx.scheduler.runAfter(0, internal.projects.purgeBatch, { projectId: args.projectId });
      return;
    }
    const watches = await ctx.db
      .query("documentWatches")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(PURGE_GRANT_BATCH);
    for (const watch of watches) await ctx.db.delete(watch._id);
    if (watches.length > 0) {
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
      await syncDocumentNode(ctx, document._id);
    }
    if (documents.length > 0) {
      await accountFreed();
      await ctx.scheduler.runAfter(0, internal.projects.purgeBatch, { projectId: args.projectId });
      return;
    }
    const properties = await ctx.db
      .query("documentProperties")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(PURGE_GRANT_BATCH);
    for (const property of properties) await ctx.db.delete(property._id);
    if (properties.length > 0) {
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
      lastSavedAt: project.lastSavedAt ?? null,
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
      treeProjectedAt: now,
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
    if (
      !(await enforceWriteRateLimit(ctx, "project-clone", source._id, userId, {
        capacity: 2,
        refillPerSecond: 1 / 30,
      }))
    ) {
      throw new Error("rate-limited");
    }
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
      cloneTotal: 0,
      createdBy: userId,
      createdAt: now,
      treeProjectedAt: now,
      updatedAt: now,
    });
    const properties = await ctx.db
      .query("documentProperties")
      .withIndex("by_project", (q) => q.eq("projectId", source._id))
      .collect();
    return {
      projectId,
      sourceImageStorageId: source.imageStorageId,
      properties: properties.map((property) => ({
        id: property._id,
        name: property.name,
        normalizedName: property.normalizedName,
        type: property.type,
        options: property.options,
        deletedAt: property.deletedAt,
        createdAt: property.createdAt,
        updatedAt: property.updatedAt,
      })),
    };
  },
});

export const cloneManifestPage = internalQuery({
  args: { projectId: v.id("projects"), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("documents")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .paginate({ cursor: args.cursor ?? null, numItems: 5, maximumRowsRead: 5 });
    return {
      nodes: page.page.map((doc) => ({
        id: doc._id,
        parentId: doc.parentId,
        kind: doc.kind,
        name: doc.name,
        fileType: doc.fileType,
        size: doc.size,
        mimeType: doc.mimeType,
        trashedAt: doc.trashedAt,
        deletingAt: doc.deletingAt,
      })),
      cursor: page.isDone ? null : page.continueCursor,
    };
  },
});

export const cloneNodeContent = internalQuery({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (!doc) throw new Error("clone-source-missing");
    const updates = await ctx.db
      .query("yjsUpdates")
      .withIndex("by_document", (q) => q.eq("documentId", doc._id).gt("seq", doc.contentSeq ?? 0))
      .collect();
    return {
      content: doc.content,
      contentState: doc.contentState,
      sheetMeta: doc.sheetMeta,
      boardMeta: doc.boardMeta,
      storageId: doc.storageId,
      updates: updates.map((row) => row.update),
    };
  },
});

export const setDuplicateTotal = internalMutation({
  args: { projectId: v.id("projects"), total: v.number() },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (project?.cloneState !== "copying") throw new Error("clone-stopped");
    await ctx.db.patch(project._id, { cloneTotal: args.total, updatedAt: Date.now() });
  },
});

export const insertDuplicateProperty = internalMutation({
  args: {
    projectId: v.id("projects"),
    name: v.string(),
    normalizedName: v.string(),
    type: v.union(
      v.literal("text"),
      v.literal("number"),
      v.literal("boolean"),
      v.literal("date"),
      v.literal("status"),
      v.literal("person"),
      v.literal("formula"),
      v.literal("rollup"),
    ),
    options: v.array(v.object({ id: v.string(), name: v.string(), color: v.string() })),
    deletedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (project?.cloneState !== "copying") throw new Error("clone-stopped");
    return await ctx.db.insert("documentProperties", {
      projectId: project._id,
      clerkOrgId: project.clerkOrgId,
      name: args.name,
      normalizedName: args.normalizedName,
      type: args.type,
      options: args.options,
      deletedAt: args.deletedAt,
      createdBy: project.createdBy,
      createdAt: args.createdAt,
      updatedAt: args.updatedAt,
    });
  },
});

export const structuredRowsForClone = internalQuery({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const values = await ctx.db
      .query("documentPropertyValues")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    const links = await ctx.db
      .query("documentLinks")
      .withIndex("by_source_document", (q) => q.eq("sourceDocumentId", args.documentId))
      .collect();
    return {
      values: values.map((value) => ({
        propertyId: value.propertyId,
        type: value.type,
        displayValue: value.displayValue,
        textValue: value.textValue,
        numberValue: value.numberValue,
        booleanValue: value.booleanValue,
        dateValue: value.dateValue,
        dateEndValue: value.dateEndValue,
        statusOptionId: value.statusOptionId,
        personUserId: value.personUserId,
        updatedAt: value.updatedAt,
      })),
      links: links.map((link) => ({
        sourceCardId: link.sourceCardId,
        managedByBoard: link.managedByBoard,
        targetDocumentId: link.targetDocumentId,
      })),
    };
  },
});

export const insertDuplicateStructuredRows = internalMutation({
  args: {
    documentId: v.id("documents"),
    values: v.array(
      v.object({
        propertyId: v.id("documentProperties"),
        type: v.union(
          v.literal("text"),
          v.literal("number"),
          v.literal("boolean"),
          v.literal("date"),
          v.literal("status"),
          v.literal("person"),
          v.literal("formula"),
          v.literal("rollup"),
        ),
        displayValue: v.string(),
        textValue: v.optional(v.string()),
        numberValue: v.optional(v.number()),
        booleanValue: v.optional(v.boolean()),
        dateValue: v.optional(v.number()),
        dateEndValue: v.optional(v.number()),
        statusOptionId: v.optional(v.string()),
        personUserId: v.optional(v.string()),
        updatedAt: v.number(),
      }),
    ),
    links: v.array(
      v.object({
        sourceCardId: v.optional(v.string()),
        managedByBoard: v.optional(v.boolean()),
        targetDocumentId: v.id("documents"),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const document = await ctx.db.get(args.documentId);
    if (!document) throw new Error("clone-stopped");
    const project = await ctx.db.get(document.projectId);
    if (project?.cloneState !== "copying") throw new Error("clone-stopped");
    for (const value of args.values) {
      await ctx.db.insert("documentPropertyValues", {
        documentId: document._id,
        propertyId: value.propertyId,
        projectId: project._id,
        clerkOrgId: project.clerkOrgId,
        type: value.type,
        displayValue: value.displayValue,
        textValue: value.textValue,
        numberValue: value.numberValue,
        booleanValue: value.booleanValue,
        dateValue: value.dateValue,
        dateEndValue: value.dateEndValue,
        statusOptionId: value.statusOptionId,
        personUserId: value.personUserId,
        updatedBy: project.createdBy,
        updatedAt: value.updatedAt,
      });
    }
    for (const link of args.links) {
      const target = await ctx.db.get(link.targetDocumentId);
      if (!target || target.clerkOrgId !== project.clerkOrgId) continue;
      const now = Date.now();
      await ctx.db.insert("documentLinks", {
        clerkOrgId: project.clerkOrgId,
        sourceProjectId: project._id,
        sourceDocumentId: document._id,
        sourceCardId: link.sourceCardId,
        managedByBoard: link.managedByBoard,
        targetProjectId: target.projectId,
        targetDocumentId: target._id,
        createdBy: project.createdBy,
        createdAt: now,
        updatedAt: now,
      });
    }
  },
});

export const insertDuplicateNode = internalMutation({
  args: {
    projectId: v.id("projects"),
    parentId: v.union(v.id("documents"), v.null()),
    kind: v.union(v.literal("folder"), v.literal("file"), v.literal("asset")),
    name: v.string(),
    fileType: v.union(
      v.literal("md"),
      v.literal("html"),
      v.literal("sheet"),
      v.literal("board"),
      v.literal("view"),
      v.literal("chart"),
      v.literal("dashboard"),
      v.null(),
    ),
    content: v.string(),
    contentState: v.optional(v.bytes()),
    sheetMeta: v.optional(v.object({ rows: v.number(), cols: v.number() })),
    boardMeta: v.optional(v.object({ columns: v.number(), cards: v.number() })),
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
      sheetMeta: args.sheetMeta,
      boardMeta: args.boardMeta,
      storageId: args.storageId,
      mimeType: args.mimeType,
      size: args.size,
      createdAt: now,
      updatedAt: now,
    });
    await syncDocumentNode(ctx, id);
    if (args.kind === "file" && args.contentState)
      await ctx.db.insert("yjsUpdates", {
        documentId: id,
        seq: 1,
        update: args.contentState,
        createdAt: now,
      });
    if (args.kind === "file" && args.fileType === "board") {
      await ctx.scheduler.runAfter(0, internal.collab.rebuildBoardIndexes, { documentId: id });
    }
    await ctx.db.patch(project._id, {
      cloneCopied: (project.cloneCopied ?? 0) + 1,
      updatedAt: now,
    });
    await addProjectBytes(ctx, project, args.size);
    return id;
  },
});

export const remapDuplicateBoardLinks = internalMutation({
  args: {
    documentId: v.id("documents"),
    links: v.array(v.object({ source: v.string(), target: v.id("documents") })),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (doc?.kind !== "file" || doc.fileType !== "board" || !doc.contentState) return;
    const projectRow = await ctx.db.get(doc.projectId);
    if (projectRow?.cloneState !== "copying") throw new Error("clone-stopped");
    const mapped = new Map(args.links.map((link) => [link.source, link.target as string]));
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, new Uint8Array(doc.contentState));
    const roots = getBoardRoots(ydoc);
    const vector = Y.encodeStateVector(ydoc);
    let changed = false;
    ydoc.transact(() => {
      for (const card of inspectBoard(ydoc).cards.values()) {
        if (!card.linkedDocId) continue;
        const cardMap = roots.cards.get(card.id);
        const target = mapped.get(card.linkedDocId);
        cardMap?.set("linkedDocId", target ?? null);
        changed = true;
      }
    }, "clone-links");
    if (!changed) {
      ydoc.destroy();
      return;
    }
    const updateBytes = Y.encodeStateAsUpdate(ydoc, vector);
    const stateBytes = Y.encodeStateAsUpdate(ydoc);
    const content = project("board", ydoc);
    const size = documentSize("board", ydoc);
    ydoc.destroy();
    if (size > MAX_BOARD_STORED_BYTES) throw new Error("file-too-large");
    const update = updateBytes.slice().buffer;
    const state = stateBytes.slice().buffer;
    await ctx.db.insert("yjsUpdates", {
      documentId: doc._id,
      seq: 2,
      update,
      createdAt: Date.now(),
    });
    await ctx.db.patch(doc._id, { content, contentSeq: 2, contentState: state, size });
    await syncDocumentNode(ctx, doc._id);
    await ctx.scheduler.runAfter(0, internal.collab.rebuildBoardIndexes, {
      documentId: doc._id,
    });
    await addProjectBytes(ctx, projectRow, size - doc.size);
  },
});

export const remapDuplicateViewProperties = internalMutation({
  args: {
    documentId: v.id("documents"),
    properties: v.array(v.object({ source: v.string(), target: v.id("documentProperties") })),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (doc?.kind !== "file" || doc.fileType !== "view" || !doc.contentState) return;
    const projectRow = await ctx.db.get(doc.projectId);
    if (projectRow?.cloneState !== "copying") throw new Error("clone-stopped");
    const mapped = new Map(
      args.properties.map((property) => [property.source, property.target as string]),
    );
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, new Uint8Array(doc.contentState));
    const roots = getViewRoots(ydoc);
    const vector = Y.encodeStateVector(ydoc);
    const remap = (value: unknown) =>
      typeof value === "string" ? (mapped.get(value) ?? value) : value;
    ydoc.transact(() => {
      roots.config.set("groupBy", remap(roots.config.get("groupBy")));
      roots.config.set("datePropertyId", remap(roots.config.get("datePropertyId")));
      const columns = roots.visibleColumns
        .toArray()
        .map((propertyId) => mapped.get(propertyId) ?? propertyId);
      roots.visibleColumns.delete(0, roots.visibleColumns.length);
      roots.visibleColumns.insert(0, columns);
      for (const filter of roots.filters.values()) {
        filter.set("propertyId", remap(filter.get("propertyId")));
      }
      for (const sort of roots.sorts.values()) {
        sort.set("propertyId", remap(sort.get("propertyId")));
      }
    }, "clone-properties");
    inspectView(ydoc);
    const updateBytes = Y.encodeStateAsUpdate(ydoc, vector);
    const stateBytes = Y.encodeStateAsUpdate(ydoc);
    const content = project("view", ydoc);
    const size = documentSize("view", ydoc);
    ydoc.destroy();
    if (size > MAX_VIEW_STORED_BYTES) throw new Error("file-too-large");
    const update = updateBytes.slice().buffer;
    const state = stateBytes.slice().buffer;
    await ctx.db.insert("yjsUpdates", {
      documentId: doc._id,
      seq: 2,
      update,
      createdAt: Date.now(),
    });
    await ctx.db.patch(doc._id, { content, contentSeq: 2, contentState: state, size });
    await syncDocumentNode(ctx, doc._id);
    await addProjectBytes(ctx, projectRow, size - doc.size);
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
    const mappedProperties = new Map<string, Doc<"documentProperties">["_id"]>();
    try {
      const manifest: CloneManifestNode[] = [];
      let cursor: string | undefined;
      do {
        const page = await ctx.runQuery(internal.projects.cloneManifestPage, {
          projectId: args.sourceProjectId,
          cursor,
        });
        manifest.push(...page.nodes);
        cursor = page.cursor ?? undefined;
      } while (cursor);
      const byId = new Map(manifest.map((node) => [node.id, node]));
      const docs = manifest.filter((node) => {
        let current: (typeof manifest)[number] | undefined = node;
        const seen = new Set<string>();
        while (current && !seen.has(current.id)) {
          seen.add(current.id);
          if (current.trashedAt || current.deletingAt) return false;
          current = current.parentId ? byId.get(current.parentId) : undefined;
        }
        return !current;
      });
      await ctx.runMutation(internal.projects.setDuplicateTotal, {
        projectId: prepared.projectId,
        total: docs.length,
      });
      for (const property of prepared.properties) {
        const id = await ctx.runMutation(internal.projects.insertDuplicateProperty, {
          projectId: prepared.projectId,
          name: property.name,
          normalizedName: property.normalizedName,
          type: property.type,
          options: property.options,
          deletedAt: property.deletedAt,
          createdAt: property.createdAt,
          updatedAt: property.updatedAt,
        });
        mappedProperties.set(property.id, id);
      }
      const pending = [...docs];
      while (pending.length > 0) {
        const index = pending.findIndex((node) => !node.parentId || mapped.has(node.parentId));
        if (index < 0) throw new Error("invalid-tree");
        const node = pending.splice(index, 1)[0];
        if (!node) throw new Error("invalid-tree");
        const body = await ctx.runQuery(internal.projects.cloneNodeContent, {
          documentId: node.id,
        });
        let contentState = body.contentState;
        if (body.updates.length > 0) {
          const source = new Y.Doc();
          if (contentState) Y.applyUpdate(source, new Uint8Array(contentState));
          for (const update of body.updates) Y.applyUpdate(source, new Uint8Array(update));
          contentState = Y.encodeStateAsUpdate(source).slice().buffer;
          source.destroy();
        }
        let storageId = null;
        if (body.storageId) {
          const blob = await ctx.storage.get(body.storageId);
          if (!blob) throw new Error("missing-asset");
          storageId = await ctx.storage.store(blob);
        }
        const id = await ctx.runMutation(internal.projects.insertDuplicateNode, {
          projectId: prepared.projectId,
          parentId: node.parentId ? (mapped.get(node.parentId) ?? null) : null,
          kind: node.kind,
          name: node.name,
          fileType: node.fileType,
          content: body.content,
          contentState,
          sheetMeta: body.sheetMeta,
          boardMeta: body.boardMeta,
          storageId,
          mimeType: node.mimeType,
          size: node.size,
        });
        mapped.set(node.id, id);
      }
      const links = [...mapped].map(([source, target]) => ({ source, target }));
      for (const node of docs) {
        if (node.fileType !== "board") continue;
        const documentId = mapped.get(node.id);
        if (documentId) {
          await ctx.runMutation(internal.projects.remapDuplicateBoardLinks, {
            documentId,
            links,
          });
        }
      }
      const propertyLinks = [...mappedProperties].map(([source, target]) => ({ source, target }));
      for (const node of docs) {
        if (node.fileType !== "view") continue;
        const documentId = mapped.get(node.id);
        if (documentId) {
          await ctx.runMutation(internal.projects.remapDuplicateViewProperties, {
            documentId,
            properties: propertyLinks,
          });
        }
      }
      for (const node of docs) {
        if (node.kind !== "file") continue;
        const documentId = mapped.get(node.id);
        if (!documentId) continue;
        const structured = await ctx.runQuery(internal.projects.structuredRowsForClone, {
          documentId: node.id,
        });
        await ctx.runMutation(internal.projects.insertDuplicateStructuredRows, {
          documentId,
          values: structured.values.flatMap((value) => {
            const propertyId = mappedProperties.get(value.propertyId);
            return propertyId ? [{ ...value, propertyId }] : [];
          }),
          links: structured.links.map((link) => ({
            sourceCardId: link.sourceCardId,
            managedByBoard: link.managedByBoard,
            targetDocumentId: mapped.get(link.targetDocumentId) ?? link.targetDocumentId,
          })),
        });
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
    const documentReference = await ctx.db
      .query("documents")
      .withIndex("by_storage", (q) => q.eq("storageId", args.storageId))
      .first();
    const projectReference = await ctx.db
      .query("projects")
      .withIndex("by_image_storage", (q) => q.eq("imageStorageId", args.storageId))
      .first();
    if (documentReference || (projectReference && projectReference._id !== project._id)) {
      throw new Error("storage-in-use");
    }
    const metadata = await ctx.db.system.get(args.storageId);
    if (!metadata) {
      throw new Error("invalid-image");
    }
    if (!isRasterAssetMimeType(metadata.contentType ?? "")) {
      if (!projectReference) {
        await ctx.storage.delete(args.storageId);
      }
      throw new Error("invalid-image");
    }
    if (metadata.size > MAX_PROJECT_IMAGE_BYTES) {
      if (!projectReference) {
        await ctx.storage.delete(args.storageId);
      }
      throw new Error("image-too-large");
    }
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
