import { v } from "convex/values";
import * as Y from "yjs";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { clampInt, HARD_MAX_PROJECT_BYTES, MIN_PROJECT_BYTES } from "./limits";

const MAX_NAME_LENGTH = 80;
const MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_PROJECT_BYTES = 8 * 1024 * 1024;
const MAX_NODES_PER_PROJECT = 2000;
const MAX_DEPTH = 16;
const PURGE_COLLAB_BATCH = 200;
const PURGE_DOCUMENT_BATCH = 20;
const WINDOWS_RESERVED_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

type Access = { project: Doc<"projects">; userId: string; isAdmin: boolean };

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function cleanName(raw: string, fallback?: string): string {
  const name = raw.replaceAll("/", "").replaceAll("\\", "").trim().slice(0, MAX_NAME_LENGTH).trim();
  const stem = name.split(".")[0]?.toLowerCase() ?? "";
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    /[. ]$/.test(name) ||
    WINDOWS_RESERVED_NAMES.has(stem)
  ) {
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

function importName(raw: string): string {
  const name = cleanName(raw, "import.md");
  if (/\.markdown$/i.test(name)) {
    return `${name.slice(0, -9)}.md`;
  }
  if (/\.htm$/i.test(name)) {
    return `${name.slice(0, -4)}.html`;
  }
  if (/\.txt$/i.test(name)) {
    return `${name.slice(0, -4)}.md`;
  }
  return name;
}

async function callerFor(ctx: QueryCtx, clerkOrgId: string) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    return null;
  }
  if (identity.org_id !== clerkOrgId) {
    return null;
  }
  return { userId: identity.subject, isAdmin: identity.org_role === "org:admin" };
}

export async function accessForProject(
  ctx: QueryCtx,
  projectId: Id<"projects">,
): Promise<Access | null> {
  const project = await ctx.db.get(projectId);
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
  if (!parent || parent.deletingAt || parent.projectId !== projectId || parent.kind !== "folder") {
    throw new Error("invalid-parent");
  }
}

async function assertCapacity(ctx: QueryCtx, projectId: Id<"projects">): Promise<void> {
  const docs = await ctx.db
    .query("documents")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .collect();
  if (docs.filter((doc) => !doc.deletingAt).length >= MAX_NODES_PER_PROJECT) {
    throw new Error("too-many-nodes");
  }
}

async function depthOf(ctx: QueryCtx, parentId: Id<"documents"> | null): Promise<number> {
  let depth = 0;
  let current = parentId;
  while (current !== null) {
    const node = await ctx.db.get(current);
    if (!node || node.deletingAt) {
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
  return siblings.some(
    (doc) => !doc.deletingAt && doc._id !== exclude && doc.name.toLowerCase() === key,
  );
}

async function orgMaxSizeBytes(ctx: QueryCtx, clerkOrgId: string): Promise<number> {
  const row = await ctx.db
    .query("organizations")
    .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", clerkOrgId))
    .unique();
  return typeof row?.maxSizeBytes === "number" ? row.maxSizeBytes : DEFAULT_MAX_PROJECT_BYTES;
}

export async function maxProjectBytes(ctx: QueryCtx, project: Doc<"projects">): Promise<number> {
  const orgCap = await orgMaxSizeBytes(ctx, project.clerkOrgId);
  return Math.min(project.maxSizeBytes ?? orgCap, orgCap);
}

async function uniqueName(
  ctx: QueryCtx,
  projectId: Id<"projects">,
  parentId: Id<"documents"> | null,
  baseName: string,
): Promise<string> {
  const siblings = await childrenOf(ctx, projectId, parentId);
  const taken = new Set(
    siblings.filter((doc) => !doc.deletingAt).map((doc) => doc.name.toLowerCase()),
  );
  if (!taken.has(baseName.toLowerCase())) {
    return baseName;
  }
  const dot = baseName.lastIndexOf(".");
  const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
  const extension = dot > 0 ? baseName.slice(dot) : "";
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${stem}-${index}${extension}`;
    if (!taken.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  throw new Error("too-many-nodes");
}

export async function projectTotalBytes(ctx: QueryCtx, projectId: Id<"projects">): Promise<number> {
  const docs = await ctx.db
    .query("documents")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .collect();
  return docs.reduce((sum, doc) => sum + doc.size, 0);
}

export async function cachedProjectBytes(ctx: QueryCtx, project: Doc<"projects">): Promise<number> {
  if (typeof project.totalBytes === "number") {
    return project.totalBytes;
  }
  return await projectTotalBytes(ctx, project._id);
}

export async function addProjectBytes(
  ctx: MutationCtx,
  project: Doc<"projects">,
  delta: number,
): Promise<void> {
  if (delta === 0) {
    return;
  }
  const base = await cachedProjectBytes(ctx, project);
  await ctx.db.patch(project._id, { totalBytes: Math.max(0, base + delta) });
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

function descendantIds(docs: Doc<"documents">[], rootId: Id<"documents">): Set<Id<"documents">> {
  const children = new Map<Id<"documents"> | null, Doc<"documents">[]>();
  for (const doc of docs) {
    const list = children.get(doc.parentId) ?? [];
    list.push(doc);
    children.set(doc.parentId, list);
  }
  const ids = new Set<Id<"documents">>();
  const queue: Id<"documents">[] = [rootId];
  while (queue.length > 0) {
    const id = queue.shift() as Id<"documents">;
    if (ids.has(id)) {
      continue;
    }
    ids.add(id);
    for (const child of children.get(id) ?? []) {
      queue.push(child._id);
    }
  }
  return ids;
}

function visibleDocuments(docs: Doc<"documents">[]): Doc<"documents">[] {
  const byId = new Map(docs.map((doc) => [doc._id, doc]));
  const hidden = new Set<Id<"documents">>();
  for (const doc of docs) {
    let current: Doc<"documents"> | undefined = doc;
    const seen = new Set<Id<"documents">>();
    while (current && !seen.has(current._id)) {
      seen.add(current._id);
      if (current.deletingAt) {
        hidden.add(doc._id);
        break;
      }
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
  }
  return docs.filter((doc) => !hidden.has(doc._id));
}

function depthFromRoot(
  doc: Doc<"documents">,
  byId: Map<Id<"documents">, Doc<"documents">>,
  rootId: Id<"documents">,
): number {
  let depth = 0;
  let current: Doc<"documents"> | undefined = doc;
  const seen = new Set<Id<"documents">>();
  while (current && current._id !== rootId && !seen.has(current._id)) {
    seen.add(current._id);
    depth += 1;
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return depth;
}

export async function purgeDocCollabBatch(
  ctx: MutationCtx,
  documentId: Id<"documents">,
): Promise<boolean> {
  const updates = await ctx.db
    .query("yjsUpdates")
    .withIndex("by_document", (q) => q.eq("documentId", documentId))
    .take(PURGE_COLLAB_BATCH);
  for (const row of updates) {
    await ctx.db.delete(row._id);
  }
  if (updates.length > 0) {
    return true;
  }
  const snapshots = await ctx.db
    .query("yjsSnapshots")
    .withIndex("by_document", (q) => q.eq("documentId", documentId))
    .take(PURGE_COLLAB_BATCH);
  for (const row of snapshots) {
    await ctx.db.delete(row._id);
  }
  if (snapshots.length > 0) {
    return true;
  }
  const rows = await ctx.db
    .query("presence")
    .withIndex("by_document", (q) => q.eq("documentId", documentId))
    .take(PURGE_COLLAB_BATCH);
  for (const row of rows) {
    await ctx.db.delete(row._id);
  }
  if (rows.length > 0) {
    return true;
  }
  const shareEvents = await ctx.db
    .query("documentShareEvents")
    .withIndex("by_document", (q) => q.eq("documentId", documentId))
    .take(PURGE_COLLAB_BATCH);
  for (const row of shareEvents) {
    await ctx.db.delete(row._id);
  }
  if (shareEvents.length > 0) {
    return true;
  }
  const shares = await ctx.db
    .query("documentShares")
    .withIndex("by_document", (q) => q.eq("documentId", documentId))
    .take(PURGE_COLLAB_BATCH);
  for (const row of shares) {
    await ctx.db.delete(row._id);
  }
  if (shares.length > 0) {
    return true;
  }
  const messages = await ctx.db
    .query("commentMessages")
    .withIndex("by_document", (q) => q.eq("documentId", documentId))
    .take(PURGE_COLLAB_BATCH);
  for (const row of messages) {
    await ctx.db.delete(row._id);
  }
  if (messages.length > 0) {
    return true;
  }
  const notifications = await ctx.db
    .query("notifications")
    .withIndex("by_document", (q) => q.eq("documentId", documentId))
    .take(PURGE_COLLAB_BATCH);
  for (const row of notifications) {
    await ctx.db.delete(row._id);
  }
  if (notifications.length > 0) {
    return true;
  }
  const comments = await ctx.db
    .query("comments")
    .withIndex("by_document", (q) => q.eq("documentId", documentId))
    .take(PURGE_COLLAB_BATCH);
  for (const row of comments) {
    await ctx.db.delete(row._id);
  }
  return comments.length > 0;
}

export async function purgeDocCollab(ctx: MutationCtx, documentId: Id<"documents">): Promise<void> {
  let more = true;
  while (more) {
    more = await purgeDocCollabBatch(ctx, documentId);
  }
}

export const purgeSubtreeBatch = internalMutation({
  args: { projectId: v.id("projects"), rootId: v.id("documents") },
  handler: async (ctx, args) => {
    const docs = await ctx.db
      .query("documents")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    const ids = descendantIds(docs, args.rootId);
    const byId = new Map(docs.map((doc) => [doc._id, doc]));
    const batch = docs
      .filter((doc) => ids.has(doc._id))
      .sort((a, b) => depthFromRoot(b, byId, args.rootId) - depthFromRoot(a, byId, args.rootId))
      .slice(0, PURGE_DOCUMENT_BATCH);
    if (batch.length === 0) {
      return;
    }
    let freed = 0;
    for (const doc of batch) {
      if (doc.kind === "file") {
        const hasMoreCollab = await purgeDocCollabBatch(ctx, doc._id);
        if (hasMoreCollab) {
          await ctx.scheduler.runAfter(0, internal.documents.purgeSubtreeBatch, args);
          return;
        }
      }
      if (doc.storageId) {
        await ctx.storage.delete(doc.storageId);
      }
      freed += doc.size;
      await ctx.db.delete(doc._id);
    }
    if (freed > 0) {
      const project = await ctx.db.get(args.projectId);
      if (project) {
        await addProjectBytes(ctx, project, -freed);
      }
    }
    await ctx.scheduler.runAfter(0, internal.documents.purgeSubtreeBatch, args);
  },
});

export const resumePurges = internalMutation({
  args: {},
  handler: async (ctx) => {
    const pending = await ctx.db
      .query("documents")
      .withIndex("by_deleting", (q) => q.gt("deletingAt", 0))
      .take(100);
    const projectIds = [...new Set(pending.map((doc) => doc.projectId))];
    const docs = (
      await Promise.all(
        projectIds.map((projectId) =>
          ctx.db
            .query("documents")
            .withIndex("by_project", (q) => q.eq("projectId", projectId))
            .collect(),
        ),
      )
    ).flat();
    const byId = new Map(docs.map((doc) => [doc._id, doc]));
    const roots = pending.filter((doc) => {
      if (!doc.deletingAt) {
        return false;
      }
      let current = doc.parentId ? byId.get(doc.parentId) : undefined;
      const seen = new Set<Id<"documents">>();
      while (current && !seen.has(current._id)) {
        seen.add(current._id);
        if (current.deletingAt) {
          return false;
        }
        current = current.parentId ? byId.get(current.parentId) : undefined;
      }
      return true;
    });
    for (const root of roots) {
      await ctx.scheduler.runAfter(0, internal.documents.purgeSubtreeBatch, {
        projectId: root.projectId,
        rootId: root._id,
      });
    }
  },
});

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
      visibleDocuments(docs).map(async (doc) => ({
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
    const docs = await ctx.db
      .query("documents")
      .withIndex("by_project", (q) => q.eq("projectId", doc.projectId))
      .collect();
    if (!visibleDocuments(docs).some((visible) => visible._id === doc._id)) {
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
      usedBytes: await cachedProjectBytes(ctx, access.project),
      maxSizeBytes: await maxProjectBytes(ctx, access.project),
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

export const createDocument = mutation({
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
      kind: "file",
      name,
      fileType: "doc",
      content: "",
      storageId: null,
      mimeType: null,
      size: 0,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const importDocuments = mutation({
  args: {
    projectId: v.id("projects"),
    parentId: v.union(v.id("documents"), v.null()),
    files: v.array(v.object({ name: v.string(), content: v.string() })),
  },
  handler: async (ctx, args) => {
    if (args.files.length === 0 || args.files.length > 100) {
      throw new Error("invalid-import");
    }
    const access = await requireProjectAccess(ctx, args.projectId);
    await assertParent(ctx, args.projectId, args.parentId);
    if ((await depthOf(ctx, args.parentId)) + 1 > MAX_DEPTH) {
      throw new Error("too-deep");
    }
    const docs = await ctx.db
      .query("documents")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    if (docs.filter((doc) => !doc.deletingAt).length + args.files.length > MAX_NODES_PER_PROJECT) {
      throw new Error("too-many-nodes");
    }
    const siblings = new Set(
      (await childrenOf(ctx, args.projectId, args.parentId))
        .filter((doc) => !doc.deletingAt)
        .map((doc) => doc.name.toLowerCase()),
    );
    const prepared = args.files.map((file) => {
      const name = importName(file.name);
      const fileType = fileTypeFromName(name);
      const size = byteLength(file.content);
      if (!fileType) {
        throw new Error("invalid-type");
      }
      if (size > MAX_FILE_BYTES) {
        throw new Error("file-too-large");
      }
      let candidate = name;
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const extension = dot > 0 ? name.slice(dot) : "";
      for (let index = 2; siblings.has(candidate.toLowerCase()); index += 1) {
        candidate = `${stem}-${index}${extension}`;
        if (index >= 10_000) {
          throw new Error("too-many-nodes");
        }
      }
      siblings.add(candidate.toLowerCase());
      return { name: candidate, fileType, content: file.content, size };
    });
    const addedBytes = prepared.reduce((sum, file) => sum + file.size, 0);
    const usedBytes = await cachedProjectBytes(ctx, access.project);
    if (usedBytes + addedBytes > (await maxProjectBytes(ctx, access.project))) {
      throw new Error("project-full");
    }
    const now = Date.now();
    const ids = [];
    for (const file of prepared) {
      const ydoc = new Y.Doc();
      ydoc.getText("codemirror").insert(0, file.content);
      const state = toArrayBuffer(Y.encodeStateAsUpdate(ydoc));
      ydoc.destroy();
      const id = await ctx.db.insert("documents", {
        projectId: args.projectId,
        clerkOrgId: access.project.clerkOrgId,
        parentId: args.parentId,
        kind: "file",
        name: file.name,
        fileType: file.fileType,
        content: file.content,
        contentSeq: 1,
        contentState: state,
        storageId: null,
        mimeType: null,
        size: file.size,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("yjsUpdates", { documentId: id, seq: 1, update: state, createdAt: now });
      ids.push(id);
    }
    await addProjectBytes(ctx, access.project, addedBytes);
    return ids;
  },
});

export const rename = mutation({
  args: { documentId: v.id("documents"), name: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (!doc || doc.deletingAt) {
      throw new Error("not-found");
    }
    await requireProjectAccess(ctx, doc.projectId);
    const name = cleanName(args.name);
    let fileType = doc.fileType;
    if (doc.kind === "file") {
      if (doc.fileType === "doc") {
        fileType = "doc";
      } else {
        fileType = fileTypeFromName(name);
        if (!fileType) {
          throw new Error("invalid-type");
        }
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
    if (!doc || doc.deletingAt) {
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

async function copyName(
  ctx: QueryCtx,
  projectId: Id<"projects">,
  parentId: Id<"documents"> | null,
  name: string,
): Promise<string> {
  const siblings = await childrenOf(ctx, projectId, parentId);
  const taken = new Set(
    siblings.filter((doc) => !doc.deletingAt).map((doc) => doc.name.toLowerCase()),
  );
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  const first = `${stem} (copy)${extension}`;
  if (!taken.has(first.toLowerCase())) {
    return first;
  }
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${stem} (copy ${index})${extension}`;
    if (!taken.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  throw new Error("too-many-nodes");
}

export const duplicate = mutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (doc?.kind !== "file" || doc.deletingAt) {
      throw new Error("not-found");
    }
    const access = await requireProjectAccess(ctx, doc.projectId);
    await assertCapacity(ctx, doc.projectId);
    const total = await cachedProjectBytes(ctx, access.project);
    const max = await maxProjectBytes(ctx, access.project);
    if (total + doc.size > max) {
      throw new Error("project-full");
    }
    let state: ArrayBuffer | null = doc.contentState ?? null;
    if (!state && doc.fileType !== "doc" && doc.content.length > 0) {
      const seedDoc = new Y.Doc();
      seedDoc.getText("codemirror").insert(0, doc.content);
      state = toArrayBuffer(Y.encodeStateAsUpdate(seedDoc));
      seedDoc.destroy();
    }
    const name = await copyName(ctx, doc.projectId, doc.parentId, doc.name);
    const now = Date.now();
    const id = await ctx.db.insert("documents", {
      projectId: doc.projectId,
      clerkOrgId: access.project.clerkOrgId,
      parentId: doc.parentId,
      kind: "file",
      name,
      fileType: doc.fileType,
      content: doc.content,
      contentSeq: state ? 1 : undefined,
      contentState: state ?? undefined,
      storageId: null,
      mimeType: null,
      size: doc.size,
      createdAt: now,
      updatedAt: now,
    });
    if (state) {
      await ctx.db.insert("yjsUpdates", { documentId: id, seq: 1, update: state, createdAt: now });
    }
    await addProjectBytes(ctx, access.project, doc.size);
    return id;
  },
});

export const setContent = mutation({
  args: { documentId: v.id("documents"), content: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (doc?.kind !== "file" || doc.deletingAt) {
      throw new Error("not-found");
    }
    const access = await requireProjectAccess(ctx, doc.projectId);
    const newSize = byteLength(args.content);
    if (newSize > MAX_FILE_BYTES) {
      throw new Error("file-too-large");
    }
    const total = await cachedProjectBytes(ctx, access.project);
    const max = await maxProjectBytes(ctx, access.project);
    if (total - doc.size + newSize > max) {
      throw new Error("project-full");
    }
    await ctx.db.patch(doc._id, { content: args.content, size: newSize, updatedAt: Date.now() });
    await addProjectBytes(ctx, access.project, newSize - doc.size);
  },
});

export const remove = mutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (!doc || doc.deletingAt) {
      return;
    }
    const access = await requireProjectAccess(ctx, doc.projectId);
    await ctx.db.patch(doc._id, { deletingAt: Date.now(), updatedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.documents.purgeSubtreeBatch, {
      projectId: access.project._id,
      rootId: doc._id,
    });
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
    const total = await cachedProjectBytes(ctx, access.project);
    const max = await maxProjectBytes(ctx, access.project);
    if (total + meta.size > max) {
      await ctx.storage.delete(args.storageId);
      throw new Error("project-full");
    }
    const name = await uniqueName(
      ctx,
      args.projectId,
      args.parentId,
      cleanName(args.name, "asset"),
    );
    const now = Date.now();
    const id = await ctx.db.insert("documents", {
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
    await addProjectBytes(ctx, access.project, meta.size);
    return id;
  },
});

const SEARCH_LIMIT = 40;
const SNIPPET_RADIUS = 90;
const MAX_SEARCH_TERM = 200;

function locateMatch(haystack: string, term: string): { index: number; length: number } | null {
  const lower = haystack.toLowerCase();
  let best: { index: number; length: number } | null = null;
  for (const token of term.toLowerCase().split(/\s+/)) {
    if (token.length === 0) {
      continue;
    }
    const at = lower.indexOf(token);
    if (at >= 0 && (best === null || at < best.index)) {
      best = { index: at, length: token.length };
    }
  }
  return best;
}

function buildSnippet(
  content: string,
  term: string,
): { before: string; match: string; after: string } {
  const collapsed = content.replace(/\s+/g, " ").trim();
  const loc = locateMatch(collapsed, term);
  if (!loc) {
    const head = collapsed.slice(0, SNIPPET_RADIUS * 2);
    return { before: head, match: "", after: head.length < collapsed.length ? "…" : "" };
  }
  const start = Math.max(0, loc.index - SNIPPET_RADIUS);
  const end = Math.min(collapsed.length, loc.index + loc.length + SNIPPET_RADIUS);
  return {
    before: (start > 0 ? "…" : "") + collapsed.slice(start, loc.index),
    match: collapsed.slice(loc.index, loc.index + loc.length),
    after: collapsed.slice(loc.index + loc.length, end) + (end < collapsed.length ? "…" : ""),
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeUrl(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (/^(?:https?:|mailto:|tel:|\/|#)/i.test(trimmed)) {
    return trimmed;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function markedText(text: string, attrs: Record<string, unknown>): string {
  let out = escapeHtml(text);
  if (attrs.code) {
    out = `<code>${out}</code>`;
  }
  if (attrs.bold || attrs.strong) {
    out = `<strong>${out}</strong>`;
  }
  if (attrs.italic || attrs.em) {
    out = `<em>${out}</em>`;
  }
  if (attrs.strike) {
    out = `<s>${out}</s>`;
  }
  const link = safeUrl(asRecord(attrs.link).href ?? attrs.href);
  if (link) {
    out = `<a href="${escapeHtml(link)}">${out}</a>`;
  }
  return out;
}

function textHtml(node: Y.XmlText): string {
  let out = "";
  for (const op of node.toDelta() as Array<{ insert?: unknown; attributes?: unknown }>) {
    if (typeof op.insert === "string") {
      out += markedText(op.insert, asRecord(op.attributes));
    }
  }
  return out;
}

function plainText(node: Y.XmlFragment | Y.XmlElement | Y.XmlText): string {
  if (node instanceof Y.XmlText) {
    return (node.toDelta() as Array<{ insert?: unknown }>)
      .map((op) => (typeof op.insert === "string" ? op.insert : ""))
      .join("");
  }
  return node
    .toArray()
    .map((child) => plainText(child as Y.XmlFragment | Y.XmlElement | Y.XmlText))
    .join("");
}

function elementLevel(element: Y.XmlElement): number {
  const raw = element.getAttribute("level");
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) ? Math.min(6, Math.max(1, value)) : 1;
}

function childrenHtml(element: Y.XmlElement | Y.XmlFragment): string {
  return element
    .toArray()
    .map((child) => richNodeHtml(child as Y.XmlFragment | Y.XmlElement | Y.XmlText))
    .join("");
}

function richNodeHtml(node: Y.XmlFragment | Y.XmlElement | Y.XmlText): string {
  if (node instanceof Y.XmlText) {
    return textHtml(node);
  }
  if (!(node instanceof Y.XmlElement)) {
    return childrenHtml(node);
  }
  const name = node.nodeName;
  const inner = childrenHtml(node);
  if (name === "paragraph") {
    return `<p>${inner || "<br>"}</p>`;
  }
  if (name === "heading") {
    const level = elementLevel(node);
    return `<h${level}>${inner}</h${level}>`;
  }
  if (name === "bulletList" || name === "bullet_list") {
    return `<ul>${inner}</ul>`;
  }
  if (name === "orderedList" || name === "ordered_list") {
    return `<ol>${inner}</ol>`;
  }
  if (name === "listItem" || name === "list_item") {
    return `<li>${inner}</li>`;
  }
  if (name === "blockquote") {
    return `<blockquote>${inner}</blockquote>`;
  }
  if (name === "codeBlock" || name === "code_block") {
    return `<pre><code>${escapeHtml(plainText(node))}</code></pre>`;
  }
  if (name === "horizontalRule" || name === "horizontal_rule") {
    return "<hr>";
  }
  if (name === "hardBreak" || name === "hard_break") {
    return "<br>";
  }
  const imageSrc = safeUrl(node.getAttribute("src"));
  if (name === "image" && imageSrc) {
    const alt = escapeHtml(String(node.getAttribute("alt") ?? ""));
    const title = escapeHtml(String(node.getAttribute("title") ?? ""));
    return `<img src="${escapeHtml(imageSrc)}" alt="${alt}"${title ? ` title="${title}"` : ""}>`;
  }
  return inner;
}

function fallbackRichTextHtml(content: string): string {
  const paragraphs = content
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) {
    return "<p><br></p>";
  }
  return paragraphs.map((part) => `<p>${escapeHtml(part).replace(/\n/g, "<br>")}</p>`).join("");
}

function richDocumentHtml(doc: Doc<"documents">): string {
  let body = doc.content ? fallbackRichTextHtml(doc.content) : "<p><br></p>";
  if (doc.contentState) {
    const ydoc = new Y.Doc();
    try {
      Y.applyUpdate(ydoc, new Uint8Array(doc.contentState));
      const fragment = ydoc.getXmlFragment("prosemirror");
      const rendered = childrenHtml(fragment);
      if (rendered.trim().length > 0) {
        body = rendered;
      }
    } finally {
      ydoc.destroy();
    }
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(doc.name)}</title><style>body{margin:0;background:#fff;color:#1a1d24;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif}.doc{max-width:820px;margin:0 auto;padding:2.5rem 2rem;line-height:1.7}.doc h1,.doc h2,.doc h3{line-height:1.25}.doc blockquote{border-left:3px solid #cbd0d8;margin:1em 0;padding-left:1rem;color:#5b626e}.doc pre{background:#f4f5f7;border:1px solid #e2e4e9;border-radius:8px;overflow:auto;padding:1rem}.doc code{font-family:ui-monospace,SFMono-Regular,monospace}.doc img{max-width:100%;height:auto}.doc table{border-collapse:collapse;width:100%}.doc th,.doc td{border:1px solid #e2e4e9;padding:.4rem .6rem;text-align:left}@page{margin:1.6cm}</style></head><body><main class="doc">${body}</main></body></html>`;
}

export const search = query({
  args: { projectId: v.id("projects"), query: v.string() },
  handler: async (ctx, args) => {
    const access = await accessForProject(ctx, args.projectId);
    if (!access) {
      return [];
    }
    const term = args.query.trim().slice(0, MAX_SEARCH_TERM);
    if (term.length === 0) {
      return [];
    }
    const hits = await ctx.db
      .query("documents")
      .withSearchIndex("search_content", (q) =>
        q.search("content", term).eq("projectId", args.projectId).eq("kind", "file"),
      )
      .take(SEARCH_LIMIT);
    const docs = await ctx.db
      .query("documents")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    const visibleIds = new Set(visibleDocuments(docs).map((doc) => doc._id));
    return hits
      .filter((doc) => visibleIds.has(doc._id) && !doc.deletingAt)
      .map((doc) => ({
        id: doc._id,
        parentId: doc.parentId,
        name: doc.name,
        fileType: doc.fileType,
        snippet: buildSnippet(doc.content, term),
      }));
  },
});

export const exportBundle = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const access = await accessForProject(ctx, args.projectId);
    if (!access) {
      return null;
    }
    const docs = await ctx.db
      .query("documents")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    const nodes = await Promise.all(
      visibleDocuments(docs).map(async (doc) => ({
        id: doc._id,
        parentId: doc.parentId,
        kind: doc.kind,
        name: doc.name,
        fileType: doc.fileType,
        content:
          doc.kind === "file" && doc.fileType === "doc"
            ? richDocumentHtml(doc)
            : doc.kind === "file"
              ? doc.content
              : "",
        mimeType: doc.mimeType,
        assetUrl:
          doc.kind === "asset" && doc.storageId ? await ctx.storage.getUrl(doc.storageId) : null,
      })),
    );
    return { projectTitle: access.project.title, nodes };
  },
});

export const setMaxSize = mutation({
  args: { projectId: v.id("projects"), maxSizeBytes: v.number() },
  handler: async (ctx, args) => {
    const access = await requireProjectAdmin(ctx, args.projectId);
    const orgCap = await orgMaxSizeBytes(ctx, access.project.clerkOrgId);
    await ctx.db.patch(args.projectId, {
      maxSizeBytes: Math.min(
        clampInt(args.maxSizeBytes, MIN_PROJECT_BYTES, HARD_MAX_PROJECT_BYTES),
        orgCap,
      ),
    });
  },
});
