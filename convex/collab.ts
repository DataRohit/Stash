import { v } from "convex/values";
import * as Y from "yjs";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import {
  accessForProject,
  addProjectBytes,
  byteLength,
  cachedProjectBytes,
  maxProjectBytes,
  requireProjectAccess,
} from "./documents";

const COMPACT_THRESHOLD = 200;
const COMPACT_OVERLAP = 64;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_COLLAB_UPDATE_BYTES = 768 * 1024;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
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

async function materializedContent(
  ctx: QueryCtx,
  doc: Doc<"documents">,
  pendingUpdate: ArrayBuffer,
): Promise<{ content: string; state: ArrayBuffer }> {
  const ydoc = new Y.Doc();
  let baseSeq = doc.contentSeq ?? 0;
  if (doc.contentState) {
    Y.applyUpdate(ydoc, new Uint8Array(doc.contentState));
  } else {
    const snapshot = await ctx.db
      .query("yjsSnapshots")
      .withIndex("by_document", (q) => q.eq("documentId", doc._id))
      .unique();
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
  Y.applyUpdate(ydoc, new Uint8Array(pendingUpdate));
  const content = ydoc.getText("codemirror").toString();
  const state = toArrayBuffer(Y.encodeStateAsUpdate(ydoc));
  ydoc.destroy();
  return { content, state };
}

export const pullUpdates = query({
  args: { documentId: v.id("documents"), afterSeq: v.number() },
  handler: async (ctx, args) => {
    const projectId = await documentProject(ctx, args.documentId);
    if (!projectId || !(await accessForProject(ctx, projectId))) {
      return { snapshot: null, throughSeq: 0, updates: [] };
    }
    const snapshotRow =
      args.afterSeq === 0
        ? await ctx.db
            .query("yjsSnapshots")
            .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
            .unique()
        : null;
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

export const pushUpdate = mutation({
  args: { documentId: v.id("documents"), update: v.bytes() },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (doc?.kind !== "file") {
      throw new Error("not-found");
    }
    const access = await requireProjectAccess(ctx, doc.projectId);
    if (args.update.byteLength > MAX_COLLAB_UPDATE_BYTES) {
      throw new Error("update-too-large");
    }
    const seq = (await latestSeq(ctx, args.documentId)) + 1;
    const { content, state } = await materializedContent(ctx, doc, args.update);
    const newSize = byteLength(content);
    if (newSize > MAX_FILE_BYTES) {
      throw new Error("file-too-large");
    }
    const total = await cachedProjectBytes(ctx, access.project);
    const max = await maxProjectBytes(ctx, access.project);
    if (total - doc.size + newSize > max) {
      throw new Error("project-full");
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
    if (seq % COMPACT_THRESHOLD === 0) {
      await ctx.scheduler.runAfter(0, internal.collab.compactDocument, {
        documentId: args.documentId,
      });
    }
    return { seq };
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
    const snapshot = await ctx.db
      .query("yjsSnapshots")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .unique();
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
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("yjsSnapshots", {
        documentId: args.documentId,
        snapshot: encoded,
        throughSeq: maxSeq,
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
    await requireProjectAccess(ctx, doc.projectId);
    const existing = await ctx.db
      .query("yjsUpdates")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .first();
    const snapshot = await ctx.db
      .query("yjsSnapshots")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .unique();
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
