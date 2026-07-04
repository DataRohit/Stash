import { v } from "convex/values";
import * as Y from "yjs";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { accessForProject, byteLength, projectTotalBytes, requireProjectAccess } from "./documents";

const COMPACT_THRESHOLD = 200;
const MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_PROJECT_BYTES = 8 * 1024 * 1024;
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

async function nextSeq(ctx: MutationCtx, documentId: Id<"documents">): Promise<number> {
  const latest = await ctx.db
    .query("yjsUpdates")
    .withIndex("by_document", (q) => q.eq("documentId", documentId))
    .order("desc")
    .first();
  return (latest?.seq ?? 0) + 1;
}

async function materializedContent(
  ctx: QueryCtx,
  documentId: Id<"documents">,
  pendingUpdate: ArrayBuffer,
): Promise<string> {
  const ydoc = new Y.Doc();
  const snapshot = await ctx.db
    .query("yjsSnapshots")
    .withIndex("by_document", (q) => q.eq("documentId", documentId))
    .unique();
  if (snapshot) {
    Y.applyUpdate(ydoc, new Uint8Array(snapshot.snapshot));
  }
  const baseSeq = snapshot?.throughSeq ?? 0;
  const updates = await ctx.db
    .query("yjsUpdates")
    .withIndex("by_document", (q) => q.eq("documentId", documentId).gt("seq", baseSeq))
    .collect();
  for (const row of updates) {
    Y.applyUpdate(ydoc, new Uint8Array(row.update));
  }
  Y.applyUpdate(ydoc, new Uint8Array(pendingUpdate));
  const content = ydoc.getText("codemirror").toString();
  ydoc.destroy();
  return content;
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
    const content = await materializedContent(ctx, args.documentId, args.update);
    const newSize = byteLength(content);
    if (newSize > MAX_FILE_BYTES) {
      throw new Error("file-too-large");
    }
    const total = await projectTotalBytes(ctx, doc.projectId);
    const max = access.project.maxSizeBytes ?? DEFAULT_MAX_PROJECT_BYTES;
    if (total - doc.size + newSize > max) {
      throw new Error("project-full");
    }
    const seq = await nextSeq(ctx, args.documentId);
    await ctx.db.insert("yjsUpdates", {
      documentId: args.documentId,
      seq,
      update: args.update,
      createdAt: Date.now(),
    });
    await ctx.db.patch(doc._id, { content, size: newSize, updatedAt: Date.now() });
    const shouldCompact = seq % COMPACT_THRESHOLD === 0;
    return { seq, shouldCompact };
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
    seedDoc.destroy();
    await ctx.db.insert("yjsUpdates", {
      documentId: args.documentId,
      seq: 1,
      update: toArrayBuffer(update),
      createdAt: Date.now(),
    });
    return { seeded: true };
  },
});

export const saveSnapshot = mutation({
  args: {
    documentId: v.id("documents"),
    snapshot: v.bytes(),
    throughSeq: v.number(),
  },
  handler: async (ctx, args) => {
    const projectId = await documentProject(ctx, args.documentId);
    if (!projectId) {
      throw new Error("not-found");
    }
    await requireProjectAccess(ctx, projectId);
    if (args.snapshot.byteLength > MAX_COLLAB_UPDATE_BYTES) {
      throw new Error("snapshot-too-large");
    }
    const existing = await ctx.db
      .query("yjsSnapshots")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .unique();
    if (existing) {
      if (args.throughSeq <= existing.throughSeq) {
        return;
      }
      await ctx.db.patch(existing._id, {
        snapshot: args.snapshot,
        throughSeq: args.throughSeq,
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("yjsSnapshots", {
        documentId: args.documentId,
        snapshot: args.snapshot,
        throughSeq: args.throughSeq,
        updatedAt: Date.now(),
      });
    }
    const stale = await ctx.db
      .query("yjsUpdates")
      .withIndex("by_document", (q) =>
        q.eq("documentId", args.documentId).lte("seq", args.throughSeq),
      )
      .collect();
    for (const row of stale) {
      await ctx.db.delete(row._id);
    }
  },
});
