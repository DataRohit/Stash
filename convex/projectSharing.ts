import { v } from "convex/values";
import * as Y from "yjs";
import { inspectChart } from "../lib/chart-model";
import { boardRenderModel, sheetRenderModel } from "../lib/doc-projection";
import { inspectView } from "../lib/view-model";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { recordOrganizationEvent } from "./audit";
import { accessForProject, documentState, isInactiveTree, requireProjectAdmin } from "./documents";
import { secretMatches } from "./secrets";
import { sharedChartPreview, sharedDashboardPreview, sharedViewPreview } from "./sharing";

type ShareMode = "private" | "org" | "public";
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const MAX_EXCLUSIONS = 500;
const TREE_PAGE = 200;
const MAX_EXPIRY_MS = 365 * 24 * 60 * 60 * 1_000;

function newToken(): string {
  return `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
}

async function uniqueToken(ctx: MutationCtx): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const token = newToken();
    const [project, document] = await Promise.all([
      ctx.db
        .query("projectShares")
        .withIndex("by_token", (q) => q.eq("token", token))
        .unique(),
      ctx.db
        .query("documentShares")
        .withIndex("by_token", (q) => q.eq("token", token))
        .unique(),
    ]);
    if (!project && !document) return token;
  }
  throw new Error("token-collision");
}

async function publicSharingEnabled(ctx: QueryCtx, clerkOrgId: string): Promise<boolean> {
  const organization = await ctx.db
    .query("organizations")
    .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", clerkOrgId))
    .unique();
  return organization?.publicSharingEnabled !== false;
}

async function orgViewerAllowed(
  ctx: QueryCtx,
  share: Doc<"projectShares">,
  viewer: { userId?: string; orgId?: string; orgRole?: string },
): Promise<"allowed" | "auth-required" | "forbidden"> {
  if (!viewer.userId || !viewer.orgId) return "auth-required";
  if (viewer.orgId !== share.clerkOrgId) return "forbidden";
  if (viewer.orgRole === "org:admin") return "allowed";
  const grant = await ctx.db
    .query("projectAccess")
    .withIndex("by_project_user", (q) =>
      q.eq("projectId", share.projectId).eq("userId", viewer.userId ?? ""),
    )
    .unique();
  return grant ? "allowed" : "forbidden";
}

export const getState = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const access = await accessForProject(ctx, args.projectId);
    if (!access?.isAdmin) throw new Error("Forbidden");
    const share = await ctx.db
      .query("projectShares")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .unique();
    const events = await ctx.db
      .query("projectShareEvents")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(10);
    return {
      mode: share?.mode ?? "private",
      token: share?.mode !== "private" ? share?.token : undefined,
      expiresAt: share?.expiresAt ?? null,
      excludedDocumentIds: share?.excludedDocumentIds ?? [],
      canPublish: await publicSharingEnabled(ctx, access.project.clerkOrgId),
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

export const set = mutation({
  args: {
    projectId: v.id("projects"),
    mode: v.union(v.literal("private"), v.literal("org"), v.literal("public")),
    expiresAt: v.optional(v.union(v.number(), v.null())),
    excludedDocumentIds: v.optional(v.array(v.id("documents"))),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectAdmin(ctx, args.projectId);
    if (args.mode === "public" && !(await publicSharingEnabled(ctx, access.project.clerkOrgId))) {
      throw new Error("public-sharing-disabled");
    }
    const now = Date.now();
    if (args.expiresAt && (args.expiresAt <= now || args.expiresAt > now + MAX_EXPIRY_MS)) {
      throw new Error("invalid-expiry");
    }
    const exclusions = [...new Set(args.excludedDocumentIds ?? [])].slice(0, MAX_EXCLUSIONS);
    for (const id of exclusions) {
      const document = await ctx.db.get(id);
      if (!document || document.projectId !== args.projectId) throw new Error("invalid-exclusion");
    }
    const existing = await ctx.db
      .query("projectShares")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .unique();
    const token = existing?.token ?? (await uniqueToken(ctx));
    const fields = {
      mode: args.mode,
      token,
      expiresAt: args.expiresAt ?? existing?.expiresAt ?? null,
      excludedDocumentIds: exclusions,
      updatedBy: access.userId,
      updatedAt: now,
    };
    if (existing) await ctx.db.patch(existing._id, fields);
    else {
      await ctx.db.insert("projectShares", {
        projectId: args.projectId,
        clerkOrgId: access.project.clerkOrgId,
        createdBy: access.userId,
        createdAt: now,
        ...fields,
      });
    }
    await ctx.db.insert("projectShareEvents", {
      projectId: args.projectId,
      clerkOrgId: access.project.clerkOrgId,
      actorUserId: access.userId,
      actorName: access.userId,
      previousMode: existing?.mode ?? "private",
      nextMode: args.mode,
      createdAt: now,
    });
    await recordOrganizationEvent(ctx, {
      clerkOrgId: access.project.clerkOrgId,
      actorUserId: access.userId,
      actorName: access.userId,
      kind: "project_share.changed",
      projectId: args.projectId,
      projectName: access.project.title,
      targetId: args.projectId,
      targetName: access.project.title,
      metadata: JSON.stringify({ previousMode: existing?.mode ?? "private", mode: args.mode }),
    });
    return { ...fields, token: args.mode === "private" ? undefined : token };
  },
});

export const rotate = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const access = await requireProjectAdmin(ctx, args.projectId);
    const share = await ctx.db
      .query("projectShares")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .unique();
    if (!share || share.mode === "private") throw new Error("share-inactive");
    const token = await uniqueToken(ctx);
    await ctx.db.patch(share._id, { token, updatedBy: access.userId, updatedAt: Date.now() });
    await ctx.db.insert("projectShareEvents", {
      projectId: args.projectId,
      clerkOrgId: access.project.clerkOrgId,
      actorUserId: access.userId,
      actorName: access.userId,
      previousMode: share.mode,
      nextMode: share.mode,
      createdAt: Date.now(),
    });
    return token;
  },
});

export const redeem = query({
  args: {
    secret: v.string(),
    token: v.string(),
    documentId: v.optional(v.id("documents")),
    treeCursor: v.optional(v.union(v.string(), v.null())),
    viewerUserId: v.optional(v.string()),
    viewerOrgId: v.optional(v.string()),
    viewerOrgRole: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!secretMatches(args.secret, process.env.CONVEX_PURGE_SECRET)) throw new Error("Forbidden");
    if (!TOKEN_PATTERN.test(args.token)) return null;
    const share = await ctx.db
      .query("projectShares")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    if (!share || share.mode === "private") return null;
    const project = await ctx.db.get(share.projectId);
    if (!project || project.deletedAt) return null;
    if (share.expiresAt && share.expiresAt <= Date.now()) return { status: "expired" as const };
    const mode: ShareMode =
      share.mode === "public" && !(await publicSharingEnabled(ctx, share.clerkOrgId))
        ? "org"
        : share.mode;
    if (mode === "org") {
      const result = await orgViewerAllowed(ctx, share, {
        userId: args.viewerUserId,
        orgId: args.viewerOrgId,
        orgRole: args.viewerOrgRole,
      });
      if (result !== "allowed") return { status: result };
    }
    const excluded = new Set(share.excludedDocumentIds);
    const page = await ctx.db
      .query("documents")
      .withIndex("by_project", (q) => q.eq("projectId", share.projectId))
      .paginate({
        cursor: args.treeCursor ?? null,
        numItems: TREE_PAGE,
        maximumRowsRead: TREE_PAGE,
      });
    const nodes = [];
    for (const node of page.page) {
      if (excluded.has(node._id) || (await isInactiveTree(ctx, node))) continue;
      nodes.push({
        id: node._id,
        parentId: node.parentId,
        kind: node.kind,
        name: node.name,
        fileType: node.fileType,
        size: node.size,
        mimeType: node.mimeType,
        assetUrl: node.storageId ? await ctx.storage.getUrl(node.storageId) : null,
      });
    }
    let document = args.documentId ? await ctx.db.get(args.documentId) : null;
    if (
      !document ||
      document.projectId !== share.projectId ||
      (document.kind !== "file" && document.kind !== "asset") ||
      excluded.has(document._id) ||
      (await isInactiveTree(ctx, document))
    ) {
      document = null;
      for (const node of page.page) {
        if (
          (node.kind === "file" || node.kind === "asset") &&
          !excluded.has(node._id) &&
          !(await isInactiveTree(ctx, node))
        ) {
          document = node;
          break;
        }
      }
    }
    if (!document) {
      return {
        status: "ok" as const,
        mode,
        projectTitle: project.title,
        nodes,
        nextCursor: page.isDone ? null : page.continueCursor,
        document: null,
      };
    }
    const state = document.kind === "file" ? await documentState(ctx, document) : null;
    let sheetPreview: ReturnType<typeof sheetRenderModel> | undefined;
    let boardPreview: ReturnType<typeof boardRenderModel> | undefined;
    let viewPreview: Awaited<ReturnType<typeof sharedViewPreview>> | undefined;
    let chartPreview: Awaited<ReturnType<typeof sharedChartPreview>> | undefined;
    let dashboardPreview: Awaited<ReturnType<typeof sharedDashboardPreview>> | undefined;
    if (state && document.fileType) {
      const ydoc = new Y.Doc();
      Y.applyUpdate(ydoc, new Uint8Array(state));
      if (document.fileType === "sheet") sheetPreview = sheetRenderModel(ydoc);
      if (document.fileType === "board") boardPreview = boardRenderModel(ydoc);
      const allowed = (documentId: string) => {
        const normalized = ctx.db.normalizeId("documents", documentId);
        return Boolean(normalized && !excluded.has(normalized));
      };
      if (document.fileType === "view") {
        viewPreview = await sharedViewPreview(ctx, document.projectId, inspectView(ydoc), allowed);
      }
      if (document.fileType === "chart") {
        chartPreview = await sharedChartPreview(
          ctx,
          document.projectId,
          inspectChart(ydoc),
          allowed,
        );
      }
      if (document.fileType === "dashboard") {
        dashboardPreview = await sharedDashboardPreview(ctx, document.projectId, state, allowed);
      }
      ydoc.destroy();
    }
    return {
      status: "ok" as const,
      mode,
      projectTitle: project.title,
      nodes,
      nextCursor: page.isDone ? null : page.continueCursor,
      document: {
        id: document._id,
        kind: document.kind as "file" | "asset",
        name: document.name,
        fileType: document.fileType,
        content: document.content,
        updatedAt: document.updatedAt,
        mimeType: document.mimeType,
        size: document.size,
        assetUrl: document.storageId ? await ctx.storage.getUrl(document.storageId) : null,
        sheetPreview,
        boardPreview,
        viewPreview,
        chartPreview,
        dashboardPreview,
      },
    };
  },
});
