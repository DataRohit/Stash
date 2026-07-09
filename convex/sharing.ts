import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { accessForProject, requireProjectAdmin } from "./documents";

type ShareMode = "private" | "org" | "public";

const SHARE_EVENT_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const PRUNE_BATCH = 200;

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

function visibleDocuments(docs: Doc<"documents">[]): Doc<"documents">[] {
  const byId = new Map(docs.map((doc) => [doc._id, doc]));
  const hidden = new Set<Id<"documents">>();
  for (const doc of docs) {
    let current: Doc<"documents"> | undefined = doc;
    const seen = new Set<Id<"documents">>();
    while (current && !seen.has(current._id)) {
      seen.add(current._id);
      if (current.deletingAt) {
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

function pathOf(doc: Doc<"documents">, byId: Map<Id<"documents">, Doc<"documents">>): string {
  const parts: string[] = [];
  let current: Doc<"documents"> | undefined = doc;
  const seen = new Set<Id<"documents">>();
  while (current && !seen.has(current._id)) {
    seen.add(current._id);
    parts.unshift(current.name);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return `/${parts.join("/")}`;
}

function resolveRef(
  from: Doc<"documents">,
  ref: string,
  docs: Doc<"documents">[],
): Doc<"documents"> | null {
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
  doc: Doc<"documents">,
  byId: Map<Id<"documents">, Doc<"documents">>,
  includeIds: Set<Id<"documents">>,
): void {
  let current: Doc<"documents"> | undefined = doc;
  const seen = new Set<Id<"documents">>();
  while (current && !seen.has(current._id)) {
    seen.add(current._id);
    includeIds.add(current._id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
}

async function fileForAdmin(ctx: MutationCtx, documentId: Id<"documents">) {
  const doc = await ctx.db.get(documentId);
  if (doc?.kind !== "file" || doc.deletingAt) {
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

async function orgAccessState(ctx: QueryCtx, clerkOrgId: string) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    return "auth-required" as const;
  }
  if (identity.org_id !== clerkOrgId) {
    return "forbidden" as const;
  }
  const member = await ctx.db
    .query("members")
    .withIndex("by_org_user", (q) =>
      q.eq("clerkOrgId", clerkOrgId).eq("memberUserId", identity.subject),
    )
    .first();
  if (member?.status === "accepted" || identity.org_role === "org:admin") {
    return "allowed" as const;
  }
  return "forbidden" as const;
}

export const getState = query({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (doc?.kind !== "file" || doc.deletingAt || !(await accessForProject(ctx, doc.projectId))) {
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
      token: share?.token ?? null,
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
    if (existing) {
      await ctx.db.patch(existing._id, {
        mode: args.mode,
        token,
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
    }
    await ctx.db.patch(access.project._id, { updatedAt: now });
  },
});

export const getSharedDocument = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const share = await ctx.db
      .query("documentShares")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    if (!share || share.mode === "private") {
      return null;
    }
    const project = await ctx.db.get(share.projectId);
    const doc = await ctx.db.get(share.documentId);
    if (!project || project.deletedAt || doc?.kind !== "file" || doc.deletingAt) {
      return null;
    }
    if (share.mode === "public" && !(await publicSharingEnabled(ctx, share.clerkOrgId))) {
      return null;
    }
    if (share.mode === "org") {
      const access = await orgAccessState(ctx, share.clerkOrgId);
      if (access !== "allowed") {
        return { status: access, mode: share.mode };
      }
    }
    const [docs, shares] = await Promise.all([
      ctx.db
        .query("documents")
        .withIndex("by_project", (q) => q.eq("projectId", share.projectId))
        .collect(),
      ctx.db
        .query("documentShares")
        .withIndex("by_project", (q) => q.eq("projectId", share.projectId))
        .collect(),
    ]);
    const sharedByDocument = new Map(
      shares
        .filter((row) => row.mode !== "private" && row.token)
        .map((row) => [row.documentId, row]),
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
        if (targetShare && modeRank(targetShare.mode) >= modeRank(share.mode)) {
          includeAncestors(target, visibleById, includeIds);
        }
      }
    }
    const nodes = await Promise.all(
      visible
        .filter((node) => includeIds.has(node._id))
        .map(async (node) => ({
          id: node._id,
          parentId: node.parentId,
          kind: node.kind,
          name: node.name,
          fileType: node.fileType,
          size: node.size,
          mimeType: node.mimeType,
          assetUrl:
            node.kind === "asset" && node.storageId
              ? await ctx.storage.getUrl(node.storageId)
              : null,
        })),
    );
    const fileLinks = shares
      .filter(
        (row) =>
          row.mode !== "private" &&
          row.token &&
          modeRank(row.mode) >= modeRank(share.mode) &&
          includeIds.has(row.documentId),
      )
      .map((row) => ({ documentId: row.documentId, href: `/share/${row.token}` }));
    return {
      status: "ok" as const,
      mode: share.mode,
      projectTitle: project.title,
      documentId: doc._id,
      documentName: doc.name,
      fileType: doc.fileType,
      content: doc.content,
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
    }
  },
});
