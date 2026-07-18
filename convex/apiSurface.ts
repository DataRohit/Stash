import { v } from "convex/values";
import * as Y from "yjs";
import { mutation, query } from "./_generated/server";
import { recordOrganizationEvent } from "./audit";
import {
  addProjectBytes,
  byteLength,
  cachedProjectBytes,
  documentState,
  isInactiveTree,
  maxProjectBytes,
  syncDocumentNode,
} from "./documents";
import { secretMatches } from "./secrets";

const PAGE_MAX = 100;
const MAX_FILE_BYTES = 1024 * 1024;

function pageLimit(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(PAGE_MAX, Math.floor(value ?? 50))) : 50;
}

const propertyValue = v.union(
  v.object({ type: v.literal("text"), value: v.string() }),
  v.object({ type: v.literal("number"), value: v.number() }),
  v.object({ type: v.literal("boolean"), value: v.boolean() }),
  v.object({ type: v.literal("date"), value: v.number(), endValue: v.optional(v.number()) }),
  v.object({ type: v.literal("status"), optionId: v.string() }),
  v.object({ type: v.literal("person"), userId: v.string() }),
);

function requireService(secret: string): void {
  if (!secretMatches(secret, process.env.CONVEX_PURGE_SECRET)) throw new Error("Forbidden");
}

export const listProjects = query({
  args: {
    secret: v.string(),
    clerkOrgId: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireService(args.secret);
    const limit = pageLimit(args.limit);
    const page = await ctx.db
      .query("projects")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .filter((q) => q.eq(q.field("deletedAt"), undefined))
      .paginate({ cursor: args.cursor ?? null, numItems: limit, maximumRowsRead: limit * 2 });
    return {
      data: page.page.map((project) => ({
        id: project._id,
        title: project.title,
        description: project.description,
        tags: project.tags,
        storageBytes: project.totalBytes ?? 0,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      })),
      nextCursor: page.isDone ? null : page.continueCursor,
    };
  },
});

export const listDocuments = query({
  args: {
    secret: v.string(),
    clerkOrgId: v.string(),
    projectId: v.id("projects"),
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireService(args.secret);
    const project = await ctx.db.get(args.projectId);
    if (!project || project.clerkOrgId !== args.clerkOrgId || project.deletedAt) return null;
    const limit = pageLimit(args.limit);
    const page = await ctx.db
      .query("documents")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .paginate({ cursor: args.cursor ?? null, numItems: limit, maximumRowsRead: limit * 2 });
    const data = [];
    for (const document of page.page) {
      if (await isInactiveTree(ctx, document)) continue;
      data.push({
        id: document._id,
        parentId: document.parentId,
        kind: document.kind,
        name: document.name,
        fileType: document.fileType,
        mimeType: document.mimeType,
        size: document.size,
        createdAt: document.createdAt,
        updatedAt: document.updatedAt,
      });
    }
    return { data, nextCursor: page.isDone ? null : page.continueCursor };
  },
});

export const getDocument = query({
  args: { secret: v.string(), clerkOrgId: v.string(), documentId: v.id("documents") },
  handler: async (ctx, args) => {
    requireService(args.secret);
    const document = await ctx.db.get(args.documentId);
    if (
      !document ||
      document.clerkOrgId !== args.clerkOrgId ||
      (await isInactiveTree(ctx, document))
    ) {
      return null;
    }
    const [properties, values] = await Promise.all([
      ctx.db
        .query("documentProperties")
        .withIndex("by_project", (q) => q.eq("projectId", document.projectId))
        .collect(),
      ctx.db
        .query("documentPropertyValues")
        .withIndex("by_document", (q) => q.eq("documentId", document._id))
        .collect(),
    ]);
    const valuesByProperty = new Map(values.map((value) => [value.propertyId, value]));
    return {
      id: document._id,
      projectId: document.projectId,
      parentId: document.parentId,
      kind: document.kind,
      name: document.name,
      fileType: document.fileType,
      content: document.content,
      properties: properties
        .filter((property) => !property.deletedAt)
        .map((property) => {
          const value = valuesByProperty.get(property._id);
          return {
            id: property._id,
            name: property.name,
            type: property.type,
            value: value
              ? {
                  displayValue: value.displayValue,
                  text: value.textValue,
                  number: value.numberValue,
                  boolean: value.booleanValue,
                  date: value.dateValue,
                  dateEnd: value.dateEndValue,
                  statusOptionId: value.statusOptionId,
                  personUserId: value.personUserId,
                }
              : null,
          };
        }),
      mimeType: document.mimeType,
      size: document.size,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    };
  },
});

export const createMarkdown = mutation({
  args: {
    secret: v.string(),
    clerkOrgId: v.string(),
    projectId: v.id("projects"),
    parentId: v.union(v.id("documents"), v.null()),
    name: v.string(),
    content: v.string(),
    actorKeyId: v.id("apiKeys"),
  },
  handler: async (ctx, args) => {
    requireService(args.secret);
    const project = await ctx.db.get(args.projectId);
    if (!project || project.clerkOrgId !== args.clerkOrgId || project.deletedAt)
      throw new Error("not-found");
    const key = await ctx.db.get(args.actorKeyId);
    if (!key || key.clerkOrgId !== args.clerkOrgId || key.revokedAt) throw new Error("Forbidden");
    const parent = args.parentId ? await ctx.db.get(args.parentId) : null;
    if (
      args.parentId &&
      (!parent ||
        parent.projectId !== project._id ||
        parent.kind !== "folder" ||
        (await isInactiveTree(ctx, parent)))
    ) {
      throw new Error("invalid-parent");
    }
    let name = args.name.replaceAll("/", "").replaceAll("\\", "").trim().slice(0, 120);
    if (!name) throw new Error("invalid-name");
    if (!name.toLowerCase().endsWith(".md")) name = `${name}.md`;
    const siblings = await ctx.db
      .query("documents")
      .withIndex("by_parent", (q) => q.eq("projectId", project._id).eq("parentId", args.parentId))
      .collect();
    if (siblings.some((row) => !row.trashedAt && row.name.toLowerCase() === name.toLowerCase())) {
      throw new Error("name-taken");
    }
    const nodes = await ctx.db
      .query("documents")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .take(2_001);
    if (nodes.filter((node) => !node.trashedAt && !node.deletingAt).length >= 2_000)
      throw new Error("too-many-files");
    const size = byteLength(args.content);
    if (size > MAX_FILE_BYTES) throw new Error("file-too-large");
    if ((await cachedProjectBytes(ctx, project)) + size > (await maxProjectBytes(ctx, project))) {
      throw new Error("project-full");
    }
    const now = Date.now();
    const id = await ctx.db.insert("documents", {
      projectId: project._id,
      clerkOrgId: args.clerkOrgId,
      parentId: args.parentId,
      kind: "file",
      name,
      fileType: "md",
      content: args.content,
      storageId: null,
      mimeType: null,
      size,
      createdAt: now,
      updatedAt: now,
    });
    await syncDocumentNode(ctx, id);
    await addProjectBytes(ctx, project, size);
    await recordOrganizationEvent(ctx, {
      clerkOrgId: args.clerkOrgId,
      actorUserId: null,
      actorName: key.name,
      kind: "document.created",
      projectId: project._id,
      projectName: project.title,
      targetId: id,
      targetName: name,
      metadata: JSON.stringify({ apiKeyId: key._id }),
    });
    return { id };
  },
});

export const appendMarkdown = mutation({
  args: {
    secret: v.string(),
    clerkOrgId: v.string(),
    documentId: v.id("documents"),
    content: v.string(),
    actorKeyId: v.id("apiKeys"),
  },
  handler: async (ctx, args) => {
    requireService(args.secret);
    const [document, key] = await Promise.all([
      ctx.db.get(args.documentId),
      ctx.db.get(args.actorKeyId),
    ]);
    if (
      !document ||
      document.clerkOrgId !== args.clerkOrgId ||
      document.fileType !== "md" ||
      (await isInactiveTree(ctx, document))
    )
      throw new Error("not-found");
    if (!key || key.clerkOrgId !== args.clerkOrgId || key.revokedAt) throw new Error("Forbidden");
    const project = await ctx.db.get(document.projectId);
    if (!project || project.deletedAt) throw new Error("not-found");
    const currentState = await documentState(ctx, document);
    const ydoc = new Y.Doc();
    if (currentState) Y.applyUpdate(ydoc, new Uint8Array(currentState));
    else ydoc.getText("codemirror").insert(0, document.content);
    const vector = Y.encodeStateVector(ydoc);
    ydoc.getText("codemirror").insert(ydoc.getText("codemirror").length, args.content);
    const content = ydoc.getText("codemirror").toString();
    const update = Y.encodeStateAsUpdate(ydoc, vector).slice().buffer;
    ydoc.destroy();
    const size = byteLength(content);
    if (size > MAX_FILE_BYTES) throw new Error("file-too-large");
    if (
      (await cachedProjectBytes(ctx, project)) - document.size + size >
      (await maxProjectBytes(ctx, project))
    )
      throw new Error("project-full");
    const latest = await ctx.db
      .query("yjsUpdates")
      .withIndex("by_document", (q) => q.eq("documentId", document._id))
      .order("desc")
      .first();
    const seq = Math.max(document.contentSeq ?? 0, latest?.seq ?? 0) + 1;
    const now = Date.now();
    await ctx.db.insert("yjsUpdates", { documentId: document._id, seq, update, createdAt: now });
    await ctx.db.patch(document._id, { content, size, updatedAt: now });
    await syncDocumentNode(ctx, document._id);
    await addProjectBytes(ctx, project, size - document.size);
    await ctx.db.patch(project._id, { lastSavedAt: now });
    return { id: document._id, size, sequence: seq };
  },
});

export const setProperty = mutation({
  args: {
    secret: v.string(),
    clerkOrgId: v.string(),
    documentId: v.id("documents"),
    propertyId: v.id("documentProperties"),
    value: propertyValue,
    actorKeyId: v.id("apiKeys"),
  },
  handler: async (ctx, args) => {
    requireService(args.secret);
    const [document, property, key] = await Promise.all([
      ctx.db.get(args.documentId),
      ctx.db.get(args.propertyId),
      ctx.db.get(args.actorKeyId),
    ]);
    if (
      !document ||
      !property ||
      document.clerkOrgId !== args.clerkOrgId ||
      property.clerkOrgId !== args.clerkOrgId ||
      property.projectId !== document.projectId ||
      property.deletedAt ||
      (await isInactiveTree(ctx, document))
    )
      throw new Error("not-found");
    if (!key || key.clerkOrgId !== args.clerkOrgId || key.revokedAt) throw new Error("Forbidden");
    const value = args.value;
    if (property.type !== value.type) throw new Error("type-mismatch");
    let fields: Record<string, string | number | boolean | undefined> = {};
    let displayValue = "";
    if (value.type === "text") {
      displayValue = value.value.slice(0, 2_000);
      fields = { textValue: displayValue };
    } else if (value.type === "number") {
      if (!Number.isFinite(value.value)) throw new Error("invalid-value");
      displayValue = String(value.value);
      fields = { numberValue: value.value };
    } else if (value.type === "boolean") {
      displayValue = value.value ? "Yes" : "No";
      fields = { booleanValue: value.value };
    } else if (value.type === "date") {
      if (!Number.isFinite(value.value) || (value.endValue && value.endValue < value.value))
        throw new Error("invalid-value");
      displayValue = new Date(value.value).toISOString();
      fields = { dateValue: value.value, dateEndValue: value.endValue };
    } else if (value.type === "status") {
      const optionId = value.optionId;
      const option = property.options.find((item) => item.id === optionId);
      if (!option) throw new Error("invalid-value");
      displayValue = option.name;
      fields = { statusOptionId: option.id };
    } else {
      const member = await ctx.db
        .query("members")
        .withIndex("by_org_user", (q) =>
          q.eq("clerkOrgId", args.clerkOrgId).eq("memberUserId", value.userId),
        )
        .first();
      if (member?.status !== "accepted") throw new Error("invalid-value");
      displayValue = [member.firstName, member.lastName].filter(Boolean).join(" ") || member.email;
      fields = { personUserId: value.userId };
    }
    const existing = await ctx.db
      .query("documentPropertyValues")
      .withIndex("by_document_property", (q) =>
        q.eq("documentId", document._id).eq("propertyId", property._id),
      )
      .unique();
    const base = {
      documentId: document._id,
      propertyId: property._id,
      projectId: document.projectId,
      clerkOrgId: args.clerkOrgId,
      type: property.type,
      displayValue,
      updatedBy: `api:${key._id}`,
      updatedAt: Date.now(),
      ...fields,
    };
    if (existing) await ctx.db.patch(existing._id, base);
    else await ctx.db.insert("documentPropertyValues", base);
    return { id: document._id, propertyId: property._id, displayValue };
  },
});
