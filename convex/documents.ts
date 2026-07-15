import { v } from "convex/values";
import * as Y from "yjs";
import { isRasterAssetMimeType } from "../lib/asset-formats";
import { inspectBoard, MAX_BOARD_STORED_BYTES, seedBoard } from "../lib/board-model";
import { boardRenderModel, documentSize, project, sheetRenderModel } from "../lib/doc-projection";
import type { FileType } from "../lib/document-types";
import { TRASH_RETENTION_MS } from "../lib/lifecycle";
import { serializeDelimited } from "../lib/sheet-csv";
import {
  inspectSheet,
  MAX_SHEET_STORED_BYTES,
  SheetValidationError,
  seedSheet,
} from "../lib/sheet-model";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { recordProjectEvent } from "./activity";
import {
  clampInt,
  DEFAULT_MAX_PROJECT_BYTES,
  HARD_MAX_PROJECT_BYTES,
  MIN_PROJECT_BYTES,
} from "./limits";

const MAX_NAME_LENGTH = 80;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_COLLAB_UPDATE_BYTES = 768 * 1024;
const MAX_ASSET_BYTES = 5 * 1024 * 1024;
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

type GrantLevel = "viewer" | "editor";

type Access = {
  project: Doc<"projects">;
  userId: string;
  isAdmin: boolean;
  level: GrantLevel;
};

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function isInactive(doc: Doc<"documents">): boolean {
  return Boolean(doc.deletingAt || doc.trashedAt);
}

export async function isInactiveTree(
  ctx: Pick<QueryCtx, "db">,
  doc: Doc<"documents">,
): Promise<boolean> {
  let current: Doc<"documents"> | null = doc;
  const seen = new Set<Id<"documents">>();
  while (current && !seen.has(current._id)) {
    seen.add(current._id);
    if (isInactive(current)) {
      return true;
    }
    current = current.parentId ? await ctx.db.get(current.parentId) : null;
  }
  return false;
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

function fileTypeFromName(name: string): FileType | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".md")) {
    return "md";
  }
  if (lower.endsWith(".html")) {
    return "html";
  }
  if (lower.endsWith(".sheet")) {
    return "sheet";
  }
  if (lower.endsWith(".board")) {
    return "board";
  }
  return null;
}

function requireFileTypeFromName(name: string): FileType {
  const fileType = fileTypeFromName(name);
  if (!fileType) throw new Error("invalid-type");
  if (!name.slice(0, -`.${fileType}`.length).trim()) throw new Error("invalid-name");
  return fileType;
}

function requestedFileType(raw: string, fallback: FileType): FileType {
  const trimmed = raw.replaceAll("/", "").replaceAll("\\", "").trim();
  const explicit = fileTypeFromName(trimmed);
  if (explicit) return requireFileTypeFromName(trimmed);
  if (/\.[^./\\]+$/.test(trimmed)) throw new Error("invalid-type");
  return fallback;
}

function nameForFileType(raw: string, fileType: FileType): string {
  const extension = `.${fileType}`;
  const sanitized = raw.replaceAll("/", "").replaceAll("\\", "").trim();
  const withoutSupportedExtension = sanitized.replace(/\.(md|html|sheet|board|csv|tsv)$/i, "");
  const stem = sanitized.toLowerCase().endsWith(extension)
    ? sanitized.slice(0, -extension.length)
    : withoutSupportedExtension;
  if (!stem.trim()) throw new Error("invalid-name");
  return cleanName(`${stem.slice(0, MAX_NAME_LENGTH - extension.length).trim()}${extension}`);
}

function importName(raw: string): string {
  return cleanName(raw, "import.md");
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
  if (!project || project.deletedAt || (project.cloneState && project.cloneState !== "ready")) {
    return null;
  }
  const caller = await callerFor(ctx, project.clerkOrgId);
  if (!caller) {
    return null;
  }
  let level: GrantLevel = "editor";
  if (!caller.isAdmin) {
    const grant = await ctx.db
      .query("projectAccess")
      .withIndex("by_project_user", (q) => q.eq("projectId", projectId).eq("userId", caller.userId))
      .unique();
    if (!grant) {
      return null;
    }
    level = grant.level ?? "editor";
  }
  return { project, userId: caller.userId, isAdmin: caller.isAdmin, level };
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

export async function requireProjectEditor(
  ctx: MutationCtx,
  projectId: Id<"projects">,
): Promise<Access> {
  const access = await accessForProject(ctx, projectId);
  if (!access || !(access.isAdmin || access.level === "editor")) {
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
  if (
    !parent ||
    parent.projectId !== projectId ||
    parent.kind !== "folder" ||
    (await isInactiveTree(ctx, parent))
  ) {
    throw new Error("invalid-parent");
  }
}

async function assertCapacity(ctx: QueryCtx, projectId: Id<"projects">): Promise<void> {
  const docs = await ctx.db
    .query("documents")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .collect();
  if (visibleDocuments(docs).length >= MAX_NODES_PER_PROJECT) {
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
    (doc) => !isInactive(doc) && doc._id !== exclude && doc.name.toLowerCase() === key,
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
    siblings.filter((doc) => !isInactive(doc)).map((doc) => doc.name.toLowerCase()),
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
  return liveDocumentBytes(docs);
}

export function liveDocumentBytes(documents: Array<Pick<Doc<"documents">, "size">>): number {
  return documents.reduce((sum, document) => sum + document.size, 0);
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
  const current = await ctx.db.get(project._id);
  if (!current) {
    return;
  }
  const totalBytes =
    typeof current.totalBytes === "number"
      ? Math.max(0, current.totalBytes + delta)
      : await projectTotalBytes(ctx, current._id);
  await ctx.db.patch(project._id, {
    totalBytes,
    byteVersion: (current.byteVersion ?? 0) + 1,
  });
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
      if (isInactive(current)) {
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

export async function purgeRecentDocumentBatch(
  ctx: MutationCtx,
  documentId: Id<"documents">,
): Promise<boolean> {
  const rows = await ctx.db
    .query("recentDocuments")
    .withIndex("by_document", (q) => q.eq("documentId", documentId))
    .take(PURGE_COLLAB_BATCH);
  for (const row of rows) {
    await ctx.db.delete(row._id);
  }
  return rows.length > 0;
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
    for (const doc of batch) {
      const hasMoreRecent = await purgeRecentDocumentBatch(ctx, doc._id);
      if (hasMoreRecent) {
        await accountFreed();
        await ctx.scheduler.runAfter(0, internal.documents.purgeSubtreeBatch, args);
        return;
      }
      if (doc.kind === "file") {
        const hasMoreCollab = await purgeDocCollabBatch(ctx, doc._id);
        if (hasMoreCollab) {
          await accountFreed();
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
    await accountFreed();
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
    return visibleDocuments(docs).map((doc) => ({
      id: doc._id,
      parentId: doc.parentId,
      kind: doc.kind,
      name: doc.name,
      fileType: doc.fileType,
      size: doc.size,
      mimeType: doc.mimeType,
      hasAsset: doc.kind === "asset" && doc.storageId !== null,
      assetUrl: null,
    }));
  },
});

export const getAssetUrls = query({
  args: { documentIds: v.array(v.id("documents")) },
  handler: async (ctx, args) => {
    const documentIds = [...new Set(args.documentIds)].slice(0, 100);
    const accessByProject = new Map<Id<"projects">, boolean>();
    const urls: { id: Id<"documents">; url: string }[] = [];
    for (const documentId of documentIds) {
      const doc = await ctx.db.get(documentId);
      if (doc?.kind !== "asset" || !doc.storageId || (await isInactiveTree(ctx, doc))) {
        continue;
      }
      let allowed = accessByProject.get(doc.projectId);
      if (allowed === undefined) {
        allowed = Boolean(await accessForProject(ctx, doc.projectId));
        accessByProject.set(doc.projectId, allowed);
      }
      if (!allowed) {
        continue;
      }
      const url = await ctx.storage.getUrl(doc.storageId);
      if (url) {
        urls.push({ id: doc._id, url });
      }
    }
    return urls;
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
      contentSeq: doc.contentSeq ?? 0,
      sheetMeta: doc.sheetMeta,
      boardMeta: doc.boardMeta,
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
    const access = await requireProjectEditor(ctx, args.projectId);
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
    const id = await ctx.db.insert("documents", {
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
    await recordProjectEvent(ctx, {
      projectId: args.projectId,
      clerkOrgId: access.project.clerkOrgId,
      kind: "node_created",
      documentId: id,
      targetName: name,
      detail: "folder",
    });
    return id;
  },
});

export const createFile = mutation({
  args: {
    projectId: v.id("projects"),
    parentId: v.union(v.id("documents"), v.null()),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectEditor(ctx, args.projectId);
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
    let content = "";
    let contentState: ArrayBuffer | undefined;
    let contentSeq: number | undefined;
    let size = 0;
    let sheetMeta: { rows: number; cols: number } | undefined;
    let boardMeta: { columns: number; cards: number } | undefined;
    if (fileType === "sheet") {
      const ydoc = new Y.Doc();
      sheetMeta = seedSheet(ydoc).dimensions;
      content = project(fileType, ydoc);
      size = documentSize(fileType, ydoc);
      contentState = toArrayBuffer(Y.encodeStateAsUpdate(ydoc));
      contentSeq = 1;
      ydoc.destroy();
      if (size > MAX_SHEET_STORED_BYTES) throw new Error("file-too-large");
      if (
        (await cachedProjectBytes(ctx, access.project)) + size >
        (await maxProjectBytes(ctx, access.project))
      ) {
        throw new Error("project-full");
      }
    } else if (fileType === "board") {
      const ydoc = new Y.Doc();
      boardMeta = seedBoard(ydoc).dimensions;
      content = project(fileType, ydoc);
      size = documentSize(fileType, ydoc);
      contentState = toArrayBuffer(Y.encodeStateAsUpdate(ydoc));
      contentSeq = 1;
      ydoc.destroy();
      if (size > MAX_BOARD_STORED_BYTES) throw new Error("file-too-large");
      if (
        (await cachedProjectBytes(ctx, access.project)) + size >
        (await maxProjectBytes(ctx, access.project))
      ) {
        throw new Error("project-full");
      }
    }
    const now = Date.now();
    const id = await ctx.db.insert("documents", {
      projectId: args.projectId,
      clerkOrgId: access.project.clerkOrgId,
      parentId: args.parentId,
      kind: "file",
      name,
      fileType,
      content,
      contentSeq,
      contentState,
      sheetMeta,
      boardMeta,
      storageId: null,
      mimeType: null,
      size,
      createdAt: now,
      updatedAt: now,
    });
    if (contentState) {
      await ctx.db.insert("yjsUpdates", {
        documentId: id,
        seq: 1,
        update: contentState,
        createdAt: now,
      });
      await addProjectBytes(ctx, access.project, size);
    }
    await recordProjectEvent(ctx, {
      projectId: args.projectId,
      clerkOrgId: access.project.clerkOrgId,
      kind: "node_created",
      documentId: id,
      targetName: name,
      detail: fileType,
    });
    return id;
  },
});

export const createFromTemplate = mutation({
  args: {
    projectId: v.id("projects"),
    parentId: v.union(v.id("documents"), v.null()),
    name: v.string(),
    fileType: v.union(v.literal("md"), v.literal("html"), v.literal("sheet"), v.literal("board")),
    templateId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectEditor(ctx, args.projectId);
    await assertParent(ctx, args.projectId, args.parentId);
    await assertCapacity(ctx, args.projectId);
    if ((await depthOf(ctx, args.parentId)) + 1 > MAX_DEPTH) throw new Error("too-deep");
    const fileType = requestedFileType(args.name, args.fileType);
    let content = "";
    let contentState: ArrayBuffer | undefined;
    if (args.templateId) {
      const templateId = ctx.db.normalizeId("orgTemplates", args.templateId);
      const template = templateId ? await ctx.db.get(templateId) : null;
      if (
        !template ||
        template.clerkOrgId !== access.project.clerkOrgId ||
        template.fileType !== fileType
      )
        throw new Error("invalid-template");
      content = template.content;
      contentState = template.contentState;
    }
    const name = nameForFileType(args.name, fileType);
    if (await nameTaken(ctx, args.projectId, args.parentId, name)) throw new Error("name-taken");
    const ydoc = new Y.Doc();
    if (contentState) {
      Y.applyUpdate(ydoc, new Uint8Array(contentState));
    } else if (fileType === "sheet") {
      seedSheet(ydoc);
    } else if (fileType === "board") {
      seedBoard(ydoc);
    } else if (content) {
      ydoc.getText("codemirror").insert(0, content);
    }
    content = project(fileType, ydoc);
    const size = documentSize(fileType, ydoc);
    const sheetMeta = fileType === "sheet" ? inspectSheet(ydoc).dimensions : undefined;
    const boardMeta = fileType === "board" ? inspectBoard(ydoc).dimensions : undefined;
    contentState = toArrayBuffer(Y.encodeStateAsUpdate(ydoc));
    ydoc.destroy();
    if (
      byteLength(content) > MAX_FILE_BYTES ||
      (fileType === "sheet" && size > MAX_SHEET_STORED_BYTES) ||
      (fileType === "board" && size > MAX_BOARD_STORED_BYTES)
    ) {
      throw new Error("file-too-large");
    }
    if (
      (await cachedProjectBytes(ctx, access.project)) + size >
      (await maxProjectBytes(ctx, access.project))
    )
      throw new Error("project-full");
    const now = Date.now();
    const id = await ctx.db.insert("documents", {
      projectId: args.projectId,
      clerkOrgId: access.project.clerkOrgId,
      parentId: args.parentId,
      kind: "file",
      name,
      fileType,
      content,
      contentSeq: 1,
      contentState,
      sheetMeta,
      boardMeta,
      storageId: null,
      mimeType: null,
      size,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("yjsUpdates", {
      documentId: id,
      seq: 1,
      update: contentState,
      createdAt: now,
    });
    await addProjectBytes(ctx, access.project, size);
    await recordProjectEvent(ctx, {
      projectId: args.projectId,
      clerkOrgId: access.project.clerkOrgId,
      kind: "node_created",
      documentId: id,
      targetName: name,
      detail: args.templateId ? "template" : fileType,
    });
    return id;
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
    const access = await requireProjectEditor(ctx, args.projectId);
    await assertParent(ctx, args.projectId, args.parentId);
    if ((await depthOf(ctx, args.parentId)) + 1 > MAX_DEPTH) {
      throw new Error("too-deep");
    }
    const docs = await ctx.db
      .query("documents")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    if (visibleDocuments(docs).length + args.files.length > MAX_NODES_PER_PROJECT) {
      throw new Error("too-many-nodes");
    }
    const siblings = new Set(
      (await childrenOf(ctx, args.projectId, args.parentId))
        .filter((doc) => !isInactive(doc))
        .map((doc) => doc.name.toLowerCase()),
    );
    const prepared = args.files.map((file) => {
      const name = importName(file.name);
      const fileType = requireFileTypeFromName(name);
      const size = byteLength(file.content);
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
    await recordProjectEvent(ctx, {
      projectId: args.projectId,
      clerkOrgId: access.project.clerkOrgId,
      kind: "documents_imported",
      targetName: `${prepared.length} ${prepared.length === 1 ? "document" : "documents"}`,
      detail: prepared
        .slice(0, 5)
        .map((file) => file.name)
        .join(", "),
    });
    return ids;
  },
});

export const importSheet = mutation({
  args: {
    projectId: v.id("projects"),
    parentId: v.union(v.id("documents"), v.null()),
    name: v.string(),
    updates: v.array(v.bytes()),
  },
  handler: async (ctx, args) => {
    if (
      args.updates.length < 1 ||
      args.updates.length > 32 ||
      args.updates.some((update) => update.byteLength > MAX_COLLAB_UPDATE_BYTES)
    ) {
      throw new Error("invalid-import");
    }
    const access = await requireProjectEditor(ctx, args.projectId);
    await assertParent(ctx, args.projectId, args.parentId);
    await assertCapacity(ctx, args.projectId);
    if ((await depthOf(ctx, args.parentId)) + 1 > MAX_DEPTH) throw new Error("too-deep");
    const name = nameForFileType(args.name, "sheet");
    if (await nameTaken(ctx, args.projectId, args.parentId, name)) throw new Error("name-taken");
    const ydoc = new Y.Doc();
    try {
      for (const update of args.updates) Y.applyUpdate(ydoc, new Uint8Array(update));
      const inspection = inspectSheet(ydoc);
      if (inspection.rows.length === 0 || inspection.cols.length === 0) {
        throw new Error("invalid-import");
      }
    } catch (error) {
      ydoc.destroy();
      if (error instanceof SheetValidationError) throw new Error(error.code);
      throw error;
    }
    const content = project("sheet", ydoc);
    const size = documentSize("sheet", ydoc);
    const sheetMeta = inspectSheet(ydoc).dimensions;
    const contentState = toArrayBuffer(Y.encodeStateAsUpdate(ydoc));
    ydoc.destroy();
    if (byteLength(content) > MAX_FILE_BYTES || size > MAX_SHEET_STORED_BYTES) {
      throw new Error("file-too-large");
    }
    if (
      (await cachedProjectBytes(ctx, access.project)) + size >
      (await maxProjectBytes(ctx, access.project))
    ) {
      throw new Error("project-full");
    }
    const now = Date.now();
    const id = await ctx.db.insert("documents", {
      projectId: args.projectId,
      clerkOrgId: access.project.clerkOrgId,
      parentId: args.parentId,
      kind: "file",
      name,
      fileType: "sheet",
      content,
      contentSeq: args.updates.length,
      contentState,
      sheetMeta,
      storageId: null,
      mimeType: null,
      size,
      createdAt: now,
      updatedAt: now,
    });
    for (const [index, update] of args.updates.entries()) {
      await ctx.db.insert("yjsUpdates", {
        documentId: id,
        seq: index + 1,
        update,
        createdAt: now,
      });
    }
    await addProjectBytes(ctx, access.project, size);
    await recordProjectEvent(ctx, {
      projectId: args.projectId,
      clerkOrgId: access.project.clerkOrgId,
      kind: "documents_imported",
      documentId: id,
      targetName: name,
      detail: "sheet",
    });
    return id;
  },
});

export const rename = mutation({
  args: { documentId: v.id("documents"), name: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (!doc || isInactive(doc)) {
      throw new Error("not-found");
    }
    const access = await requireProjectEditor(ctx, doc.projectId);
    const name = cleanName(args.name);
    let fileType = doc.fileType;
    if (doc.kind === "file") {
      fileType = requireFileTypeFromName(name);
    }
    if (await nameTaken(ctx, doc.projectId, doc.parentId, name, doc._id)) {
      throw new Error("name-taken");
    }
    if (name === doc.name) return;
    await ctx.db.patch(doc._id, { name, fileType, updatedAt: Date.now() });
    await recordProjectEvent(ctx, {
      projectId: doc.projectId,
      clerkOrgId: access.project.clerkOrgId,
      kind: "node_renamed",
      documentId: doc._id,
      targetName: name,
      previousValue: doc.name,
      nextValue: name,
    });
  },
});

export const move = mutation({
  args: { documentId: v.id("documents"), parentId: v.union(v.id("documents"), v.null()) },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (!doc || isInactive(doc)) {
      throw new Error("not-found");
    }
    const access = await requireProjectEditor(ctx, doc.projectId);
    if (doc.parentId === args.parentId) return;
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
    const [previousParent, nextParent] = await Promise.all([
      doc.parentId ? ctx.db.get(doc.parentId) : null,
      args.parentId ? ctx.db.get(args.parentId) : null,
    ]);
    await recordProjectEvent(ctx, {
      projectId: doc.projectId,
      clerkOrgId: access.project.clerkOrgId,
      kind: "node_moved",
      documentId: doc._id,
      targetName: doc.name,
      previousValue: previousParent?.name ?? "Root",
      nextValue: nextParent?.name ?? "Root",
    });
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
    siblings.filter((doc) => !isInactive(doc)).map((doc) => doc.name.toLowerCase()),
  );
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  const candidateFor = (suffix: string) => {
    const maxExtensionLength = Math.max(0, MAX_NAME_LENGTH - suffix.length - 1);
    const fittedExtension = extension.slice(0, maxExtensionLength);
    const fittedStem = stem.slice(
      0,
      Math.max(1, MAX_NAME_LENGTH - suffix.length - fittedExtension.length),
    );
    return `${fittedStem}${suffix}${fittedExtension}`;
  };
  const first = candidateFor(" (copy)");
  if (!taken.has(first.toLowerCase())) {
    return first;
  }
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = candidateFor(` (copy ${index})`);
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
    if (doc?.kind !== "file" || isInactive(doc)) {
      throw new Error("not-found");
    }
    const access = await requireProjectEditor(ctx, doc.projectId);
    await assertCapacity(ctx, doc.projectId);
    const total = await cachedProjectBytes(ctx, access.project);
    const max = await maxProjectBytes(ctx, access.project);
    if (total + doc.size > max) {
      throw new Error("project-full");
    }
    let state: ArrayBuffer | null = doc.contentState ?? null;
    if (!state && doc.fileType === "sheet") {
      const seedDoc = new Y.Doc();
      seedSheet(seedDoc);
      state = toArrayBuffer(Y.encodeStateAsUpdate(seedDoc));
      seedDoc.destroy();
    } else if (!state && doc.fileType === "board") {
      const seedDoc = new Y.Doc();
      seedBoard(seedDoc);
      state = toArrayBuffer(Y.encodeStateAsUpdate(seedDoc));
      seedDoc.destroy();
    } else if (!state && doc.content.length > 0) {
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
      sheetMeta: doc.sheetMeta,
      boardMeta: doc.boardMeta,
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
    await recordProjectEvent(ctx, {
      projectId: doc.projectId,
      clerkOrgId: access.project.clerkOrgId,
      kind: "document_duplicated",
      documentId: id,
      targetName: name,
      previousValue: doc.name,
    });
    return id;
  },
});

export const setContent = mutation({
  args: { documentId: v.id("documents"), content: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (doc?.kind !== "file" || isInactive(doc)) {
      throw new Error("not-found");
    }
    if (doc.fileType === "sheet" || doc.fileType === "board") {
      throw new Error("unsupported-filetype");
    }
    const access = await requireProjectEditor(ctx, doc.projectId);
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
    if (!doc || isInactive(doc)) {
      return;
    }
    const access = await requireProjectEditor(ctx, doc.projectId);
    await ctx.db.patch(doc._id, { trashedAt: Date.now(), updatedAt: Date.now() });
    await recordProjectEvent(ctx, {
      projectId: doc.projectId,
      clerkOrgId: access.project.clerkOrgId,
      kind: "node_trashed",
      documentId: doc._id,
      targetName: doc.name,
    });
  },
});

export const listTrash = query({
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
    const byId = new Map(docs.map((doc) => [doc._id, doc]));
    const roots = docs.filter((doc) => {
      if (!doc.trashedAt || doc.deletingAt) {
        return false;
      }
      let current = doc.parentId ? byId.get(doc.parentId) : undefined;
      const seen = new Set<Id<"documents">>();
      while (current && !seen.has(current._id)) {
        seen.add(current._id);
        if (isInactive(current)) {
          return false;
        }
        current = current.parentId ? byId.get(current.parentId) : undefined;
      }
      return true;
    });
    return roots
      .sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0))
      .map((doc) => ({
        id: doc._id,
        kind: doc.kind,
        name: doc.name,
        fileType: doc.fileType,
        size: doc.size,
        trashedAt: doc.trashedAt ?? 0,
      }));
  },
});

export const restoreDocument = mutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (!doc?.trashedAt || doc.deletingAt) {
      throw new Error("not-found");
    }
    const access = await requireProjectEditor(ctx, doc.projectId);
    let parentId = doc.parentId;
    if (parentId) {
      const parent = await ctx.db.get(parentId);
      if (!parent || isInactive(parent) || parent.kind !== "folder") {
        parentId = null;
      }
    }
    const name = (await nameTaken(ctx, doc.projectId, parentId, doc.name, doc._id))
      ? await uniqueName(ctx, doc.projectId, parentId, doc.name)
      : doc.name;
    await ctx.db.patch(doc._id, {
      trashedAt: undefined,
      parentId,
      name,
      updatedAt: Date.now(),
    });
    await recordProjectEvent(ctx, {
      projectId: doc.projectId,
      clerkOrgId: access.project.clerkOrgId,
      kind: "node_restored",
      documentId: doc._id,
      targetName: name,
    });
    return doc._id;
  },
});

export const deleteForever = mutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (!doc?.trashedAt || doc.deletingAt) {
      throw new Error("not-found");
    }
    const access = await requireProjectAdmin(ctx, doc.projectId);
    await recordProjectEvent(ctx, {
      projectId: doc.projectId,
      clerkOrgId: access.project.clerkOrgId,
      kind: "node_deleted",
      documentId: doc._id,
      targetName: doc.name,
    });
    await ctx.db.patch(doc._id, { deletingAt: Date.now(), updatedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.documents.purgeSubtreeBatch, {
      projectId: access.project._id,
      rootId: doc._id,
    });
  },
});

export const purgeExpiredTrash = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - TRASH_RETENTION_MS;
    const rows = await ctx.db
      .query("documents")
      .withIndex("by_trashed", (q) => q.gt("trashedAt", 0))
      .take(200);
    for (const doc of rows) {
      if ((doc.trashedAt ?? 0) < cutoff && !doc.deletingAt) {
        await ctx.db.patch(doc._id, { deletingAt: Date.now(), updatedAt: Date.now() });
        await ctx.scheduler.runAfter(0, internal.documents.purgeSubtreeBatch, {
          projectId: doc.projectId,
          rootId: doc._id,
        });
      }
    }
  },
});

export const generateUploadUrl = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireProjectEditor(ctx, args.projectId);
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
    const access = await requireProjectEditor(ctx, args.projectId);
    const documentReference = await ctx.db
      .query("documents")
      .withIndex("by_storage", (q) => q.eq("storageId", args.storageId))
      .first();
    const projectReference = await ctx.db
      .query("projects")
      .withIndex("by_image_storage", (q) => q.eq("imageStorageId", args.storageId))
      .first();
    if (documentReference || projectReference) {
      throw new Error("storage-in-use");
    }
    const meta = await ctx.db.system.get(args.storageId);
    if (!meta) {
      throw new Error("invalid-asset");
    }
    const mimeType = meta.contentType ?? "";
    if (!isRasterAssetMimeType(mimeType)) {
      await ctx.storage.delete(args.storageId);
      throw new Error("invalid-asset");
    }
    if (meta.size > MAX_ASSET_BYTES) {
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
    await recordProjectEvent(ctx, {
      projectId: args.projectId,
      clerkOrgId: access.project.clerkOrgId,
      kind: "node_created",
      documentId: id,
      targetName: name,
      detail: "asset",
    });
    return { id, name };
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
    const results = [];
    for (const doc of hits) {
      if (await isInactiveTree(ctx, doc)) {
        continue;
      }
      results.push({
        id: doc._id,
        parentId: doc.parentId,
        name: doc.name,
        fileType: doc.fileType,
        snippet: buildSnippet(doc.content, term),
      });
    }
    return results;
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
      visibleDocuments(docs).map(async (doc) => {
        let content = doc.kind === "file" ? doc.content : "";
        if (doc.kind === "file" && doc.fileType === "sheet" && doc.contentState) {
          const ydoc = new Y.Doc();
          Y.applyUpdate(ydoc, new Uint8Array(doc.contentState));
          const model = sheetRenderModel(ydoc);
          content = serializeDelimited(
            model.rows.map((row) => row.values),
            ",",
            "\r\n",
          );
          ydoc.destroy();
        } else if (doc.kind === "file" && doc.fileType === "board" && doc.contentState) {
          const ydoc = new Y.Doc();
          Y.applyUpdate(ydoc, new Uint8Array(doc.contentState));
          const model = boardRenderModel(ydoc);
          content = model.columns
            .map((column) =>
              [
                `## ${column.name}`,
                ...column.cards.map(
                  (card) => `- **${card.title}**\n\n  ${card.description.replaceAll("\n", "\n  ")}`,
                ),
              ].join("\n\n"),
            )
            .join("\n\n");
          ydoc.destroy();
        }
        return {
          id: doc._id,
          parentId: doc.parentId,
          kind: doc.kind,
          name: doc.name,
          fileType: doc.fileType,
          content,
          mimeType: doc.mimeType,
          assetUrl:
            doc.kind === "asset" && doc.storageId ? await ctx.storage.getUrl(doc.storageId) : null,
        };
      }),
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
