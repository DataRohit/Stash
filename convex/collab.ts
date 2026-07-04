import { v } from "convex/values";
import * as Y from "yjs";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { accessForProject, requireProjectAccess } from "./documents";

const COMPACT_THRESHOLD = 200;

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
    const projectId = await documentProject(ctx, args.documentId);
    if (!projectId) {
      throw new Error("not-found");
    }
    await requireProjectAccess(ctx, projectId);
    const seq = await nextSeq(ctx, args.documentId);
    await ctx.db.insert("yjsUpdates", {
      documentId: args.documentId,
      seq,
      update: args.update,
      createdAt: Date.now(),
    });
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
