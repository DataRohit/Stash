import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import * as Y from "yjs";
import { canAdministerProject, canEditProject, projectRole } from "../lib/access-policy";
import { assetMaxBytes, isAllowedAssetMimeType, matchesAssetSignature } from "../lib/asset-formats";
import { inspectBoard, MAX_BOARD_STORED_BYTES, seedBoard } from "../lib/board-model";
import { type ChartSource, resolveChartData } from "../lib/chart-data";
import { MAX_CHART_STORED_BYTES, seedChart } from "../lib/chart-model";
import { renderChartSvg } from "../lib/chart-svg";
import {
  inspectDashboard,
  MAX_DASHBOARD_STORED_BYTES,
  seedDashboard,
} from "../lib/dashboard-model";
import {
  boardRenderModel,
  chartRenderModel,
  chartSourceFromSheet,
  documentSize,
  project,
  sheetRenderModel,
} from "../lib/doc-projection";
import type { FileType } from "../lib/document-types";
import { TRASH_RETENTION_MS } from "../lib/lifecycle";
import { serializeDelimited } from "../lib/sheet-csv";
import {
  inspectSheet,
  MAX_SHEET_STORED_BYTES,
  SheetValidationError,
  seedSheet,
} from "../lib/sheet-model";
import { inspectView, MAX_VIEW_STORED_BYTES, seedView } from "../lib/view-model";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { recordProjectEvent } from "./activity";
import { belongsToOrganization, isOrganizationAdmin, organizationId } from "./auth";
import {
  clampInt,
  DEFAULT_MAX_PROJECT_BYTES,
  HARD_MAX_PROJECT_BYTES,
  MIN_PROJECT_BYTES,
} from "./limits";
import { secretMatches } from "./secrets";
import { ensureAutoWatch } from "./watchHelpers";
import { enforceWriteRateLimit } from "./writeRateLimit";

const MAX_NAME_LENGTH = 80;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_COLLAB_UPDATE_BYTES = 768 * 1024;
const MAX_NODES_PER_PROJECT = 2000;
const MAX_DEPTH = 16;
const PURGE_COLLAB_BATCH = 200;
const PURGE_DOCUMENT_BATCH = 20;
const MAX_BULK_ITEMS = 200;
const BULK_WRITE_LIMIT = { capacity: 12, refillPerSecond: 0.2 };
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

export async function syncDocumentNode(
  ctx: MutationCtx,
  documentId: Id<"documents">,
): Promise<void> {
  const [doc, existing] = await Promise.all([
    ctx.db.get(documentId),
    ctx.db
      .query("documentNodes")
      .withIndex("by_document", (q) => q.eq("documentId", documentId))
      .unique(),
  ]);
  if (!doc) {
    if (existing) await ctx.db.delete(existing._id);
    return;
  }
  const value = {
    documentId: doc._id,
    projectId: doc.projectId,
    parentId: doc.parentId,
    kind: doc.kind,
    name: doc.name,
    fileType: doc.fileType,
    size: doc.size,
    mimeType: doc.mimeType,
    hasAsset: doc.kind === "asset" && doc.storageId !== null,
    deletingAt: doc.deletingAt,
    trashedAt: doc.trashedAt,
    updatedAt: doc.updatedAt,
  };
  if (existing) await ctx.db.patch(existing._id, value);
  else await ctx.db.insert("documentNodes", value);
}

export async function documentState(
  ctx: QueryCtx,
  doc: Doc<"documents">,
): Promise<ArrayBuffer | null> {
  const updates = await ctx.db
    .query("yjsUpdates")
    .withIndex("by_document", (q) => q.eq("documentId", doc._id).gt("seq", doc.contentSeq ?? 0))
    .collect();
  if (!doc.contentState && updates.length === 0) return null;
  const ydoc = new Y.Doc();
  if (doc.contentState) Y.applyUpdate(ydoc, new Uint8Array(doc.contentState));
  for (const update of updates) Y.applyUpdate(ydoc, new Uint8Array(update.update));
  const state = toArrayBuffer(Y.encodeStateAsUpdate(ydoc));
  ydoc.destroy();
  return state;
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
  if (lower.endsWith(".view")) {
    return "view";
  }
  if (lower.endsWith(".chart")) {
    return "chart";
  }
  if (lower.endsWith(".dashboard")) {
    return "dashboard";
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
  const withoutSupportedExtension = sanitized.replace(
    /\.(md|html|sheet|board|view|chart|dashboard|csv|tsv)$/i,
    "",
  );
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
  if (!belongsToOrganization(identity, clerkOrgId)) {
    return null;
  }
  return { userId: identity.subject, isAdmin: isOrganizationAdmin(identity, clerkOrgId) };
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
  if (!access || !canEditProject(projectRole(access.isAdmin, access.level))) {
    throw new Error("Forbidden");
  }
  return access;
}

export async function requireProjectAdmin(
  ctx: MutationCtx,
  projectId: Id<"projects">,
): Promise<Access> {
  const access = await accessForProject(ctx, projectId);
  if (!access || !canAdministerProject(projectRole(access.isAdmin, access.level))) {
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

export function visibleDocuments<
  T extends {
    _id: Id<"documents">;
    parentId: Id<"documents"> | null;
    deletingAt?: number;
    trashedAt?: number;
  },
>(docs: T[]): T[] {
  const byId = new Map(docs.map((doc) => [doc._id, doc]));
  const hidden = new Set<Id<"documents">>();
  for (const doc of docs) {
    let current: T | undefined = doc;
    const seen = new Set<Id<"documents">>();
    while (current && !seen.has(current._id)) {
      seen.add(current._id);
      if (current.deletingAt || current.trashedAt) {
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
  if (comments.length > 0) {
    return true;
  }
  const documentMentions = await ctx.db
    .query("documentMentions")
    .withIndex("by_document", (q) => q.eq("documentId", documentId))
    .take(PURGE_COLLAB_BATCH);
  for (const row of documentMentions) await ctx.db.delete(row._id);
  if (documentMentions.length > 0) return true;
  const propertyValues = await ctx.db
    .query("documentPropertyValues")
    .withIndex("by_document", (q) => q.eq("documentId", documentId))
    .take(PURGE_COLLAB_BATCH);
  for (const row of propertyValues) await ctx.db.delete(row._id);
  if (propertyValues.length > 0) return true;
  const cardRecords = await ctx.db
    .query("boardCardRecords")
    .withIndex("by_document", (q) => q.eq("documentId", documentId))
    .take(PURGE_COLLAB_BATCH);
  for (const row of cardRecords) await ctx.db.delete(row._id);
  if (cardRecords.length > 0) return true;
  const outgoingLinks = await ctx.db
    .query("documentLinks")
    .withIndex("by_source_document", (q) => q.eq("sourceDocumentId", documentId))
    .take(PURGE_COLLAB_BATCH);
  for (const row of outgoingLinks) await ctx.db.delete(row._id);
  if (outgoingLinks.length > 0) return true;
  const incomingLinks = await ctx.db
    .query("documentLinks")
    .withIndex("by_target_document", (q) => q.eq("targetDocumentId", documentId))
    .take(PURGE_COLLAB_BATCH);
  for (const row of incomingLinks) await ctx.db.delete(row._id);
  return incomingLinks.length > 0;
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
  if (rows.length > 0) return true;
  const favorites = await ctx.db
    .query("favorites")
    .withIndex("by_document", (q) => q.eq("documentId", documentId))
    .take(PURGE_COLLAB_BATCH);
  for (const row of favorites) await ctx.db.delete(row._id);
  if (favorites.length > 0) return true;
  const watches = await ctx.db
    .query("documentWatches")
    .withIndex("by_document", (q) => q.eq("documentId", documentId))
    .take(PURGE_COLLAB_BATCH);
  for (const row of watches) await ctx.db.delete(row._id);
  return watches.length > 0;
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
      await syncDocumentNode(ctx, doc._id);
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
    const projected = await ctx.db
      .query("documentNodes")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    const docs: Array<{
      _id: Id<"documents">;
      parentId: Id<"documents"> | null;
      kind: "folder" | "file" | "asset";
      name: string;
      fileType: Doc<"documents">["fileType"];
      size: number;
      mimeType: string | null;
      hasAsset: boolean;
      deletingAt?: number;
      trashedAt?: number;
    }> = access.project.treeProjectedAt
      ? projected.map((node) => ({
          _id: node.documentId,
          parentId: node.parentId,
          kind: node.kind,
          name: node.name,
          fileType: node.fileType,
          size: node.size,
          mimeType: node.mimeType,
          hasAsset: node.hasAsset,
          deletingAt: node.deletingAt,
          trashedAt: node.trashedAt,
        }))
      : (
          await ctx.db
            .query("documents")
            .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
            .collect()
        ).map((doc) => ({
          _id: doc._id,
          parentId: doc.parentId,
          kind: doc.kind,
          name: doc.name,
          fileType: doc.fileType,
          size: doc.size,
          mimeType: doc.mimeType,
          hasAsset: doc.kind === "asset" && doc.storageId !== null,
          deletingAt: doc.deletingAt,
          trashedAt: doc.trashedAt,
        }));
    return visibleDocuments(docs).map((doc) => ({
      id: doc._id,
      parentId: doc.parentId,
      kind: doc.kind,
      name: doc.name,
      fileType: doc.fileType,
      size: doc.size,
      mimeType: doc.mimeType,
      hasAsset: doc.hasAsset,
      assetUrl: null,
    }));
  },
});

export const backfillDocumentNodes = internalMutation({
  args: { projectId: v.id("projects"), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("documents")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .paginate({ cursor: args.cursor ?? null, numItems: 5, maximumRowsRead: 5 });
    for (const doc of page.page) await syncDocumentNode(ctx, doc._id);
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.documents.backfillDocumentNodes, {
        projectId: args.projectId,
        cursor: page.continueCursor,
      });
    } else {
      await ctx.db.patch(args.projectId, { treeProjectedAt: Date.now() });
    }
    return { scanned: page.page.length, isDone: page.isDone };
  },
});

export const scheduleDocumentNodeBackfill = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("projects")
      .paginate({ cursor: args.cursor ?? null, numItems: 50, maximumRowsRead: 50 });
    for (const project of page.page) {
      if (!project.treeProjectedAt && !project.deletedAt) {
        await ctx.scheduler.runAfter(0, internal.documents.backfillDocumentNodes, {
          projectId: project._id,
        });
      }
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.documents.scheduleDocumentNodeBackfill, {
        cursor: page.continueCursor,
      });
    }
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
    if (await isInactiveTree(ctx, doc)) {
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
    await syncDocumentNode(ctx, id);
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
    } else if (fileType === "view") {
      const ydoc = new Y.Doc();
      seedView(ydoc);
      content = project(fileType, ydoc);
      size = documentSize(fileType, ydoc);
      contentState = toArrayBuffer(Y.encodeStateAsUpdate(ydoc));
      contentSeq = 1;
      ydoc.destroy();
      if (size > MAX_VIEW_STORED_BYTES) throw new Error("file-too-large");
      if (
        (await cachedProjectBytes(ctx, access.project)) + size >
        (await maxProjectBytes(ctx, access.project))
      ) {
        throw new Error("project-full");
      }
    } else if (fileType === "chart") {
      const ydoc = new Y.Doc();
      seedChart(ydoc);
      content = project(fileType, ydoc);
      size = documentSize(fileType, ydoc);
      contentState = toArrayBuffer(Y.encodeStateAsUpdate(ydoc));
      contentSeq = 1;
      ydoc.destroy();
      if (size > MAX_CHART_STORED_BYTES) throw new Error("file-too-large");
      if (
        (await cachedProjectBytes(ctx, access.project)) + size >
        (await maxProjectBytes(ctx, access.project))
      ) {
        throw new Error("project-full");
      }
    } else if (fileType === "dashboard") {
      const ydoc = new Y.Doc();
      content = project(fileType, ydoc);
      size = documentSize(fileType, ydoc);
      contentState = toArrayBuffer(Y.encodeStateAsUpdate(ydoc));
      contentSeq = 1;
      ydoc.destroy();
      if (size > MAX_DASHBOARD_STORED_BYTES) throw new Error("file-too-large");
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
    await syncDocumentNode(ctx, id);
    if (contentState) {
      await ctx.db.insert("yjsUpdates", {
        documentId: id,
        seq: 1,
        update: contentState,
        createdAt: now,
      });
      await addProjectBytes(ctx, access.project, size);
    }
    if (fileType === "board") {
      await ctx.scheduler.runAfter(0, internal.collab.rebuildBoardIndexes, { documentId: id });
    }
    await recordProjectEvent(ctx, {
      projectId: args.projectId,
      clerkOrgId: access.project.clerkOrgId,
      kind: "node_created",
      documentId: id,
      targetName: name,
      detail: fileType,
    });
    await ensureAutoWatch(ctx, {
      clerkOrgId: access.project.clerkOrgId,
      userId: access.userId,
      projectId: args.projectId,
      documentId: id,
    });
    return id;
  },
});

export const createFromTemplate = mutation({
  args: {
    projectId: v.id("projects"),
    parentId: v.union(v.id("documents"), v.null()),
    name: v.string(),
    fileType: v.union(
      v.literal("md"),
      v.literal("html"),
      v.literal("sheet"),
      v.literal("board"),
      v.literal("view"),
      v.literal("chart"),
      v.literal("dashboard"),
    ),
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
    } else if (fileType === "view") {
      seedView(ydoc);
    } else if (fileType === "chart") {
      seedChart(ydoc);
    } else if (fileType === "dashboard") {
      ydoc.getMap("dashboardTiles");
      ydoc.getArray("dashboardTileOrder");
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
      (fileType === "board" && size > MAX_BOARD_STORED_BYTES) ||
      (fileType === "view" && size > MAX_VIEW_STORED_BYTES) ||
      (fileType === "chart" && size > MAX_CHART_STORED_BYTES) ||
      (fileType === "dashboard" && size > MAX_DASHBOARD_STORED_BYTES)
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
    await syncDocumentNode(ctx, id);
    await ctx.db.insert("yjsUpdates", {
      documentId: id,
      seq: 1,
      update: contentState,
      createdAt: now,
    });
    await addProjectBytes(ctx, access.project, size);
    if (fileType === "board") {
      await ctx.scheduler.runAfter(0, internal.collab.rebuildBoardIndexes, { documentId: id });
    }
    await recordProjectEvent(ctx, {
      projectId: args.projectId,
      clerkOrgId: access.project.clerkOrgId,
      kind: "node_created",
      documentId: id,
      targetName: name,
      detail: args.templateId ? "template" : fileType,
    });
    await ensureAutoWatch(ctx, {
      clerkOrgId: access.project.clerkOrgId,
      userId: access.userId,
      projectId: args.projectId,
      documentId: id,
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
      await syncDocumentNode(ctx, id);
      await ctx.db.insert("yjsUpdates", { documentId: id, seq: 1, update: state, createdAt: now });
      await ensureAutoWatch(ctx, {
        clerkOrgId: access.project.clerkOrgId,
        userId: access.userId,
        projectId: args.projectId,
        documentId: id,
      });
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
    await syncDocumentNode(ctx, id);
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
    await ensureAutoWatch(ctx, {
      clerkOrgId: access.project.clerkOrgId,
      userId: access.userId,
      projectId: args.projectId,
      documentId: id,
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
      if (fileType !== doc.fileType) throw new Error("file-type-change-unsupported");
    }
    if (await nameTaken(ctx, doc.projectId, doc.parentId, name, doc._id)) {
      throw new Error("name-taken");
    }
    if (name === doc.name) return;
    await ctx.db.patch(doc._id, { name, fileType, updatedAt: Date.now() });
    await syncDocumentNode(ctx, doc._id);
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
    await syncDocumentNode(ctx, doc._id);
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

function bulkRoots(documents: Doc<"documents">[], ids: Id<"documents">[]): Id<"documents">[] {
  const selected = new Set(ids);
  const byId = new Map(documents.map((doc) => [doc._id, doc]));
  return ids.filter((id) => {
    let current = byId.get(id)?.parentId;
    const seen = new Set<Id<"documents">>();
    while (current && !seen.has(current)) {
      if (selected.has(current)) return false;
      seen.add(current);
      current = byId.get(current)?.parentId ?? null;
    }
    return true;
  });
}

function bulkError(error: unknown): string {
  return error instanceof Error ? error.message : "failed";
}

export const bulkMove = mutation({
  args: {
    projectId: v.id("projects"),
    documentIds: v.array(v.id("documents")),
    parentId: v.union(v.id("documents"), v.null()),
  },
  handler: async (ctx, args) => {
    if (args.documentIds.length < 1 || args.documentIds.length > MAX_BULK_ITEMS) {
      throw new Error("too-many-items");
    }
    const access = await requireProjectEditor(ctx, args.projectId);
    if (
      !(await enforceWriteRateLimit(
        ctx,
        "bulk-documents",
        args.projectId,
        access.userId,
        BULK_WRITE_LIMIT,
      ))
    ) {
      throw new Error("rate-limited");
    }
    if (args.parentId) await assertParent(ctx, args.projectId, args.parentId);
    const documents = await ctx.db
      .query("documents")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    const ids = bulkRoots(documents, [...new Set(args.documentIds)]);
    const results: Array<{ id: Id<"documents">; ok: boolean; error?: string }> = [];
    for (const id of ids) {
      try {
        const doc = await ctx.db.get(id);
        if (!doc || doc.projectId !== args.projectId || isInactive(doc))
          throw new Error("not-found");
        if (args.parentId === doc._id) throw new Error("invalid-target");
        const descendants = await subtree(ctx, doc.projectId, doc._id);
        if (args.parentId && descendants.some((node) => node._id === args.parentId)) {
          throw new Error("invalid-target");
        }
        if (
          (await depthOf(ctx, args.parentId)) +
            1 +
            (await subtreeHeight(ctx, doc.projectId, doc._id)) >
          MAX_DEPTH
        ) {
          throw new Error("too-deep");
        }
        if (await nameTaken(ctx, doc.projectId, args.parentId, doc.name, doc._id)) {
          throw new Error("name-taken");
        }
        await ctx.db.patch(doc._id, { parentId: args.parentId, updatedAt: Date.now() });
        await syncDocumentNode(ctx, doc._id);
        results.push({ id, ok: true });
      } catch (error) {
        results.push({ id, ok: false, error: bulkError(error) });
      }
    }
    const moved = results.filter((result) => result.ok).length;
    if (moved > 0) {
      const parent = args.parentId ? await ctx.db.get(args.parentId) : null;
      await recordProjectEvent(ctx, {
        projectId: args.projectId,
        clerkOrgId: access.project.clerkOrgId,
        kind: "node_moved",
        targetName: `${moved} ${moved === 1 ? "item" : "items"}`,
        detail: "bulk",
        nextValue: parent?.name ?? "Root",
      });
    }
    return results;
  },
});

export const bulkTrash = mutation({
  args: { projectId: v.id("projects"), documentIds: v.array(v.id("documents")) },
  handler: async (ctx, args) => {
    if (args.documentIds.length < 1 || args.documentIds.length > MAX_BULK_ITEMS) {
      throw new Error("too-many-items");
    }
    const access = await requireProjectEditor(ctx, args.projectId);
    if (
      !(await enforceWriteRateLimit(
        ctx,
        "bulk-documents",
        args.projectId,
        access.userId,
        BULK_WRITE_LIMIT,
      ))
    ) {
      throw new Error("rate-limited");
    }
    const documents = await ctx.db
      .query("documents")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    const ids = bulkRoots(documents, [...new Set(args.documentIds)]);
    const results = [];
    const now = Date.now();
    for (const id of ids) {
      const doc = await ctx.db.get(id);
      if (!doc || doc.projectId !== args.projectId || isInactive(doc)) {
        results.push({ id, ok: false, error: "not-found" });
        continue;
      }
      await ctx.db.patch(id, { trashedAt: now, updatedAt: now });
      await syncDocumentNode(ctx, id);
      results.push({ id, ok: true, error: undefined });
    }
    const trashed = results.filter((result) => result.ok).length;
    if (trashed > 0) {
      await recordProjectEvent(ctx, {
        projectId: args.projectId,
        clerkOrgId: access.project.clerkOrgId,
        kind: "node_trashed",
        targetName: `${trashed} ${trashed === 1 ? "item" : "items"}`,
        detail: "bulk",
      });
    }
    return results;
  },
});

export const bulkRestore = mutation({
  args: { projectId: v.id("projects"), documentIds: v.array(v.id("documents")) },
  handler: async (ctx, args) => {
    if (args.documentIds.length < 1 || args.documentIds.length > MAX_BULK_ITEMS) {
      throw new Error("too-many-items");
    }
    const access = await requireProjectEditor(ctx, args.projectId);
    if (
      !(await enforceWriteRateLimit(
        ctx,
        "bulk-documents",
        args.projectId,
        access.userId,
        BULK_WRITE_LIMIT,
      ))
    ) {
      throw new Error("rate-limited");
    }
    const results = [];
    for (const id of [...new Set(args.documentIds)]) {
      try {
        const doc = await ctx.db.get(id);
        if (!doc?.trashedAt || doc.deletingAt || doc.projectId !== args.projectId) {
          throw new Error("not-found");
        }
        let parentId = doc.parentId;
        if (parentId) {
          const parent = await ctx.db.get(parentId);
          if (!parent || isInactive(parent) || parent.kind !== "folder") parentId = null;
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
        await syncDocumentNode(ctx, doc._id);
        results.push({ id, ok: true, error: undefined });
      } catch (error) {
        results.push({ id, ok: false, error: bulkError(error) });
      }
    }
    const restored = results.filter((result) => result.ok).length;
    if (restored > 0) {
      await recordProjectEvent(ctx, {
        projectId: args.projectId,
        clerkOrgId: access.project.clerkOrgId,
        kind: "node_restored",
        targetName: `${restored} ${restored === 1 ? "item" : "items"}`,
        detail: "bulk",
      });
    }
    return results;
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
    let state = await documentState(ctx, doc);
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
    } else if (!state && doc.fileType === "view") {
      const seedDoc = new Y.Doc();
      seedView(seedDoc);
      state = toArrayBuffer(Y.encodeStateAsUpdate(seedDoc));
      seedDoc.destroy();
    } else if (!state && doc.fileType === "chart") {
      const seedDoc = new Y.Doc();
      seedChart(seedDoc);
      state = toArrayBuffer(Y.encodeStateAsUpdate(seedDoc));
      seedDoc.destroy();
    } else if (!state && doc.fileType === "dashboard") {
      const seedDoc = new Y.Doc();
      seedDashboard(seedDoc);
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
    await syncDocumentNode(ctx, id);
    if (state) {
      await ctx.db.insert("yjsUpdates", { documentId: id, seq: 1, update: state, createdAt: now });
    }
    const propertyValues = await ctx.db
      .query("documentPropertyValues")
      .withIndex("by_document", (q) => q.eq("documentId", doc._id))
      .collect();
    for (const value of propertyValues) {
      await ctx.db.insert("documentPropertyValues", {
        documentId: id,
        propertyId: value.propertyId,
        projectId: doc.projectId,
        clerkOrgId: doc.clerkOrgId,
        type: value.type,
        displayValue: value.displayValue,
        textValue: value.textValue,
        numberValue: value.numberValue,
        booleanValue: value.booleanValue,
        dateValue: value.dateValue,
        dateEndValue: value.dateEndValue,
        statusOptionId: value.statusOptionId,
        personUserId: value.personUserId,
        updatedBy: access.userId,
        updatedAt: now,
      });
    }
    const links = await ctx.db
      .query("documentLinks")
      .withIndex("by_source_document", (q) => q.eq("sourceDocumentId", doc._id))
      .collect();
    for (const link of links) {
      await ctx.db.insert("documentLinks", {
        clerkOrgId: link.clerkOrgId,
        sourceProjectId: link.sourceProjectId,
        sourceDocumentId: id,
        sourceCardId: link.sourceCardId,
        managedByBoard: link.managedByBoard,
        managedByText: link.managedByText,
        targetProjectId: link.targetProjectId,
        targetDocumentId: link.targetDocumentId,
        createdBy: access.userId,
        createdAt: now,
        updatedAt: now,
      });
    }
    await addProjectBytes(ctx, access.project, doc.size);
    if (doc.fileType === "board") {
      await ctx.scheduler.runAfter(0, internal.collab.rebuildBoardIndexes, { documentId: id });
    }
    await recordProjectEvent(ctx, {
      projectId: doc.projectId,
      clerkOrgId: access.project.clerkOrgId,
      kind: "document_duplicated",
      documentId: id,
      targetName: name,
      previousValue: doc.name,
    });
    await ensureAutoWatch(ctx, {
      clerkOrgId: access.project.clerkOrgId,
      userId: access.userId,
      projectId: doc.projectId,
      documentId: id,
    });
    return id;
  },
});

const duplicateReference = makeFunctionReference<
  "mutation",
  { documentId: Id<"documents"> },
  Id<"documents">
>("documents:duplicate");

export const bulkDuplicate = action({
  args: { documentIds: v.array(v.id("documents")) },
  handler: async (ctx, args) => {
    if (args.documentIds.length < 1 || args.documentIds.length > MAX_BULK_ITEMS) {
      throw new Error("too-many-items");
    }
    const results: Array<{
      id: Id<"documents">;
      ok: boolean;
      duplicateId?: Id<"documents">;
      error?: string;
    }> = [];
    for (const id of [...new Set(args.documentIds)]) {
      try {
        const duplicateId = await ctx.runMutation(duplicateReference, { documentId: id });
        results.push({ id, ok: true, duplicateId });
      } catch (error) {
        results.push({ id, ok: false, error: bulkError(error) });
      }
    }
    return results;
  },
});

export const setContent = mutation({
  args: { documentId: v.id("documents"), content: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (doc?.kind !== "file" || isInactive(doc)) {
      throw new Error("not-found");
    }
    if (
      doc.fileType === "sheet" ||
      doc.fileType === "board" ||
      doc.fileType === "view" ||
      doc.fileType === "chart" ||
      doc.fileType === "dashboard"
    ) {
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
    await syncDocumentNode(ctx, doc._id);
    await ctx.db.patch(access.project._id, { lastSavedAt: Date.now() });
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
    await syncDocumentNode(ctx, doc._id);
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
    await syncDocumentNode(ctx, doc._id);
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
    await syncDocumentNode(ctx, doc._id);
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
        await syncDocumentNode(ctx, doc._id);
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

export const assetUploadInfo = internalQuery({
  args: {
    projectId: v.id("projects"),
    storageId: v.id("_storage"),
    userId: v.string(),
    clerkOrgId: v.string(),
    isAdmin: v.boolean(),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project || project.deletedAt || project.clerkOrgId !== args.clerkOrgId) return null;
    if (!args.isAdmin) {
      const grant = await ctx.db
        .query("projectAccess")
        .withIndex("by_project_user", (q) =>
          q.eq("projectId", args.projectId).eq("userId", args.userId),
        )
        .unique();
      if (!grant || (grant.level ?? "editor") !== "editor") return null;
    }
    const meta = await ctx.db.system.get(args.storageId);
    return meta ? { mimeType: meta.contentType ?? "", size: meta.size } : null;
  },
});

export const recordValidatedUpload = internalMutation({
  args: {
    projectId: v.id("projects"),
    storageId: v.id("_storage"),
    userId: v.string(),
    mimeType: v.string(),
    size: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("validatedUploads")
      .withIndex("by_storage", (q) => q.eq("storageId", args.storageId))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
    await ctx.db.insert("validatedUploads", {
      ...args,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
  },
});

export const validateAssetUpload = action({
  args: { projectId: v.id("projects"), storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("forbidden");
    const clerkOrgId = organizationId(identity);
    if (!clerkOrgId) throw new Error("forbidden");
    const info = await ctx.runQuery(internal.documents.assetUploadInfo, {
      ...args,
      userId: identity.subject,
      clerkOrgId,
      isAdmin: isOrganizationAdmin(identity, clerkOrgId),
    });
    if (!info) throw new Error("invalid-asset");
    const maxBytes = assetMaxBytes(info.mimeType);
    if (!isAllowedAssetMimeType(info.mimeType) || maxBytes === null || info.size > maxBytes) {
      await ctx.storage.delete(args.storageId);
      throw new Error(
        maxBytes !== null && info.size > maxBytes ? "file-too-large" : "invalid-asset",
      );
    }
    const blob = await ctx.storage.get(args.storageId);
    const signature = blob
      ? new Uint8Array(await blob.slice(0, Math.min(blob.size, 4096)).arrayBuffer())
      : null;
    if (!signature || !matchesAssetSignature(info.mimeType, signature)) {
      await ctx.storage.delete(args.storageId);
      throw new Error("asset-signature-mismatch");
    }
    await ctx.runMutation(internal.documents.recordValidatedUpload, {
      ...args,
      userId: identity.subject,
      mimeType: info.mimeType,
      size: info.size,
    });
    return true;
  },
});

export const pruneValidatedUploads = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("validatedUploads")
      .withIndex("by_expires", (q) => q.lt("expiresAt", Date.now()))
      .take(PURGE_COLLAB_BATCH);
    for (const row of rows) await ctx.db.delete(row._id);
    if (rows.length === PURGE_COLLAB_BATCH) {
      await ctx.scheduler.runAfter(0, internal.documents.pruneValidatedUploads, {});
    }
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
    const validation = await ctx.db
      .query("validatedUploads")
      .withIndex("by_storage", (q) => q.eq("storageId", args.storageId))
      .unique();
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
    const maxBytes = assetMaxBytes(mimeType);
    if (!isAllowedAssetMimeType(mimeType) || maxBytes === null) {
      await ctx.storage.delete(args.storageId);
      throw new Error("invalid-asset");
    }
    if (meta.size > maxBytes) {
      await ctx.storage.delete(args.storageId);
      throw new Error("file-too-large");
    }
    if (
      !validation ||
      validation.expiresAt < Date.now() ||
      validation.userId !== access.userId ||
      validation.projectId !== args.projectId ||
      validation.mimeType !== mimeType ||
      validation.size !== meta.size
    ) {
      await ctx.storage.delete(args.storageId);
      throw new Error("asset-signature-mismatch");
    }
    await ctx.db.delete(validation._id);
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
    await syncDocumentNode(ctx, id);
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
  args: {
    projectId: v.id("projects"),
    cursor: v.optional(v.string()),
    secret: v.optional(v.string()),
    clerkOrgId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await accessForProject(ctx, args.projectId);
    const serviceAllowed = Boolean(
      args.secret && args.clerkOrgId && secretMatches(args.secret, process.env.CONVEX_PURGE_SECRET),
    );
    const serviceProject = serviceAllowed ? await ctx.db.get(args.projectId) : null;
    const projectRow =
      access?.project ??
      (serviceProject && serviceProject.clerkOrgId === args.clerkOrgId && !serviceProject.deletedAt
        ? serviceProject
        : null);
    if (!projectRow) {
      return null;
    }
    const page = await ctx.db
      .query("documents")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .paginate({ cursor: args.cursor ?? null, numItems: 5, maximumRowsRead: 5 });
    const visible = [];
    for (const doc of page.page) {
      if (!(await isInactiveTree(ctx, doc))) visible.push(doc);
    }
    const nodes = await Promise.all(
      visible.map(async (doc) => {
        let content = doc.kind === "file" ? doc.content : "";
        const state = doc.kind === "file" ? await documentState(ctx, doc) : null;
        if (doc.kind === "file" && doc.fileType === "sheet" && state) {
          const ydoc = new Y.Doc();
          Y.applyUpdate(ydoc, new Uint8Array(state));
          const model = sheetRenderModel(ydoc);
          content = serializeDelimited(
            model.rows.map((row) => row.values),
            ",",
            "\r\n",
          );
          ydoc.destroy();
        } else if (doc.kind === "file" && doc.fileType === "board" && state) {
          const ydoc = new Y.Doc();
          Y.applyUpdate(ydoc, new Uint8Array(state));
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
        } else if (doc.kind === "file" && doc.fileType === "view" && state) {
          const ydoc = new Y.Doc();
          Y.applyUpdate(ydoc, new Uint8Array(state));
          content = JSON.stringify(inspectView(ydoc), null, 2);
          ydoc.destroy();
        } else if (doc.kind === "file" && doc.fileType === "chart" && state) {
          const ydoc = new Y.Doc();
          Y.applyUpdate(ydoc, new Uint8Array(state));
          const config = chartRenderModel(ydoc);
          ydoc.destroy();
          const sourceId = config.sourceDocId
            ? ctx.db.normalizeId("documents", config.sourceDocId)
            : null;
          const sourceDoc = sourceId ? await ctx.db.get(sourceId) : null;
          let source: ChartSource | null = null;
          if (
            sourceDoc?.projectId === args.projectId &&
            sourceDoc.fileType === "sheet" &&
            !(await isInactiveTree(ctx, sourceDoc))
          ) {
            const sourceState = await documentState(ctx, sourceDoc);
            if (sourceState) {
              const sheet = new Y.Doc();
              Y.applyUpdate(sheet, new Uint8Array(sourceState));
              source = chartSourceFromSheet(sheet, sourceDoc._id, sourceDoc.name);
              sheet.destroy();
            }
          }
          content = renderChartSvg(resolveChartData(config, source));
        } else if (doc.kind === "file" && doc.fileType === "dashboard" && state) {
          const ydoc = new Y.Doc();
          Y.applyUpdate(ydoc, new Uint8Array(state));
          content = JSON.stringify(inspectDashboard(ydoc), null, 2);
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
    return {
      projectTitle: projectRow.title,
      projectVersion: `${projectRow.updatedAt}:${projectRow.lastSavedAt ?? 0}`,
      nodes,
      cursor: page.isDone ? null : page.continueCursor,
    };
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
