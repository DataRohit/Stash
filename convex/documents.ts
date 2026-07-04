import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";

const MAX_NAME_LENGTH = 80;
const MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_PROJECT_BYTES = 8 * 1024 * 1024;
const MAX_NODES_PER_PROJECT = 2000;
const MAX_DEPTH = 16;

type Access = { project: Doc<"projects">; userId: string; isAdmin: boolean };

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function cleanName(raw: string, fallback?: string): string {
  const name = raw.replaceAll("/", "").replaceAll("\\", "").trim().slice(0, MAX_NAME_LENGTH).trim();
  if (name.length === 0 || name === "." || name === "..") {
    if (fallback) {
      return fallback;
    }
    throw new Error("invalid-name");
  }
  return name;
}

function fileTypeFromName(name: string): "md" | "html" | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".md")) {
    return "md";
  }
  if (lower.endsWith(".html")) {
    return "html";
  }
  return null;
}

async function callerFor(ctx: QueryCtx, clerkOrgId: string) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    return null;
  }
  const claimedOrg = identity.org_id;
  if (typeof claimedOrg === "string" && claimedOrg !== clerkOrgId) {
    return null;
  }
  return { userId: identity.subject, isAdmin: identity.org_role === "org:admin" };
}

export async function accessForProject(
  ctx: QueryCtx,
  projectId: Id<"projects">,
): Promise<Access | null> {
  const project = await ctx.db.get(projectId);
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
      .withIndex("by_project_user", (q) => q.eq("projectId", projectId).eq("userId", caller.userId))
      .unique();
    if (!grant) {
      return null;
    }
  }
  return { project, userId: caller.userId, isAdmin: caller.isAdmin };
}

export async function requireProjectAccess(
  ctx: MutationCtx,
  projectId: Id<"projects">,
): Promise<Access> {
  const access = await accessForProject(ctx, projectId);
  if (!access) {
    throw new Error("Forbidden");
  }
  return access;
}

export async function requireProjectAdmin(
  ctx: MutationCtx,
  projectId: Id<"projects">,
): Promise<Access> {
  const access = await accessForProject(ctx, projectId);
  if (!access?.isAdmin) {
    throw new Error("Forbidden");
  }
  return access;
}

function childrenOf(ctx: QueryCtx, projectId: Id<"projects">, parentId: Id<"documents"> | null) {
  return ctx.db
    .query("documents")
    .withIndex("by_parent", (q) => q.eq("projectId", projectId).eq("parentId", parentId))
    .collect();
}

async function assertParent(
  ctx: QueryCtx,
  projectId: Id<"projects">,
  parentId: Id<"documents"> | null,
): Promise<void> {
  if (parentId === null) {
    return;
  }
  const parent = await ctx.db.get(parentId);
  if (!parent || parent.projectId !== projectId || parent.kind !== "folder") {
    throw new Error("invalid-parent");
  }
}

async function assertCapacity(ctx: QueryCtx, projectId: Id<"projects">): Promise<void> {
  const docs = await ctx.db
    .query("documents")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .collect();
  if (docs.length >= MAX_NODES_PER_PROJECT) {
    throw new Error("too-many-nodes");
  }
}

async function depthOf(ctx: QueryCtx, parentId: Id<"documents"> | null): Promise<number> {
  let depth = 0;
  let current = parentId;
  while (current !== null) {
    const node = await ctx.db.get(current);
    if (!node) {
      break;
    }
    depth += 1;
    current = node.parentId;
  }
  return depth;
}

async function subtreeHeight(
  ctx: QueryCtx,
  projectId: Id<"projects">,
  rootId: Id<"documents">,
): Promise<number> {
  let height = 0;
  let level: Id<"documents">[] = [rootId];
  while (level.length > 0) {
    const next: Id<"documents">[] = [];
    for (const id of level) {
      const kids = await childrenOf(ctx, projectId, id);
      for (const kid of kids) {
        next.push(kid._id);
      }
    }
    if (next.length > 0) {
      height += 1;
    }
    level = next;
  }
  return height;
}

async function nameTaken(
  ctx: QueryCtx,
  projectId: Id<"projects">,
  parentId: Id<"documents"> | null,
  name: string,
  exclude?: Id<"documents">,
): Promise<boolean> {
  const siblings = await childrenOf(ctx, projectId, parentId);
  const key = name.trim().toLowerCase();
  return siblings.some((doc) => doc._id !== exclude && doc.name.toLowerCase() === key);
}

async function projectTotalBytes(ctx: QueryCtx, projectId: Id<"projects">): Promise<number> {
  const docs = await ctx.db
    .query("documents")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .collect();
  return docs.reduce((sum, doc) => sum + doc.size, 0);
}

async function subtree(
  ctx: QueryCtx,
  projectId: Id<"projects">,
  rootId: Id<"documents">,
): Promise<Doc<"documents">[]> {
  const root = await ctx.db.get(rootId);
  if (!root) {
    return [];
  }
  const all: Doc<"documents">[] = [root];
  const queue: Id<"documents">[] = [rootId];
  while (queue.length > 0) {
    const parentId = queue.shift() as Id<"documents">;
    const children = await childrenOf(ctx, projectId, parentId);
    for (const child of children) {
      all.push(child);
      queue.push(child._id);
    }
  }
  return all;
}

export async function purgeDocCollab(ctx: MutationCtx, documentId: Id<"documents">): Promise<void> {
  const updates = await ctx.db
    .query("yjsUpdates")
    .withIndex("by_document", (q) => q.eq("documentId", documentId))
    .collect();
  for (const row of updates) {
    await ctx.db.delete(row._id);
  }
  const snapshots = await ctx.db
    .query("yjsSnapshots")
    .withIndex("by_document", (q) => q.eq("documentId", documentId))
    .collect();
  for (const row of snapshots) {
    await ctx.db.delete(row._id);
  }
  const rows = await ctx.db
    .query("presence")
    .withIndex("by_document", (q) => q.eq("documentId", documentId))
    .collect();
  for (const row of rows) {
    await ctx.db.delete(row._id);
  }
}

export const listByProject = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const access = await accessForProject(ctx, args.projectId);
    if (!access) {
      return [];
    }
    const docs = await ctx.db
      .query("documents")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    return Promise.all(
      docs.map(async (doc) => ({
        id: doc._id,
        parentId: doc.parentId,
        kind: doc.kind,
        name: doc.name,
        fileType: doc.fileType,
        size: doc.size,
        mimeType: doc.mimeType,
        assetUrl:
          doc.kind === "asset" && doc.storageId ? await ctx.storage.getUrl(doc.storageId) : null,
      })),
    );
  },
});

export const getDocument = query({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (!doc) {
      return null;
    }
    const access = await accessForProject(ctx, doc.projectId);
    if (!access) {
      return null;
    }
    return {
      id: doc._id,
      projectId: doc.projectId,
      parentId: doc.parentId,
      kind: doc.kind,
      name: doc.name,
      fileType: doc.fileType,
      content: doc.content,
      mimeType: doc.mimeType,
      size: doc.size,
      assetUrl:
        doc.kind === "asset" && doc.storageId ? await ctx.storage.getUrl(doc.storageId) : null,
      isAdmin: access.isAdmin,
    };
  },
});

export const usage = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const access = await accessForProject(ctx, args.projectId);
    if (!access) {
      return { usedBytes: 0, maxSizeBytes: DEFAULT_MAX_PROJECT_BYTES };
    }
    return {
      usedBytes: await projectTotalBytes(ctx, args.projectId),
      maxSizeBytes: access.project.maxSizeBytes ?? DEFAULT_MAX_PROJECT_BYTES,
    };
  },
});

export const createFolder = mutation({
  args: {
    projectId: v.id("projects"),
    parentId: v.union(v.id("documents"), v.null()),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectAccess(ctx, args.projectId);
    await assertParent(ctx, args.projectId, args.parentId);
    await assertCapacity(ctx, args.projectId);
    if ((await depthOf(ctx, args.parentId)) + 1 > MAX_DEPTH) {
      throw new Error("too-deep");
    }
    const name = cleanName(args.name);
    if (await nameTaken(ctx, args.projectId, args.parentId, name)) {
      throw new Error("name-taken");
    }
    const now = Date.now();
    return await ctx.db.insert("documents", {
      projectId: args.projectId,
      clerkOrgId: access.project.clerkOrgId,
      parentId: args.parentId,
      kind: "folder",
      name,
      fileType: null,
      content: "",
      storageId: null,
      mimeType: null,
      size: 0,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const createFile = mutation({
  args: {
    projectId: v.id("projects"),
    parentId: v.union(v.id("documents"), v.null()),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectAccess(ctx, args.projectId);
    await assertParent(ctx, args.projectId, args.parentId);
    await assertCapacity(ctx, args.projectId);
    if ((await depthOf(ctx, args.parentId)) + 1 > MAX_DEPTH) {
      throw new Error("too-deep");
    }
    const name = cleanName(args.name);
    const fileType = fileTypeFromName(name);
    if (!fileType) {
      throw new Error("invalid-type");
    }
    if (await nameTaken(ctx, args.projectId, args.parentId, name)) {
      throw new Error("name-taken");
    }
    const now = Date.now();
    return await ctx.db.insert("documents", {
      projectId: args.projectId,
      clerkOrgId: access.project.clerkOrgId,
      parentId: args.parentId,
      kind: "file",
      name,
      fileType,
      content: "",
      storageId: null,
      mimeType: null,
      size: 0,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const rename = mutation({
  args: { documentId: v.id("documents"), name: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (!doc) {
      throw new Error("not-found");
    }
    await requireProjectAccess(ctx, doc.projectId);
    const name = cleanName(args.name);
    let fileType = doc.fileType;
    if (doc.kind === "file") {
      fileType = fileTypeFromName(name);
      if (!fileType) {
        throw new Error("invalid-type");
      }
    }
    if (await nameTaken(ctx, doc.projectId, doc.parentId, name, doc._id)) {
      throw new Error("name-taken");
    }
    await ctx.db.patch(doc._id, { name, fileType, updatedAt: Date.now() });
  },
});

export const move = mutation({
  args: { documentId: v.id("documents"), parentId: v.union(v.id("documents"), v.null()) },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (!doc) {
      throw new Error("not-found");
    }
    await requireProjectAccess(ctx, doc.projectId);
    if (args.parentId) {
      await assertParent(ctx, doc.projectId, args.parentId);
      const descendants = await subtree(ctx, doc.projectId, doc._id);
      if (descendants.some((node) => node._id === args.parentId)) {
        throw new Error("invalid-target");
      }
    }
    if (
      (await depthOf(ctx, args.parentId)) + 1 + (await subtreeHeight(ctx, doc.projectId, doc._id)) >
      MAX_DEPTH
    ) {
      throw new Error("too-deep");
    }
    if (await nameTaken(ctx, doc.projectId, args.parentId, doc.name, doc._id)) {
      throw new Error("name-taken");
    }
    await ctx.db.patch(doc._id, { parentId: args.parentId, updatedAt: Date.now() });
  },
});

export const setContent = mutation({
  args: { documentId: v.id("documents"), content: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (doc?.kind !== "file") {
      throw new Error("not-found");
    }
    const access = await requireProjectAccess(ctx, doc.projectId);
    const newSize = byteLength(args.content);
    if (newSize > MAX_FILE_BYTES) {
      throw new Error("file-too-large");
    }
    const total = await projectTotalBytes(ctx, doc.projectId);
    const max = access.project.maxSizeBytes ?? DEFAULT_MAX_PROJECT_BYTES;
    if (total - doc.size + newSize > max) {
      throw new Error("project-full");
    }
    await ctx.db.patch(doc._id, { content: args.content, size: newSize, updatedAt: Date.now() });
  },
});

export const remove = mutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (!doc) {
      return;
    }
    await requireProjectAccess(ctx, doc.projectId);
    const nodes = await subtree(ctx, doc.projectId, doc._id);
    for (const node of nodes) {
      if (node.storageId) {
        await ctx.storage.delete(node.storageId);
      }
      if (node.kind === "file") {
        await purgeDocCollab(ctx, node._id);
      }
      await ctx.db.delete(node._id);
    }
  },
});

export const generateUploadUrl = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireProjectAccess(ctx, args.projectId);
    return await ctx.storage.generateUploadUrl();
  },
});

export const createAsset = mutation({
  args: {
    projectId: v.id("projects"),
    parentId: v.union(v.id("documents"), v.null()),
    name: v.string(),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectAccess(ctx, args.projectId);
    const meta = await ctx.db.system.get(args.storageId);
    if (!meta) {
      throw new Error("invalid-asset");
    }
    const mimeType = meta.contentType ?? "";
    if (!mimeType.startsWith("image/")) {
      await ctx.storage.delete(args.storageId);
      throw new Error("invalid-asset");
    }
    if (meta.size > MAX_FILE_BYTES) {
      await ctx.storage.delete(args.storageId);
      throw new Error("file-too-large");
    }
    try {
      await assertParent(ctx, args.projectId, args.parentId);
      await assertCapacity(ctx, args.projectId);
    } catch (error) {
      await ctx.storage.delete(args.storageId);
      throw error;
    }
    const total = await projectTotalBytes(ctx, args.projectId);
    const max = access.project.maxSizeBytes ?? DEFAULT_MAX_PROJECT_BYTES;
    if (total + meta.size > max) {
      await ctx.storage.delete(args.storageId);
      throw new Error("project-full");
    }
    let name = cleanName(args.name, "asset");
    if (await nameTaken(ctx, args.projectId, args.parentId, name)) {
      name = `${Date.now()}-${name}`;
    }
    const now = Date.now();
    return await ctx.db.insert("documents", {
      projectId: args.projectId,
      clerkOrgId: access.project.clerkOrgId,
      parentId: args.parentId,
      kind: "asset",
      name,
      fileType: null,
      content: "",
      storageId: args.storageId,
      mimeType,
      size: meta.size,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const setMaxSize = mutation({
  args: { projectId: v.id("projects"), maxSizeBytes: v.number() },
  handler: async (ctx, args) => {
    await requireProjectAdmin(ctx, args.projectId);
    await ctx.db.patch(args.projectId, { maxSizeBytes: args.maxSizeBytes });
  },
});
