import { v } from "convex/values";
import * as Y from "yjs";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { recordProjectEvent } from "./activity";
import {
  accessForProject,
  addProjectBytes,
  byteLength,
  cachedProjectBytes,
  isInactiveTree,
  maxProjectBytes,
  requireProjectAdmin,
  requireProjectEditor,
} from "./documents";
import {
  clampInt,
  DEFAULT_HISTORY_RETENTION_DAYS,
  HARD_MAX_HISTORY_RETENTION_DAYS,
  MIN_HISTORY_RETENTION_DAYS,
} from "./limits";
import { enforceWriteRateLimit } from "./writeRateLimit";

const COMPACT_THRESHOLD = 200;
const COMPACT_OVERLAP = 64;
const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_HISTORY_PER_DOC = 50;
const HISTORY_PRUNE_BATCH = 50;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_COLLAB_UPDATE_BYTES = 768 * 1024;
const COLLAB_WRITE_LIMIT = { capacity: 30, refillPerSecond: 5 };

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function docContent(ydoc: Y.Doc): string {
  return ydoc.getText("codemirror").toString();
}

async function documentProject(
  ctx: QueryCtx,
  documentId: Id<"documents">,
): Promise<Id<"projects"> | null> {
  const doc = await ctx.db.get(documentId);
  if (doc?.kind !== "file") {
    return null;
  }
  return doc.projectId;
}

async function latestSeq(ctx: QueryCtx, documentId: Id<"documents">): Promise<number> {
  const latest = await ctx.db
    .query("yjsUpdates")
    .withIndex("by_document", (q) => q.eq("documentId", documentId))
    .order("desc")
    .first();
  return latest?.seq ?? 0;
}

async function allocateSeq(ctx: MutationCtx, documentId: Id<"documents">): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const seq = (await latestSeq(ctx, documentId)) + 1;
    const clash = await ctx.db
      .query("yjsUpdates")
      .withIndex("by_document", (q) => q.eq("documentId", documentId).eq("seq", seq))
      .unique();
    if (!clash) {
      return seq;
    }
  }
  throw new Error("seq-conflict");
}

async function baseSnapshot(ctx: QueryCtx, documentId: Id<"documents">) {
  const [base, legacy] = await Promise.all([
    ctx.db
      .query("yjsSnapshots")
      .withIndex("by_document_purpose", (q) => q.eq("documentId", documentId).eq("purpose", "base"))
      .order("desc")
      .first(),
    ctx.db
      .query("yjsSnapshots")
      .withIndex("by_document_purpose", (q) =>
        q.eq("documentId", documentId).eq("purpose", undefined),
      )
      .order("desc")
      .first(),
  ]);
  if (!base) {
    return legacy;
  }
  if (!legacy) {
    return base;
  }
  return base.throughSeq >= legacy.throughSeq ? base : legacy;
}

async function historyRows(ctx: QueryCtx, documentId: Id<"documents">) {
  return await ctx.db
    .query("yjsSnapshots")
    .withIndex("by_document_purpose_created", (q) =>
      q.eq("documentId", documentId).eq("purpose", "history"),
    )
    .order("desc")
    .take(MAX_HISTORY_PER_DOC + HISTORY_PRUNE_BATCH);
}

async function materializedContent(
  ctx: QueryCtx,
  doc: Doc<"documents">,
  pendingUpdate: ArrayBuffer,
): Promise<{ content: string; state: ArrayBuffer; replayed: number } | null> {
  const ydoc = new Y.Doc();
  let baseSeq = doc.contentSeq ?? 0;
  if (doc.contentState) {
    Y.applyUpdate(ydoc, new Uint8Array(doc.contentState));
  } else {
    const snapshot = await baseSnapshot(ctx, doc._id);
    if (snapshot) {
      Y.applyUpdate(ydoc, new Uint8Array(snapshot.snapshot));
    }
    baseSeq = snapshot?.throughSeq ?? 0;
  }
  const updates = await ctx.db
    .query("yjsUpdates")
    .withIndex("by_document", (q) => q.eq("documentId", doc._id).gt("seq", baseSeq))
    .collect();
  for (const row of updates) {
    Y.applyUpdate(ydoc, new Uint8Array(row.update));
  }
  try {
    Y.applyUpdate(ydoc, new Uint8Array(pendingUpdate));
  } catch {
    ydoc.destroy();
    return null;
  }
  const content = docContent(ydoc);
  const state = toArrayBuffer(Y.encodeStateAsUpdate(ydoc));
  ydoc.destroy();
  return { content, state, replayed: updates.length };
}

async function materializedState(ctx: QueryCtx, doc: Doc<"documents">): Promise<ArrayBuffer> {
  if (doc.contentState) {
    return doc.contentState;
  }
  const ydoc = new Y.Doc();
  const snapshot = await baseSnapshot(ctx, doc._id);
  if (snapshot) {
    Y.applyUpdate(ydoc, new Uint8Array(snapshot.snapshot));
  }
  const baseSeq = snapshot?.throughSeq ?? 0;
  const updates = await ctx.db
    .query("yjsUpdates")
    .withIndex("by_document", (q) => q.eq("documentId", doc._id).gt("seq", baseSeq))
    .collect();
  for (const row of updates) {
    Y.applyUpdate(ydoc, new Uint8Array(row.update));
  }
  const state = toArrayBuffer(Y.encodeStateAsUpdate(ydoc));
  ydoc.destroy();
  return state;
}

function contentFromState(state: ArrayBuffer): string {
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, new Uint8Array(state));
  const content = docContent(ydoc);
  ydoc.destroy();
  return content;
}

function displayName(access: { userId: string }, name?: string | null, email?: string | null) {
  return name ?? email ?? access.userId;
}

async function snapshotAuthorEmail(
  ctx: QueryCtx,
  doc: Doc<"documents">,
  snapshot: Doc<"yjsSnapshots">,
) {
  if (snapshot.authorEmail) {
    return snapshot.authorEmail;
  }
  if (!snapshot.authorUserId) {
    return undefined;
  }
  const authorUserId = snapshot.authorUserId;
  const member = await ctx.db
    .query("members")
    .withIndex("by_org_user", (q) =>
      q.eq("clerkOrgId", doc.clerkOrgId).eq("memberUserId", authorUserId),
    )
    .unique();
  return member?.email;
}

async function pruneDocumentHistory(ctx: MutationCtx, doc: Doc<"documents">) {
  const allRows = await historyRows(ctx, doc._id);
  const now = Date.now();
  const newestId = allRows[0]?._id;
  const overflow = allRows.slice(MAX_HISTORY_PER_DOC);
  for (const row of overflow) {
    if (row._id === newestId) {
      continue;
    }
    await ctx.db.delete(row._id);
  }
  const rows = allRows.slice(0, MAX_HISTORY_PER_DOC);
  let total = rows.reduce((sum, row) => sum + (row.sizeBytes ?? row.snapshot.byteLength), 0);
  const budget = HISTORY_MAX_DOCUMENT_BYTES;
  for (const row of rows.slice().reverse()) {
    if (row._id === newestId) {
      break;
    }
    if (rows.length <= 1 && total <= budget && (row.expiresAt ?? Number.POSITIVE_INFINITY) > now) {
      break;
    }
    if (total <= budget && (row.expiresAt ?? Number.POSITIVE_INFINITY) > now) {
      continue;
    }
    total -= row.sizeBytes ?? row.snapshot.byteLength;
    await ctx.db.delete(row._id);
  }
  if (allRows.length === MAX_HISTORY_PER_DOC + HISTORY_PRUNE_BATCH) {
    await ctx.scheduler.runAfter(0, internal.collab.pruneHistoryForDocument, {
      documentId: doc._id,
    });
  }
}

async function persistHistoryCheckpoint(
  ctx: MutationCtx,
  doc: Doc<"documents">,
  seq: number,
  state: ArrayBuffer,
  authorUserId: string,
  authorName: string,
  authorEmail?: string,
  label?: string,
) {
  const previewText = contentFromState(state);
  const snapshotBytes = state.byteLength + byteLength(previewText);
  if (snapshotBytes > HISTORY_MAX_DOCUMENT_BYTES) {
    throw new Error("history-too-large");
  }
  const organization = await ctx.db
    .query("organizations")
    .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", doc.clerkOrgId))
    .unique();
  const retentionDays = clampInt(
    organization?.historyRetentionDays ?? DEFAULT_HISTORY_RETENTION_DAYS,
    MIN_HISTORY_RETENTION_DAYS,
    HARD_MAX_HISTORY_RETENTION_DAYS,
  );
  const now = Date.now();
  const snapshotId = await ctx.db.insert("yjsSnapshots", {
    documentId: doc._id,
    snapshot: state,
    throughSeq: seq,
    purpose: "history",
    label: label ?? `Checkpoint ${seq}`,
    authorUserId,
    authorName,
    authorEmail,
    previewText,
    createdAt: now,
    expiresAt: now + retentionDays * DAY_MS,
    sizeBytes: snapshotBytes,
    updatedAt: now,
  });
  await pruneDocumentHistory(ctx, doc);
  return snapshotId;
}

async function tryAutoCheckpoint(
  ctx: MutationCtx,
  doc: Doc<"documents">,
  seq: number,
  state: ArrayBuffer,
  authorUserId: string,
  authorName: string,
  authorEmail?: string,
) {
  if (seq === 0) {
    return;
  }
  const rows = await historyRows(ctx, doc._id);
  if (rows[0]?.throughSeq === seq) {
    return;
  }
  try {
    await persistHistoryCheckpoint(
      ctx,
      doc,
      seq,
      state,
      authorUserId,
      authorName,
      authorEmail,
      "Auto-saved before restore",
    );
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("history-too-large")) {
      throw error;
    }
  }
}

export const pullUpdates = query({
  args: { documentId: v.id("documents"), afterSeq: v.number() },
  handler: async (ctx, args) => {
    const projectId = await documentProject(ctx, args.documentId);
    if (!projectId || !(await accessForProject(ctx, projectId))) {
      return { snapshot: null, throughSeq: 0, updates: [] };
    }
    const snapshotRow = args.afterSeq === 0 ? await baseSnapshot(ctx, args.documentId) : null;
    const baseSeq = snapshotRow?.throughSeq ?? args.afterSeq;
    const updates = await ctx.db
      .query("yjsUpdates")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId).gt("seq", baseSeq))
      .collect();
    return {
      snapshot: snapshotRow?.snapshot ?? null,
      throughSeq: snapshotRow?.throughSeq ?? args.afterSeq,
      updates: updates.map((row) => ({ seq: row.seq, update: row.update })),
    };
  },
});

export const pushUpdateV2 = mutation({
  args: { documentId: v.id("documents"), update: v.bytes() },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (doc?.kind !== "file" || (await isInactiveTree(ctx, doc))) {
      throw new Error("not-found");
    }
    const access = await requireProjectEditor(ctx, doc.projectId);
    const allowed = await enforceWriteRateLimit(
      ctx,
      "collab",
      args.documentId,
      access.userId,
      COLLAB_WRITE_LIMIT,
    );
    if (!allowed) {
      return { ok: false as const, error: "rate-limited" as const };
    }
    if (args.update.byteLength > MAX_COLLAB_UPDATE_BYTES) {
      return { ok: false as const, error: "update-too-large" as const };
    }
    const materialized = await materializedContent(ctx, doc, args.update);
    if (!materialized) {
      return { ok: false as const, error: "invalid-update" as const };
    }
    const { content, state, replayed } = materialized;
    const newSize = byteLength(content);
    if (newSize > MAX_FILE_BYTES) {
      return { ok: false as const, error: "file-too-large" as const };
    }
    const total = await cachedProjectBytes(ctx, access.project);
    const max = await maxProjectBytes(ctx, access.project);
    if (total - doc.size + newSize > max) {
      return { ok: false as const, error: "project-full" as const };
    }
    let seq: number;
    try {
      seq = await allocateSeq(ctx, args.documentId);
    } catch (error) {
      if (error instanceof Error && error.message === "seq-conflict") {
        return { ok: false as const, error: "seq-conflict" as const };
      }
      throw error;
    }
    await ctx.db.insert("yjsUpdates", {
      documentId: args.documentId,
      seq,
      update: args.update,
      createdAt: Date.now(),
    });
    await ctx.db.patch(doc._id, {
      content,
      contentSeq: seq,
      contentState: state,
      size: newSize,
      updatedAt: Date.now(),
    });
    await addProjectBytes(ctx, access.project, newSize - doc.size);
    if (seq % COMPACT_THRESHOLD === 0 || replayed > COMPACT_THRESHOLD) {
      await ctx.scheduler.runAfter(0, internal.collab.compactDocument, {
        documentId: args.documentId,
      });
    }
    return { ok: true as const, seq };
  },
});

export const compactDocument = internalMutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (doc?.kind !== "file") {
      return;
    }
    const ydoc = new Y.Doc();
    const snapshot = await baseSnapshot(ctx, args.documentId);
    if (snapshot) {
      Y.applyUpdate(ydoc, new Uint8Array(snapshot.snapshot));
    }
    const baseSeq = snapshot?.throughSeq ?? 0;
    const updates = await ctx.db
      .query("yjsUpdates")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId).gt("seq", baseSeq))
      .collect();
    if (updates.length === 0) {
      ydoc.destroy();
      return;
    }
    let maxSeq = baseSeq;
    for (const row of updates) {
      Y.applyUpdate(ydoc, new Uint8Array(row.update));
      if (row.seq > maxSeq) {
        maxSeq = row.seq;
      }
    }
    const encoded = toArrayBuffer(Y.encodeStateAsUpdate(ydoc));
    ydoc.destroy();
    if (snapshot) {
      await ctx.db.patch(snapshot._id, {
        snapshot: encoded,
        throughSeq: maxSeq,
        purpose: "base",
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("yjsSnapshots", {
        documentId: args.documentId,
        snapshot: encoded,
        throughSeq: maxSeq,
        purpose: "base",
        updatedAt: Date.now(),
      });
    }
    const pruneThrough = maxSeq - COMPACT_OVERLAP;
    if (pruneThrough <= 0) {
      return;
    }
    const stale = await ctx.db
      .query("yjsUpdates")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId).lte("seq", pruneThrough))
      .collect();
    for (const row of stale) {
      await ctx.db.delete(row._id);
    }
  },
});

export const ensureSeed = mutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (doc?.kind !== "file") {
      throw new Error("not-found");
    }
    await requireProjectEditor(ctx, doc.projectId);
    const existing = await ctx.db
      .query("yjsUpdates")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .first();
    const snapshot = await baseSnapshot(ctx, args.documentId);
    if (existing || snapshot || doc.content.length === 0) {
      return { seeded: false };
    }
    const seedDoc = new Y.Doc();
    seedDoc.getText("codemirror").insert(0, doc.content);
    const update = Y.encodeStateAsUpdate(seedDoc);
    const state = toArrayBuffer(update);
    seedDoc.destroy();
    await ctx.db.insert("yjsUpdates", {
      documentId: args.documentId,
      seq: 1,
      update: state,
      createdAt: Date.now(),
    });
    await ctx.db.patch(doc._id, {
      contentSeq: 1,
      contentState: state,
    });
    return { seeded: true };
  },
});

export const listHistory = query({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (doc?.kind !== "file" || !(await accessForProject(ctx, doc.projectId))) {
      return [];
    }
    const rows = await historyRows(ctx, args.documentId);
    const total = rows.length;
    return await Promise.all(
      rows.map(async (row, index) => ({
        id: row._id,
        versionNumber: total - index,
        authorName: row.authorName ?? "Unknown",
        authorEmail: await snapshotAuthorEmail(ctx, doc, row),
        createdAt: row.createdAt ?? row.updatedAt,
        throughSeq: row.throughSeq,
        sizeBytes: row.sizeBytes ?? row.snapshot.byteLength,
      })),
    );
  },
});

export const createHistoryCheckpoint = mutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (doc?.kind !== "file") {
      throw new Error("not-found");
    }
    const access = await requireProjectEditor(ctx, doc.projectId);
    const seq = await latestSeq(ctx, doc._id);
    if (seq === 0) {
      return { seq, created: false };
    }
    const rows = await historyRows(ctx, doc._id);
    if (rows[0]?.throughSeq === seq) {
      return { seq, created: false };
    }
    const state = await materializedState(ctx, doc);
    const identity = await ctx.auth.getUserIdentity();
    const snapshotId = await persistHistoryCheckpoint(
      ctx,
      doc,
      seq,
      state,
      access.userId,
      displayName(access, identity?.name, identity?.email),
      identity?.email,
    );
    await recordProjectEvent(ctx, {
      projectId: doc.projectId,
      clerkOrgId: access.project.clerkOrgId,
      kind: "checkpoint_created",
      documentId: doc._id,
      checkpointId: snapshotId,
      targetName: doc.name,
      detail: `Checkpoint ${seq}`,
    });
    return { seq, created: true };
  },
});

export const deleteHistoryBatch = internalMutation({
  args: { confirm: v.string() },
  handler: async (ctx, args) => {
    if (args.confirm !== "delete-all-version-history") {
      throw new Error("invalid-confirmation");
    }
    const rows = await ctx.db
      .query("yjsSnapshots")
      .withIndex("by_purpose_created", (q) => q.eq("purpose", "history"))
      .take(200);
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
    return { deleted: rows.length, hasMore: rows.length === 200 };
  },
});

export const pruneHistoryForDocument = internalMutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (doc?.kind !== "file") {
      return { found: false };
    }
    await pruneDocumentHistory(ctx, doc);
    return { found: true };
  },
});

export const deleteHistoryCheckpoint = mutation({
  args: { snapshotId: v.id("yjsSnapshots") },
  handler: async (ctx, args) => {
    const snapshot = await ctx.db.get(args.snapshotId);
    if (snapshot?.purpose !== "history") {
      throw new Error("not-found");
    }
    const doc = await ctx.db.get(snapshot.documentId);
    if (doc?.kind !== "file") {
      throw new Error("not-found");
    }
    const access = await requireProjectAdmin(ctx, doc.projectId);
    await recordProjectEvent(ctx, {
      projectId: doc.projectId,
      clerkOrgId: access.project.clerkOrgId,
      kind: "checkpoint_deleted",
      documentId: doc._id,
      checkpointId: snapshot._id,
      targetName: doc.name,
      detail: snapshot.label ?? `Checkpoint ${snapshot.throughSeq}`,
    });
    await ctx.db.delete(args.snapshotId);
    return { deleted: true };
  },
});

export const getHistoryPreview = query({
  args: { snapshotId: v.id("yjsSnapshots") },
  handler: async (ctx, args) => {
    const snapshot = await ctx.db.get(args.snapshotId);
    if (snapshot?.purpose !== "history") {
      return null;
    }
    const doc = await ctx.db.get(snapshot.documentId);
    if (doc?.kind !== "file" || !(await accessForProject(ctx, doc.projectId))) {
      return null;
    }
    return {
      content: snapshot.previewText ?? contentFromState(snapshot.snapshot),
      label: snapshot.label ?? `Snapshot ${snapshot.throughSeq}`,
      authorName: snapshot.authorName ?? "Unknown",
      authorEmail: await snapshotAuthorEmail(ctx, doc, snapshot),
      createdAt: snapshot.createdAt ?? snapshot.updatedAt,
    };
  },
});

export const restoreHistory = mutation({
  args: { snapshotId: v.id("yjsSnapshots") },
  handler: async (ctx, args) => {
    const snapshot = await ctx.db.get(args.snapshotId);
    if (snapshot?.purpose !== "history") {
      throw new Error("not-found");
    }
    const doc = await ctx.db.get(snapshot.documentId);
    if (doc?.kind !== "file") {
      throw new Error("not-found");
    }
    const access = await requireProjectAdmin(ctx, doc.projectId);
    const targetContent = snapshot.previewText ?? contentFromState(snapshot.snapshot);
    const newSize = byteLength(targetContent);
    if (newSize > MAX_FILE_BYTES) {
      throw new Error("file-too-large");
    }
    const total = await cachedProjectBytes(ctx, access.project);
    const max = await maxProjectBytes(ctx, access.project);
    if (total - doc.size + newSize > max) {
      throw new Error("project-full");
    }
    const currentState = await materializedState(ctx, doc);
    const currentSeq = await latestSeq(ctx, doc._id);
    const identity = await ctx.auth.getUserIdentity();
    await tryAutoCheckpoint(
      ctx,
      doc,
      currentSeq,
      currentState,
      access.userId,
      displayName(access, identity?.name, identity?.email),
      identity?.email,
    );
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, new Uint8Array(currentState));
    const vector = Y.encodeStateVector(ydoc);
    const ytext = ydoc.getText("codemirror");
    ytext.delete(0, ytext.length);
    ytext.insert(0, targetContent);
    const update = toArrayBuffer(Y.encodeStateAsUpdate(ydoc, vector));
    const state = toArrayBuffer(Y.encodeStateAsUpdate(ydoc));
    ydoc.destroy();
    const seq = await allocateSeq(ctx, doc._id);
    await ctx.db.insert("yjsUpdates", {
      documentId: doc._id,
      seq,
      update,
      createdAt: Date.now(),
    });
    await ctx.db.patch(doc._id, {
      content: targetContent,
      contentSeq: seq,
      contentState: state,
      size: newSize,
      updatedAt: Date.now(),
    });
    await addProjectBytes(ctx, access.project, newSize - doc.size);
    await pruneDocumentHistory(ctx, doc);
    await recordProjectEvent(ctx, {
      projectId: doc.projectId,
      clerkOrgId: access.project.clerkOrgId,
      kind: "checkpoint_restored",
      documentId: doc._id,
      checkpointId: snapshot._id,
      targetName: doc.name,
      detail: snapshot.label ?? `Checkpoint ${snapshot.throughSeq}`,
    });
    return { seq };
  },
});

export const pruneHistory = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("yjsSnapshots")
      .withIndex("by_purpose_created", (q) => q.eq("purpose", "history"))
      .take(200);
    const documentIds = [...new Set(rows.map((row) => row.documentId))];
    for (const documentId of documentIds) {
      const doc = await ctx.db.get(documentId);
      if (doc?.kind !== "file") {
        continue;
      }
      await pruneDocumentHistory(ctx, doc);
    }
  },
});
