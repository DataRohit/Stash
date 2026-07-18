import { v } from "convex/values";
import * as Y from "yjs";
import { type ChartSource, resolveChartData } from "../lib/chart-data";
import { type ChartConfig, inspectChart } from "../lib/chart-model";
import { inspectDashboard } from "../lib/dashboard-model";
import { boardRenderModel, chartSourceFromSheet, sheetRenderModel } from "../lib/doc-projection";
import { inspectView, type ViewConfig } from "../lib/view-model";
import {
  aggregateViewRecords,
  VIEW_BUILTIN_PROPERTIES,
  viewRecordMatches,
  viewRecordValue,
} from "../lib/view-records";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { recordProjectEvent } from "./activity";
import { accessForProject, documentState, isInactiveTree, requireProjectAdmin } from "./documents";
import { secretMatches } from "./secrets";

type ShareMode = "private" | "org" | "public";
type SharedTreeNode = Pick<
  Doc<"documents">,
  | "_id"
  | "parentId"
  | "kind"
  | "name"
  | "fileType"
  | "size"
  | "mimeType"
  | "updatedAt"
  | "deletingAt"
  | "trashedAt"
>;

const SHARE_EVENT_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const PRUNE_BATCH = 200;
const MAX_EXPIRY_MS = 365 * 24 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_HITS = 60;
const WINDOW_RETENTION_MS = 5 * 60 * 1000;
const SHARE_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const RATE_KEY_PATTERN = /^[a-f0-9]{64}$/;
const SHARED_VIEW_RECORD_LIMIT = 200;

type AllowedDocuments = Set<string> | ((documentId: string) => boolean);

function documentAllowed(allowed: AllowedDocuments, documentId: string): boolean {
  return typeof allowed === "function" ? allowed(documentId) : allowed.has(documentId);
}

type SharedViewRecord = {
  id: string;
  name: string;
  fileType: string | null;
  updatedAt: number;
  properties: Array<{
    propertyId: string;
    displayValue: string;
    dateValue?: number;
    dateEndValue?: number;
  }>;
};

export async function sharedViewPreview(
  ctx: QueryCtx,
  projectId: Id<"projects">,
  config: ViewConfig,
  allowedDocumentIds: AllowedDocuments,
) {
  const referenced = new Set([
    ...config.visibleColumns,
    ...config.filters.map((filter) => filter.propertyId),
    ...config.sorts.map((sort) => sort.propertyId),
    ...(config.groupBy ? [config.groupBy] : []),
    ...(config.datePropertyId ? [config.datePropertyId] : []),
  ]);
  const [propertyRows, documents, boardCards] = await Promise.all([
    ctx.db
      .query("documentProperties")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect(),
    ctx.db
      .query("documents")
      .withIndex("by_project_kind", (q) => q.eq("projectId", projectId).eq("kind", "file"))
      .order("desc")
      .take(SHARED_VIEW_RECORD_LIMIT + 1),
    config.datePropertyId === "boardDue"
      ? ctx.db
          .query("boardCardRecords")
          .withIndex("by_project", (q) => q.eq("projectId", projectId))
          .order("desc")
          .take(SHARED_VIEW_RECORD_LIMIT + 1)
      : Promise.resolve([]),
  ]);
  const visible = visibleDocuments(documents).filter((document) =>
    documentAllowed(allowedDocumentIds, document._id),
  );
  const valuesByDocument = new Map<string, Doc<"documentPropertyValues">[]>();
  await Promise.all(
    [...referenced].map(async (propertyId) => {
      const id = ctx.db.normalizeId("documentProperties", propertyId);
      if (!id) return;
      const values = await ctx.db
        .query("documentPropertyValues")
        .withIndex("by_project_property", (q) => q.eq("projectId", projectId).eq("propertyId", id))
        .collect();
      for (const value of values) {
        const rows = valuesByDocument.get(value.documentId) ?? [];
        rows.push(value);
        valuesByDocument.set(value.documentId, rows);
      }
    }),
  );
  const records: SharedViewRecord[] = visible.map((document) => {
    const values = valuesByDocument.get(document._id) ?? [];
    return {
      id: document._id,
      name: document.name,
      fileType: document.fileType,
      updatedAt: document.updatedAt,
      properties: values
        .filter((value) => referenced.has(value.propertyId))
        .map((value) => ({
          propertyId: value.propertyId,
          displayValue: value.displayValue,
          dateValue: value.dateValue,
          dateEndValue: value.dateEndValue,
        })),
    };
  });
  if (config.datePropertyId === "boardDue") {
    const visibleDocumentIds = new Set(visible.map((document) => document._id));
    for (const card of boardCards.slice(0, SHARED_VIEW_RECORD_LIMIT)) {
      if (!visibleDocumentIds.has(card.documentId)) {
        continue;
      }
      records.push({
        id: `card:${card.documentId}:${card.cardId}`,
        name: card.title,
        fileType: "card",
        updatedAt: card.updatedAt,
        properties: [
          {
            propertyId: "boardDue",
            displayValue: card.due ? new Date(card.due).toISOString() : "",
            dateValue: card.due,
          },
        ],
      });
    }
  }
  const activeProperties = new Set(
    propertyRows
      .filter((property) => !property.deletedAt)
      .map((property) => property._id as string),
  );
  const filtered = records.filter((record) =>
    config.filters.every(
      (filter) =>
        (!VIEW_BUILTIN_PROPERTIES.has(filter.propertyId) &&
          !activeProperties.has(filter.propertyId)) ||
        viewRecordMatches(record, filter),
    ),
  );
  filtered.sort((left, right) => {
    for (const sort of config.sorts) {
      if (!VIEW_BUILTIN_PROPERTIES.has(sort.propertyId) && !activeProperties.has(sort.propertyId)) {
        continue;
      }
      const result = viewRecordValue(left, sort.propertyId).localeCompare(
        viewRecordValue(right, sort.propertyId),
        undefined,
        { numeric: true, sensitivity: "base" },
      );
      if (result !== 0) return sort.direction === "asc" ? result : -result;
    }
    return left.name.localeCompare(right.name);
  });
  return {
    config,
    properties: propertyRows
      .filter((property) => referenced.has(property._id))
      .map((property) => ({
        id: property._id,
        name: property.name,
        type: property.type,
        deleted: Boolean(property.deletedAt),
      })),
    records: filtered,
    truncated:
      documents.length > SHARED_VIEW_RECORD_LIMIT || boardCards.length > SHARED_VIEW_RECORD_LIMIT,
  };
}

export async function sharedChartPreview(
  ctx: QueryCtx,
  projectId: Id<"projects">,
  config: ChartConfig,
  allowedDocumentIds: AllowedDocuments,
) {
  let source = null;
  if (config.sourceDocId && documentAllowed(allowedDocumentIds, config.sourceDocId)) {
    const id = ctx.db.normalizeId("documents", config.sourceDocId);
    const sourceDoc = id ? await ctx.db.get(id) : null;
    if (
      sourceDoc?.kind === "file" &&
      sourceDoc.projectId === projectId &&
      sourceDoc.fileType === config.sourceType &&
      !(await isInactiveTree(ctx, sourceDoc))
    ) {
      const state = await documentState(ctx, sourceDoc);
      if (!state) return resolveChartData(config, null);
      const sourceYdoc = new Y.Doc();
      Y.applyUpdate(sourceYdoc, new Uint8Array(state));
      if (config.sourceType === "sheet") {
        source = chartSourceFromSheet(sourceYdoc, sourceDoc._id, sourceDoc.name);
      } else {
        const preview = await sharedViewPreview(
          ctx,
          projectId,
          inspectView(sourceYdoc),
          allowedDocumentIds,
        );
        const groupProperty = config.groupPropertyId
          ? ctx.db.normalizeId("documentProperties", config.groupPropertyId)
          : null;
        const groupDefinition = groupProperty ? await ctx.db.get(groupProperty) : null;
        const entries = aggregateViewRecords(preview.records, {
          groupPropertyId: config.groupPropertyId,
          valuePropertyId: config.valuePropertyId,
          aggregate: config.aggregate,
          groupOptions: groupDefinition?.options.map((option) => option.name),
        });
        source = {
          documentId: sourceDoc._id,
          name: sourceDoc.name,
          columns: [
            { id: "group", name: "Group" },
            { id: "value", name: config.aggregate === "sum" ? "Total" : "Count" },
          ],
          rows: entries.map(([label, value], index) => ({
            id: `aggregate:${index}`,
            values: [label, String(value)],
          })),
          truncated: preview.truncated,
        } satisfies ChartSource;
      }
      sourceYdoc.destroy();
    }
  }
  return resolveChartData(config, source);
}

export async function sharedDashboardPreview(
  ctx: QueryCtx,
  projectId: Id<"projects">,
  state: ArrayBuffer,
  allowedDocumentIds: AllowedDocuments,
) {
  const dashboard = new Y.Doc();
  Y.applyUpdate(dashboard, new Uint8Array(state));
  const tiles = inspectDashboard(dashboard);
  dashboard.destroy();
  const result: Array<{
    tile: (typeof tiles)[number];
    status: "ok" | "missing";
    chart?: Awaited<ReturnType<typeof sharedChartPreview>>;
    value?: number;
    truncated?: boolean;
  }> = [];
  for (const tile of tiles) {
    if (!documentAllowed(allowedDocumentIds, tile.sourceDocId)) {
      result.push({ tile, status: "missing" });
      continue;
    }
    const sourceId = ctx.db.normalizeId("documents", tile.sourceDocId);
    const sourceDoc = sourceId ? await ctx.db.get(sourceId) : null;
    if (
      sourceDoc?.kind !== "file" ||
      sourceDoc.projectId !== projectId ||
      (await isInactiveTree(ctx, sourceDoc))
    ) {
      result.push({ tile, status: "missing" });
      continue;
    }
    const sourceState = await documentState(ctx, sourceDoc);
    if (!sourceState) {
      result.push({ tile, status: "missing" });
      continue;
    }
    const sourceYdoc = new Y.Doc();
    Y.applyUpdate(sourceYdoc, new Uint8Array(sourceState));
    if (tile.kind === "chart" && sourceDoc.fileType === "chart") {
      const chart = await sharedChartPreview(
        ctx,
        projectId,
        inspectChart(sourceYdoc),
        allowedDocumentIds,
      );
      sourceYdoc.destroy();
      result.push({ tile, status: "ok", chart });
    } else if (tile.kind === "stat" && sourceDoc.fileType === "view") {
      const preview = await sharedViewPreview(
        ctx,
        projectId,
        inspectView(sourceYdoc),
        allowedDocumentIds,
      );
      sourceYdoc.destroy();
      const value =
        tile.aggregate === "count"
          ? preview.records.length
          : preview.records.reduce(
              (sum, record) =>
                sum +
                (Number(
                  record.properties.find((property) => property.propertyId === tile.propertyId)
                    ?.displayValue,
                ) || 0),
              0,
            );
      result.push({ tile, status: "ok", value, truncated: preview.truncated });
    } else {
      sourceYdoc.destroy();
      result.push({ tile, status: "missing" });
    }
  }
  return result;
}

function serviceSecretValid(provided: string): boolean {
  return secretMatches(provided, process.env.CONVEX_PURGE_SECRET);
}

async function hitRateLimit(ctx: MutationCtx, rateKey: string): Promise<boolean> {
  const now = Date.now();
  const row = await ctx.db
    .query("shareAccessWindows")
    .withIndex("by_ip", (q) => q.eq("ipHash", rateKey))
    .first();
  if (!row) {
    await ctx.db.insert("shareAccessWindows", {
      ipHash: rateKey,
      windowStart: now,
      count: 1,
      updatedAt: now,
    });
    return false;
  }
  if (now - row.windowStart >= RATE_WINDOW_MS) {
    await ctx.db.patch(row._id, { windowStart: now, count: 1, updatedAt: now });
    return false;
  }
  if (row.count >= RATE_MAX_HITS) {
    await ctx.db.patch(row._id, { updatedAt: now });
    return true;
  }
  await ctx.db.patch(row._id, { count: row.count + 1, updatedAt: now });
  return false;
}

async function orgAccessForViewer(
  ctx: QueryCtx,
  clerkOrgId: string,
  viewer: { userId?: string; orgId?: string; orgRole?: string },
): Promise<"allowed" | "auth-required" | "forbidden"> {
  if (!viewer.userId) {
    return "auth-required";
  }
  if (viewer.orgId !== clerkOrgId) {
    return "forbidden";
  }
  const member = await ctx.db
    .query("members")
    .withIndex("by_org_user", (q) =>
      q.eq("clerkOrgId", clerkOrgId).eq("memberUserId", viewer.userId as string),
    )
    .first();
  if (member?.status === "accepted" || viewer.orgRole === "org:admin") {
    return "allowed";
  }
  return "forbidden";
}

type Actor = {
  userId: string;
  name: string;
};

function shareToken(): string {
  return `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
}

function modeRank(mode: ShareMode): number {
  if (mode === "public") {
    return 2;
  }
  if (mode === "org") {
    return 1;
  }
  return 0;
}

async function actorFor(ctx: MutationCtx): Promise<Actor> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new Error("Unauthenticated");
  }
  return {
    userId: identity.subject,
    name: identity.name ?? identity.email ?? identity.subject,
  };
}

async function uniqueToken(ctx: MutationCtx): Promise<string> {
  for (let attempts = 0; attempts < 5; attempts += 1) {
    const token = shareToken();
    const existing = await ctx.db
      .query("documentShares")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (!existing) {
      return token;
    }
  }
  throw new Error("token-collision");
}

function visibleDocuments<T extends SharedTreeNode>(docs: T[]): T[] {
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

function isExternalRef(value: string): boolean {
  return /^(?:[a-z][a-z\d+.-]*:|#)/i.test(value);
}

function cleanRef(ref: string): string {
  return ref.split("#")[0]?.split("?")[0]?.trim() ?? "";
}

function pathOf(doc: SharedTreeNode, byId: Map<Id<"documents">, SharedTreeNode>): string {
  const parts: string[] = [];
  let current: SharedTreeNode | undefined = doc;
  const seen = new Set<Id<"documents">>();
  while (current && !seen.has(current._id)) {
    seen.add(current._id);
    parts.unshift(current.name);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return `/${parts.join("/")}`;
}

function resolveRef(
  from: SharedTreeNode,
  ref: string,
  docs: SharedTreeNode[],
): SharedTreeNode | null {
  const clean = cleanRef(ref);
  if (clean.length === 0 || isExternalRef(clean)) {
    return null;
  }
  const byId = new Map(docs.map((doc) => [doc._id, doc]));
  const fromPath = pathOf(from, byId);
  const fromDir = fromPath.slice(0, fromPath.lastIndexOf("/"));
  const base = clean.startsWith("/") ? clean : `${fromDir}/${clean}`;
  const segments: string[] = [];
  for (const segment of base.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const absolute = `/${segments.join("/")}`;
  return docs.find((candidate) => pathOf(candidate, byId) === absolute) ?? null;
}

function referencedPaths(content: string): string[] {
  const refs = new Set<string>();
  for (const match of content.matchAll(/!?\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)) {
    const ref = match[1];
    if (ref) {
      refs.add(ref);
    }
  }
  for (const match of content.matchAll(/\b(?:src|href)=["']([^"']+)["']/gi)) {
    const ref = match[1];
    if (ref) {
      refs.add(ref);
    }
  }
  return [...refs];
}

function includeAncestors(
  doc: SharedTreeNode,
  byId: Map<Id<"documents">, SharedTreeNode>,
  includeIds: Set<Id<"documents">>,
): void {
  let current: SharedTreeNode | undefined = doc;
  const seen = new Set<Id<"documents">>();
  while (current && !seen.has(current._id)) {
    seen.add(current._id);
    includeIds.add(current._id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
}

async function fileForAdmin(ctx: MutationCtx, documentId: Id<"documents">) {
  const doc = await ctx.db.get(documentId);
  if (doc?.kind !== "file" || (await isInactiveTree(ctx, doc))) {
    throw new Error("not-found");
  }
  const access = await requireProjectAdmin(ctx, doc.projectId);
  return { doc, access };
}

async function shareForDocument(ctx: QueryCtx, documentId: Id<"documents">) {
  return await ctx.db
    .query("documentShares")
    .withIndex("by_document", (q) => q.eq("documentId", documentId))
    .unique();
}

async function publicSharingEnabled(ctx: QueryCtx, clerkOrgId: string): Promise<boolean> {
  const org = await ctx.db
    .query("organizations")
    .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", clerkOrgId))
    .unique();
  return org?.publicSharingEnabled !== false;
}

export const getState = query({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    const access = doc?.kind === "file" ? await accessForProject(ctx, doc.projectId) : null;
    if (doc?.kind !== "file" || (await isInactiveTree(ctx, doc)) || !access) {
      return null;
    }
    const share = await shareForDocument(ctx, doc._id);
    const events = await ctx.db
      .query("documentShareEvents")
      .withIndex("by_document", (q) => q.eq("documentId", doc._id))
      .order("desc")
      .take(8);
    return {
      mode: share?.mode ?? ("private" as ShareMode),
      token: access.isAdmin ? (share?.token ?? null) : null,
      expiresAt: share?.expiresAt ?? null,
      updatedByName: share?.updatedByName ?? null,
      updatedAt: share?.updatedAt ?? null,
      canPublish: await publicSharingEnabled(ctx, doc.clerkOrgId),
      events: events.map((event) => ({
        id: event._id,
        actorName: event.actorName,
        previousMode: event.previousMode,
        nextMode: event.nextMode,
        createdAt: event.createdAt,
      })),
    };
  },
});

export const setMode = mutation({
  args: {
    documentId: v.id("documents"),
    mode: v.union(v.literal("private"), v.literal("org"), v.literal("public")),
    expiresAt: v.optional(v.union(v.number(), v.null())),
  },
  handler: async (ctx, args) => {
    const { doc, access } = await fileForAdmin(ctx, args.documentId);
    const actor = await actorFor(ctx);
    if (args.mode === "public" && !(await publicSharingEnabled(ctx, doc.clerkOrgId))) {
      throw new Error("public-sharing-disabled");
    }
    const existing = await ctx.db
      .query("documentShares")
      .withIndex("by_document", (q) => q.eq("documentId", doc._id))
      .unique();
    const previousMode = existing?.mode ?? ("private" as ShareMode);
    const now = Date.now();
    const token = args.mode === "private" ? null : (existing?.token ?? (await uniqueToken(ctx)));
    let expiresAt: number | undefined;
    if (args.mode === "private" || args.expiresAt === null) {
      expiresAt = undefined;
    } else if (typeof args.expiresAt === "number") {
      if (args.expiresAt <= now || args.expiresAt > now + MAX_EXPIRY_MS) {
        throw new Error("invalid-expiry");
      }
      expiresAt = args.expiresAt;
    } else {
      expiresAt = existing?.expiresAt;
    }
    if (existing) {
      await ctx.db.patch(existing._id, {
        mode: args.mode,
        token,
        expiresAt,
        updatedByUserId: actor.userId,
        updatedByName: actor.name,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("documentShares", {
        documentId: doc._id,
        projectId: doc.projectId,
        clerkOrgId: doc.clerkOrgId,
        mode: args.mode,
        token,
        expiresAt,
        createdByUserId: actor.userId,
        createdByName: actor.name,
        updatedByUserId: actor.userId,
        updatedByName: actor.name,
        createdAt: now,
        updatedAt: now,
      });
    }
    if (previousMode !== args.mode) {
      await ctx.db.insert("documentShareEvents", {
        documentId: doc._id,
        projectId: doc.projectId,
        clerkOrgId: doc.clerkOrgId,
        actorUserId: actor.userId,
        actorName: actor.name,
        previousMode,
        nextMode: args.mode,
        createdAt: now,
      });
      await recordProjectEvent(ctx, {
        projectId: doc.projectId,
        clerkOrgId: doc.clerkOrgId,
        kind: "share_changed",
        actorUserId: actor.userId,
        actorName: actor.name,
        documentId: doc._id,
        targetName: doc.name,
        previousValue: previousMode,
        nextValue: args.mode,
      });
    }
    await ctx.db.patch(access.project._id, { updatedAt: now });
  },
});

export const rotateShareToken = mutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const { doc, access } = await fileForAdmin(ctx, args.documentId);
    const actor = await actorFor(ctx);
    const existing = await ctx.db
      .query("documentShares")
      .withIndex("by_document", (q) => q.eq("documentId", doc._id))
      .unique();
    if (!existing || existing.mode === "private" || !existing.token) {
      throw new Error("no-active-share");
    }
    const now = Date.now();
    const token = await uniqueToken(ctx);
    await ctx.db.patch(existing._id, {
      token,
      updatedByUserId: actor.userId,
      updatedByName: actor.name,
      updatedAt: now,
    });
    await ctx.db.insert("documentShareEvents", {
      documentId: doc._id,
      projectId: doc.projectId,
      clerkOrgId: doc.clerkOrgId,
      actorUserId: actor.userId,
      actorName: actor.name,
      previousMode: existing.mode,
      nextMode: existing.mode,
      createdAt: now,
    });
    await recordProjectEvent(ctx, {
      projectId: doc.projectId,
      clerkOrgId: doc.clerkOrgId,
      kind: "share_changed",
      actorUserId: actor.userId,
      actorName: actor.name,
      documentId: doc._id,
      targetName: doc.name,
      previousValue: existing.mode,
      nextValue: existing.mode,
    });
    await ctx.db.patch(access.project._id, { updatedAt: now });
    return { token };
  },
});

export const checkShareRate = mutation({
  args: { secret: v.string(), rateKey: v.string() },
  handler: async (ctx, args) => {
    if (!serviceSecretValid(args.secret)) throw new Error("Forbidden");
    if (!RATE_KEY_PATTERN.test(args.rateKey)) return { limited: true };
    return { limited: await hitRateLimit(ctx, args.rateKey) };
  },
});

export const redeemShare = query({
  args: {
    secret: v.string(),
    token: v.string(),
    viewerUserId: v.optional(v.string()),
    viewerOrgId: v.optional(v.string()),
    viewerOrgRole: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!serviceSecretValid(args.secret)) {
      throw new Error("Forbidden");
    }
    if (!SHARE_TOKEN_PATTERN.test(args.token)) {
      return null;
    }
    const share = await ctx.db
      .query("documentShares")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    if (!share || share.mode === "private") {
      return null;
    }
    const project = await ctx.db.get(share.projectId);
    const doc = await ctx.db.get(share.documentId);
    if (!project || project.deletedAt || doc?.kind !== "file" || (await isInactiveTree(ctx, doc))) {
      return null;
    }
    if (share.expiresAt && share.expiresAt < Date.now()) {
      return { status: "expired" as const, mode: share.mode };
    }
    const publicAllowed =
      share.mode !== "public" || (await publicSharingEnabled(ctx, share.clerkOrgId));
    const effectiveMode: ShareMode = share.mode === "public" && !publicAllowed ? "org" : share.mode;
    if (effectiveMode === "org") {
      const access = await orgAccessForViewer(ctx, share.clerkOrgId, {
        userId: args.viewerUserId,
        orgId: args.viewerOrgId,
        orgRole: args.viewerOrgRole,
      });
      if (access !== "allowed") {
        return { status: access, mode: effectiveMode };
      }
    }
    const [projected, shares] = await Promise.all([
      ctx.db
        .query("documentNodes")
        .withIndex("by_project", (q) => q.eq("projectId", share.projectId))
        .collect(),
      ctx.db
        .query("documentShares")
        .withIndex("by_project", (q) => q.eq("projectId", share.projectId))
        .collect(),
    ]);
    const docs: SharedTreeNode[] = project.treeProjectedAt
      ? projected.map((node) => ({
          _id: node.documentId,
          parentId: node.parentId,
          kind: node.kind,
          name: node.name,
          fileType: node.fileType,
          size: node.size,
          mimeType: node.mimeType,
          updatedAt: node.updatedAt,
          deletingAt: node.deletingAt,
          trashedAt: node.trashedAt,
        }))
      : await ctx.db
          .query("documents")
          .withIndex("by_project", (q) => q.eq("projectId", share.projectId))
          .collect();
    const now = Date.now();
    const isShareLive = (row: Doc<"documentShares">): boolean =>
      row.mode !== "private" &&
      Boolean(row.token) &&
      !(row.expiresAt !== undefined && row.expiresAt < now);
    const sharedByDocument = new Map(
      shares.filter(isShareLive).map((row) => [row.documentId, row]),
    );
    const visible = visibleDocuments(docs);
    const visibleById = new Map(visible.map((node) => [node._id, node]));
    const includeIds = new Set<Id<"documents">>();
    includeAncestors(doc, visibleById, includeIds);
    for (const ref of referencedPaths(doc.content)) {
      const target = resolveRef(doc, ref, visible);
      if (!target) {
        continue;
      }
      if (target.kind === "asset") {
        includeAncestors(target, visibleById, includeIds);
      } else if (target.kind === "file") {
        const targetShare = sharedByDocument.get(target._id);
        if (targetShare && modeRank(targetShare.mode) >= modeRank(effectiveMode)) {
          includeAncestors(target, visibleById, includeIds);
        }
      }
    }
    const nodes = await Promise.all(
      visible
        .filter((node) => includeIds.has(node._id))
        .map(async (node) => {
          const asset = node.kind === "asset" ? await ctx.db.get(node._id) : null;
          return {
            id: node._id,
            parentId: node.parentId,
            kind: node.kind,
            name: node.name,
            fileType: node.fileType,
            size: node.size,
            mimeType: node.mimeType,
            assetUrl: asset?.storageId ? await ctx.storage.getUrl(asset.storageId) : null,
          };
        }),
    );
    const fileLinks = shares
      .filter(
        (row) =>
          isShareLive(row) &&
          modeRank(row.mode) >= modeRank(effectiveMode) &&
          includeIds.has(row.documentId),
      )
      .map((row) => ({ documentId: row.documentId, href: `/share/${row.token}` }));
    let sheetPreview: ReturnType<typeof sheetRenderModel> | undefined;
    let boardPreview: ReturnType<typeof boardRenderModel> | undefined;
    let viewPreview: Awaited<ReturnType<typeof sharedViewPreview>> | undefined;
    let chartPreview: Awaited<ReturnType<typeof sharedChartPreview>> | undefined;
    let dashboardPreview:
      | Array<{
          tile: ReturnType<typeof inspectDashboard>[number];
          status: "ok" | "missing";
          chart?: Awaited<ReturnType<typeof sharedChartPreview>>;
          value?: number;
          truncated?: boolean;
        }>
      | undefined;
    const currentState = await documentState(ctx, doc);
    if (doc.fileType === "sheet" && currentState) {
      const sheet = new Y.Doc();
      Y.applyUpdate(sheet, new Uint8Array(currentState));
      sheetPreview = sheetRenderModel(sheet);
      sheet.destroy();
    }
    if (doc.fileType === "board" && currentState) {
      const board = new Y.Doc();
      Y.applyUpdate(board, new Uint8Array(currentState));
      boardPreview = boardRenderModel(board);
      const visibleIds = new Set(visible.map((node) => node._id as string));
      for (const column of boardPreview.columns) {
        for (const card of column.cards) {
          card.linkedDocRemoved = Boolean(card.linkedDocId && !visibleIds.has(card.linkedDocId));
        }
      }
      board.destroy();
    }
    if (doc.fileType === "view" && currentState) {
      const view = new Y.Doc();
      Y.applyUpdate(view, new Uint8Array(currentState));
      const allowedDocumentIds = new Set(
        shares
          .filter((row) => isShareLive(row) && modeRank(row.mode) >= modeRank(effectiveMode))
          .map((row) => row.documentId as string),
      );
      viewPreview = await sharedViewPreview(
        ctx,
        doc.projectId,
        inspectView(view),
        allowedDocumentIds,
      );
      view.destroy();
    }
    if (doc.fileType === "chart" && currentState) {
      const chart = new Y.Doc();
      Y.applyUpdate(chart, new Uint8Array(currentState));
      const config = inspectChart(chart);
      chart.destroy();
      const allowedDocumentIds = new Set(
        shares
          .filter((row) => isShareLive(row) && modeRank(row.mode) >= modeRank(effectiveMode))
          .map((row) => row.documentId as string),
      );
      chartPreview = await sharedChartPreview(ctx, doc.projectId, config, allowedDocumentIds);
    }
    if (doc.fileType === "dashboard" && currentState) {
      const dashboard = new Y.Doc();
      Y.applyUpdate(dashboard, new Uint8Array(currentState));
      const tiles = inspectDashboard(dashboard);
      dashboard.destroy();
      const allowedDocumentIds = new Set(
        shares
          .filter((row) => isShareLive(row) && modeRank(row.mode) >= modeRank(effectiveMode))
          .map((row) => row.documentId as string),
      );
      dashboardPreview = [];
      for (const tile of tiles) {
        if (!allowedDocumentIds.has(tile.sourceDocId)) {
          dashboardPreview.push({ tile, status: "missing" });
          continue;
        }
        const sourceId = ctx.db.normalizeId("documents", tile.sourceDocId);
        const sourceDoc = sourceId ? await ctx.db.get(sourceId) : null;
        if (
          sourceDoc?.kind !== "file" ||
          sourceDoc.projectId !== doc.projectId ||
          (await isInactiveTree(ctx, sourceDoc))
        ) {
          dashboardPreview.push({ tile, status: "missing" });
          continue;
        }
        const state = await documentState(ctx, sourceDoc);
        if (!state) {
          dashboardPreview.push({ tile, status: "missing" });
          continue;
        }
        const sourceYdoc = new Y.Doc();
        Y.applyUpdate(sourceYdoc, new Uint8Array(state));
        if (tile.kind === "chart" && sourceDoc.fileType === "chart") {
          const chart = await sharedChartPreview(
            ctx,
            doc.projectId,
            inspectChart(sourceYdoc),
            allowedDocumentIds,
          );
          sourceYdoc.destroy();
          dashboardPreview.push({ tile, status: "ok", chart });
        } else if (tile.kind === "stat" && sourceDoc.fileType === "view") {
          const preview = await sharedViewPreview(
            ctx,
            doc.projectId,
            inspectView(sourceYdoc),
            allowedDocumentIds,
          );
          sourceYdoc.destroy();
          const value =
            tile.aggregate === "count"
              ? preview.records.length
              : preview.records.reduce(
                  (sum, record) =>
                    sum +
                    (Number(
                      record.properties.find((property) => property.propertyId === tile.propertyId)
                        ?.displayValue,
                    ) || 0),
                  0,
                );
          dashboardPreview.push({ tile, status: "ok", value, truncated: preview.truncated });
        } else {
          sourceYdoc.destroy();
          dashboardPreview.push({ tile, status: "missing" });
        }
      }
    }
    return {
      status: "ok" as const,
      mode: effectiveMode,
      projectTitle: project.title,
      documentId: doc._id,
      documentName: doc.name,
      fileType: doc.fileType,
      content: doc.content,
      sheetPreview,
      boardPreview,
      viewPreview,
      chartPreview,
      dashboardPreview,
      updatedAt: doc.updatedAt,
      nodes,
      fileLinks,
    };
  },
});

export const pruneShareEvents = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - SHARE_EVENT_RETENTION_MS;
    const rows = await ctx.db
      .query("documentShareEvents")
      .withIndex("by_created", (q) => q.lt("createdAt", cutoff))
      .take(PRUNE_BATCH);
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
    if (rows.length === PRUNE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.sharing.pruneShareEvents, {});
      return;
    }
    const projectRows = await ctx.db
      .query("projectShareEvents")
      .withIndex("by_created", (q) => q.lt("createdAt", cutoff))
      .take(PRUNE_BATCH);
    for (const row of projectRows) await ctx.db.delete(row._id);
    if (projectRows.length === PRUNE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.sharing.pruneShareEvents, {});
    }
  },
});

export const pruneShareWindows = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - WINDOW_RETENTION_MS;
    const rows = await ctx.db
      .query("shareAccessWindows")
      .withIndex("by_updated", (q) => q.lt("updatedAt", cutoff))
      .take(PRUNE_BATCH);
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
    if (rows.length === PRUNE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.sharing.pruneShareWindows, {});
    }
  },
});
