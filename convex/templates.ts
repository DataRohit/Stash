import { v } from "convex/values";
import * as Y from "yjs";
import { getBoardRoots, inspectBoard } from "../lib/board-model";
import { mutation, query } from "./_generated/server";
import { accessForProject, isInactiveTree, requireProjectAdmin } from "./documents";

const MAX_TEMPLATES = 50;
const MAX_NAME = 80;
const MAX_BYTES = 512 * 1024;
const MAX_STRUCTURED_BYTES = 896 * 1024;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function templateName(raw: string) {
  const name = raw.trim().slice(0, MAX_NAME).trim();
  if (name.length < 2) throw new Error("invalid-template-name");
  return name;
}

export const listForProject = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const access = await accessForProject(ctx, args.projectId);
    if (!access) return [];
    const rows = await ctx.db
      .query("orgTemplates")
      .withIndex("by_org", (q) => q.eq("clerkOrgId", access.project.clerkOrgId))
      .collect();
    return rows
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((item) => ({
        id: item._id,
        name: item.name,
        fileType: item.fileType,
        preview: item.content.slice(0, 180),
        creatorName: item.createdByName,
        updatedAt: item.updatedAt,
      }));
  },
});

export const listForOrg = query({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || identity.org_id !== args.clerkOrgId) return [];
    const rows = await ctx.db
      .query("orgTemplates")
      .withIndex("by_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .collect();
    return rows
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((item) => ({
        id: item._id,
        name: item.name,
        fileType: item.fileType,
        preview: item.content.slice(0, 180),
        creatorName: item.createdByName,
        updatedAt: item.updatedAt,
      }));
  },
});

export const saveFromDocument = mutation({
  args: { documentId: v.id("documents"), name: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (doc?.kind !== "file" || !doc.fileType || (await isInactiveTree(ctx, doc)))
      throw new Error("not-found");
    const access = await requireProjectAdmin(ctx, doc.projectId);
    const name = templateName(args.name);
    const normalizedName = name.toLowerCase();
    if (
      await ctx.db
        .query("orgTemplates")
        .withIndex("by_org_name", (q) =>
          q.eq("clerkOrgId", doc.clerkOrgId).eq("normalizedName", normalizedName),
        )
        .unique()
    )
      throw new Error("template-name-taken");
    const rows = await ctx.db
      .query("orgTemplates")
      .withIndex("by_org", (q) => q.eq("clerkOrgId", doc.clerkOrgId))
      .collect();
    if (rows.length >= MAX_TEMPLATES) throw new Error("template-limit");
    const ydoc = new Y.Doc();
    if (doc.contentState) Y.applyUpdate(ydoc, new Uint8Array(doc.contentState));
    const updates = await ctx.db
      .query("yjsUpdates")
      .withIndex("by_document", (q) => q.eq("documentId", doc._id).gt("seq", doc.contentSeq ?? 0))
      .collect();
    for (const update of updates) Y.applyUpdate(ydoc, new Uint8Array(update.update));
    if (doc.fileType === "board") {
      const roots = getBoardRoots(ydoc);
      ydoc.transact(() => {
        for (const card of inspectBoard(ydoc).cards.values()) {
          if (card.linkedDocId) roots.cards.get(card.id)?.set("linkedDocId", null);
        }
      }, "template");
    }
    const state = Y.encodeStateAsUpdate(ydoc);
    ydoc.destroy();
    const projectionBytes = new TextEncoder().encode(doc.content).byteLength;
    if (
      projectionBytes > MAX_BYTES ||
      (doc.fileType === "sheet" ||
      doc.fileType === "board" ||
      doc.fileType === "view" ||
      doc.fileType === "chart" ||
      doc.fileType === "dashboard"
        ? state.byteLength + projectionBytes > MAX_STRUCTURED_BYTES
        : state.byteLength > MAX_BYTES)
    )
      throw new Error("template-too-large");
    const identity = await ctx.auth.getUserIdentity();
    const now = Date.now();
    return await ctx.db.insert("orgTemplates", {
      clerkOrgId: doc.clerkOrgId,
      name,
      normalizedName,
      fileType: doc.fileType,
      content: doc.content,
      contentState: toArrayBuffer(state),
      createdByUserId: access.userId,
      createdByName: identity?.name ?? identity?.email ?? access.userId,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const rename = mutation({
  args: { templateId: v.id("orgTemplates"), name: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.templateId);
    if (!row) throw new Error("not-found");
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || identity.org_id !== row.clerkOrgId || identity.org_role !== "org:admin")
      throw new Error("Forbidden");
    const name = templateName(args.name);
    const normalizedName = name.toLowerCase();
    const existing = await ctx.db
      .query("orgTemplates")
      .withIndex("by_org_name", (q) =>
        q.eq("clerkOrgId", row.clerkOrgId).eq("normalizedName", normalizedName),
      )
      .unique();
    if (existing && existing._id !== row._id) throw new Error("template-name-taken");
    if (name !== row.name)
      await ctx.db.patch(row._id, { name, normalizedName, updatedAt: Date.now() });
  },
});

export const remove = mutation({
  args: { templateId: v.id("orgTemplates") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.templateId);
    if (!row) return;
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || identity.org_id !== row.clerkOrgId || identity.org_role !== "org:admin")
      throw new Error("Forbidden");
    await ctx.db.delete(row._id);
  },
});
