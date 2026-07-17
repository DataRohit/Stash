import { v } from "convex/values";
import type { FileType } from "../lib/document-types";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { accessForProject, isInactiveTree } from "./documents";
import { enforceWriteRateLimit } from "./writeRateLimit";

const RECENT_LIMIT = 8;
const PALETTE_LIMIT = 16;
const PAGE_LIMIT = 60;
const CONTENT_LIMIT = 8;
const MAX_QUERY_LENGTH = 120;
const SEARCH_CANDIDATE_LIMIT = 240;
const MAX_PATH_DEPTH = 32;
const RECENT_CAP = 100;
const RECENT_TRIM_BATCH = 25;
const RECENT_WALK_BATCH = 8;
const FAVORITE_CAP = 200;
const FAVORITE_WRITE_LIMIT = { capacity: 40, refillPerSecond: 2 };

type SearchResult = {
  id: string;
  projectId: Id<"projects">;
  projectTitle: string;
  documentId: Id<"documents"> | null;
  kind: "project" | "file" | "folder" | "asset" | "content";
  name: string;
  path: string;
  fileType: FileType | null;
  snippet: { before: string; match: string; after: string; lineNumber: number } | null;
  rank: number;
};

async function caller(ctx: QueryCtx, clerkOrgId: string) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity || identity.org_id !== clerkOrgId) {
    return null;
  }
  return { userId: identity.subject, isAdmin: identity.org_role === "org:admin" };
}

async function accessibleProjects(ctx: QueryCtx, clerkOrgId: string) {
  const actor = await caller(ctx, clerkOrgId);
  if (!actor) {
    return { actor: null, projects: [] as Doc<"projects">[] };
  }
  let projects: Doc<"projects">[];
  if (actor.isAdmin) {
    projects = await ctx.db
      .query("projects")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", clerkOrgId))
      .collect();
  } else {
    const grants = await ctx.db
      .query("projectAccess")
      .withIndex("by_org_user", (q) => q.eq("clerkOrgId", clerkOrgId).eq("userId", actor.userId))
      .collect();
    const rows = await Promise.all(grants.map((grant) => ctx.db.get(grant.projectId)));
    projects = rows.filter((row): row is Doc<"projects"> => row !== null);
  }
  return { actor, projects: projects.filter((project) => !project.deletedAt) };
}

function snippet(content: string, term: string) {
  const lower = content.toLowerCase();
  const exact = term.toLowerCase();
  let matchedTerm = exact;
  let at = lower.indexOf(exact);
  if (at < 0) {
    const terms = exact.match(/[\p{L}\p{N}_]+/gu) ?? [];
    const matches = terms
      .map((candidate) => ({ candidate, at: lower.indexOf(candidate) }))
      .filter((match) => match.at >= 0)
      .sort((a, b) => a.at - b.at || b.candidate.length - a.candidate.length);
    if (matches[0]) {
      at = matches[0].at;
      matchedTerm = matches[0].candidate;
    }
  }
  if (at < 0) {
    return { before: content.slice(0, 100), match: "", after: "", lineNumber: 1 };
  }
  const beforeAt = Math.max(0, at - 70);
  const afterAt = at + matchedTerm.length;
  return {
    before: `${beforeAt > 0 ? "…" : ""}${content.slice(beforeAt, at)}`,
    match: content.slice(at, afterAt),
    after: `${content.slice(afterAt, afterAt + 100)}${afterAt + 100 < content.length ? "…" : ""}`,
    lineNumber: content.slice(0, at).split("\n").length,
  };
}

async function visiblePath(ctx: QueryCtx, doc: Doc<"documents">): Promise<string | null> {
  const parts: string[] = [];
  const seen = new Set<Id<"documents">>();
  let current: Doc<"documents"> | null = doc;
  while (current && parts.length < MAX_PATH_DEPTH && !seen.has(current._id)) {
    if (current.deletingAt || current.trashedAt) {
      return null;
    }
    seen.add(current._id);
    parts.unshift(current.name);
    current = current.parentId ? await ctx.db.get(current.parentId) : null;
  }
  if (current) {
    return null;
  }
  return `/${parts.join("/")}`;
}

async function trimRecentGroup(ctx: MutationCtx, userId: string, clerkOrgId: string) {
  const rows = await ctx.db
    .query("recentDocuments")
    .withIndex("by_user_org_time", (q) => q.eq("userId", userId).eq("clerkOrgId", clerkOrgId))
    .order("desc")
    .take(RECENT_CAP + RECENT_TRIM_BATCH);
  const stale = rows.slice(RECENT_CAP);
  for (const row of stale) {
    await ctx.db.delete(row._id);
  }
  return { deleted: stale.length, hasMore: stale.length === RECENT_TRIM_BATCH };
}

export const pruneRecentGroup = internalMutation({
  args: { userId: v.string(), clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    const result = await trimRecentGroup(ctx, args.userId, args.clerkOrgId);
    if (result.hasMore) {
      await ctx.scheduler.runAfter(0, internal.navigation.pruneRecentGroup, args);
    }
    return result;
  },
});

export const pruneRecentDocuments = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("recentDocuments")
      .withIndex("by_creation_time")
      .paginate({
        cursor: args.cursor ?? null,
        numItems: RECENT_WALK_BATCH,
        maximumRowsRead: RECENT_WALK_BATCH,
      });
    const groups = new Map<string, { userId: string; clerkOrgId: string }>();
    for (const row of page.page) {
      groups.set(`${row.userId}\u0000${row.clerkOrgId}`, {
        userId: row.userId,
        clerkOrgId: row.clerkOrgId,
      });
    }
    let deleted = 0;
    for (const group of groups.values()) {
      deleted += (await trimRecentGroup(ctx, group.userId, group.clerkOrgId)).deleted;
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.navigation.pruneRecentDocuments, {
        cursor: page.continueCursor,
      });
    }
    return {
      scanned: page.page.length,
      groups: groups.size,
      deleted,
      isDone: page.isDone,
      nextCursor: page.isDone ? null : page.continueCursor,
    };
  },
});

export const search = query({
  args: {
    clerkOrgId: v.string(),
    query: v.string(),
    mode: v.union(v.literal("palette"), v.literal("page")),
  },
  handler: async (ctx, args) => {
    const term = args.query.trim().slice(0, MAX_QUERY_LENGTH);
    if (!term) {
      return [];
    }
    const { actor, projects } = await accessibleProjects(ctx, args.clerkOrgId);
    if (!actor || (!actor.isAdmin && projects.length === 0)) {
      return [];
    }
    const needle = term.toLowerCase();
    const results: SearchResult[] = [];
    const projectById = new Map(projects.map((project) => [project._id, project]));
    for (const project of projects) {
      const projectName = project.title.toLowerCase();
      if (projectName.includes(needle)) {
        results.push({
          id: `project:${project._id}`,
          projectId: project._id,
          projectTitle: project.title,
          documentId: null,
          kind: "project",
          name: project.title,
          path: "/",
          fileType: null,
          snippet: null,
          rank: projectName === needle ? 0 : projectName.startsWith(needle) ? 1 : 2,
        });
      }
    }
    const perProjectLimit = Math.max(
      8,
      Math.min(40, Math.ceil(SEARCH_CANDIDATE_LIMIT / Math.max(1, projects.length)) * 2),
    );
    const projectHits = await Promise.all(
      projects.map(async (project) => {
        const [names, content] = await Promise.all([
          ctx.db
            .query("documents")
            .withSearchIndex("search_name", (q) =>
              q.search("name", term).eq("projectId", project._id),
            )
            .take(perProjectLimit),
          ctx.db
            .query("documents")
            .withSearchIndex("search_content", (q) =>
              q.search("content", term).eq("projectId", project._id).eq("kind", "file"),
            )
            .take(perProjectLimit),
        ]);
        return { names, content };
      }),
    );
    const nameHits = projectHits.flatMap((hit) => hit.names);
    const contentHits = projectHits.flatMap((hit) => hit.content);
    let nameRanked = 0;
    for (const doc of nameHits) {
      if (nameRanked >= PAGE_LIMIT) {
        break;
      }
      const project = projectById.get(doc.projectId);
      if (!project) {
        continue;
      }
      const path = await visiblePath(ctx, doc);
      if (!path) {
        continue;
      }
      const name = doc.name.toLowerCase();
      results.push({
        id: `node:${doc._id}`,
        projectId: project._id,
        projectTitle: project.title,
        documentId: doc._id,
        kind: doc.kind,
        name: doc.name,
        path,
        fileType: doc.fileType,
        snippet: null,
        rank: name === needle ? 0 : name.startsWith(needle) ? 1 : 3,
      });
      nameRanked += 1;
    }
    let contentRank = 0;
    for (const doc of contentHits) {
      if (contentRank >= CONTENT_LIMIT) {
        break;
      }
      const project = projectById.get(doc.projectId);
      if (!project) {
        continue;
      }
      const path = await visiblePath(ctx, doc);
      if (!path) {
        continue;
      }
      const existing = results.find((result) => result.documentId === doc._id);
      if (existing) {
        existing.snippet = snippet(doc.content, term);
      } else {
        results.push({
          id: `content:${doc._id}`,
          projectId: project._id,
          projectTitle: project.title,
          documentId: doc._id,
          kind: "content",
          name: doc.name,
          path,
          fileType: doc.fileType,
          snippet: snippet(doc.content, term),
          rank: 10 + contentRank,
        });
      }
      contentRank += 1;
    }
    return results
      .sort(
        (a, b) =>
          a.rank - b.rank ||
          a.projectTitle.localeCompare(b.projectTitle) ||
          a.name.localeCompare(b.name),
      )
      .slice(0, args.mode === "palette" ? PALETTE_LIMIT : PAGE_LIMIT)
      .map((result) => ({
        id: result.id,
        projectId: result.projectId,
        projectTitle: result.projectTitle,
        documentId: result.documentId,
        kind: result.kind,
        name: result.name,
        path: result.path,
        fileType: result.fileType,
        snippet: result.snippet,
      }));
  },
});

export const listProjects = query({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    const { projects } = await accessibleProjects(ctx, args.clerkOrgId);
    return projects
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((project) => ({ id: project._id, title: project.title }));
  },
});

export const toggleFavorite = mutation({
  args: {
    projectId: v.id("projects"),
    documentId: v.optional(v.id("documents")),
    favorite: v.boolean(),
  },
  handler: async (ctx, args) => {
    const access = await accessForProject(ctx, args.projectId);
    if (!access) throw new Error("forbidden");
    if (args.documentId) {
      const doc = await ctx.db.get(args.documentId);
      if (!doc || doc.projectId !== args.projectId || doc.deletingAt) throw new Error("not-found");
    }
    const rateKey = args.documentId ?? args.projectId;
    if (
      !(await enforceWriteRateLimit(ctx, "favorites", rateKey, access.userId, FAVORITE_WRITE_LIMIT))
    ) {
      throw new Error("rate-limited");
    }
    const rows = await ctx.db
      .query("favorites")
      .withIndex("by_user_project", (q) =>
        q
          .eq("userId", access.userId)
          .eq("projectId", args.projectId)
          .eq("documentId", args.documentId),
      )
      .collect();
    if (!args.favorite) {
      for (const row of rows) await ctx.db.delete(row._id);
      return false;
    }
    if (rows.length > 0) {
      for (const duplicate of rows.slice(1)) await ctx.db.delete(duplicate._id);
      return true;
    }
    const count = await ctx.db
      .query("favorites")
      .withIndex("by_user_org", (q) =>
        q.eq("userId", access.userId).eq("clerkOrgId", access.project.clerkOrgId),
      )
      .take(FAVORITE_CAP);
    if (count.length >= FAVORITE_CAP) throw new Error("favorite-limit-reached");
    await ctx.db.insert("favorites", {
      clerkOrgId: access.project.clerkOrgId,
      userId: access.userId,
      projectId: args.projectId,
      ...(args.documentId ? { documentId: args.documentId } : {}),
      createdAt: Date.now(),
    });
    return true;
  },
});

export const listFavorites = query({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    const actor = await caller(ctx, args.clerkOrgId);
    if (!actor) return [];
    const rows = await ctx.db
      .query("favorites")
      .withIndex("by_user_org", (q) =>
        q.eq("userId", actor.userId).eq("clerkOrgId", args.clerkOrgId),
      )
      .order("asc")
      .take(FAVORITE_CAP);
    const output = [];
    for (const row of rows) {
      const project = await ctx.db.get(row.projectId);
      if (!project || project.deletedAt || !(await accessForProject(ctx, row.projectId))) continue;
      if (!row.documentId) {
        output.push({
          id: row._id,
          projectId: project._id,
          projectTitle: project.title,
          documentId: null,
          name: project.title,
          path: "/",
          kind: "project" as const,
          fileType: null,
          trashed: false,
          createdAt: row.createdAt,
        });
        continue;
      }
      const doc = await ctx.db.get(row.documentId);
      if (!doc || doc.deletingAt || doc.projectId !== project._id) continue;
      const path = doc.trashedAt ? `/${doc.name}` : await visiblePath(ctx, doc);
      if (!path) continue;
      output.push({
        id: row._id,
        projectId: project._id,
        projectTitle: project.title,
        documentId: doc._id,
        name: doc.name,
        path,
        kind: doc.kind,
        fileType: doc.fileType,
        trashed: Boolean(doc.trashedAt),
        createdAt: row.createdAt,
      });
    }
    return output;
  },
});

export const recordOpened = mutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (!doc || doc.kind === "folder" || (await isInactiveTree(ctx, doc))) {
      return false;
    }
    const access = await accessForProject(ctx, doc.projectId);
    if (!access) {
      return false;
    }
    const matches = await ctx.db
      .query("recentDocuments")
      .withIndex("by_user_document", (q) => q.eq("userId", access.userId).eq("documentId", doc._id))
      .take(RECENT_CAP + 1);
    const value = {
      clerkOrgId: doc.clerkOrgId,
      userId: access.userId,
      projectId: doc.projectId,
      documentId: doc._id,
      lastOpenedAt: Date.now(),
    };
    const [existing, ...duplicates] = matches;
    if (existing) {
      await ctx.db.patch(existing._id, value);
      for (const duplicate of duplicates) {
        await ctx.db.delete(duplicate._id);
      }
    } else {
      await ctx.db.insert("recentDocuments", value);
    }
    const trimmed = await trimRecentGroup(ctx, access.userId, doc.clerkOrgId);
    if (trimmed.hasMore) {
      await ctx.scheduler.runAfter(0, internal.navigation.pruneRecentGroup, {
        userId: access.userId,
        clerkOrgId: doc.clerkOrgId,
      });
    }
    const unread = await ctx.db
      .query("notifications")
      .withIndex("by_recipient_org_read", (q) =>
        q.eq("recipientUserId", access.userId).eq("clerkOrgId", doc.clerkOrgId).eq("readAt", null),
      )
      .take(200);
    const readAt = Date.now();
    for (const notification of unread) {
      if (notification.documentId === doc._id) {
        await ctx.db.patch(notification._id, { readAt });
      }
    }
    return true;
  },
});

export const listRecent = query({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    const actor = await caller(ctx, args.clerkOrgId);
    if (!actor) {
      return [];
    }
    const rows = await ctx.db
      .query("recentDocuments")
      .withIndex("by_user_org_time", (q) =>
        q.eq("userId", actor.userId).eq("clerkOrgId", args.clerkOrgId),
      )
      .order("desc")
      .take(32);
    const output = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.documentId)) {
        continue;
      }
      seen.add(row.documentId);
      const [doc, project, access] = await Promise.all([
        ctx.db.get(row.documentId),
        ctx.db.get(row.projectId),
        accessForProject(ctx, row.projectId),
      ]);
      if (
        !doc ||
        !project ||
        !access ||
        doc.kind === "folder" ||
        (await isInactiveTree(ctx, doc))
      ) {
        continue;
      }
      const path = await visiblePath(ctx, doc);
      if (!path) {
        continue;
      }
      output.push({
        id: row._id,
        documentId: doc._id,
        projectId: project._id,
        projectTitle: project.title,
        name: doc.name,
        path,
        kind: doc.kind,
        fileType: doc.fileType,
        lastOpenedAt: row.lastOpenedAt,
      });
      if (output.length === RECENT_LIMIT) break;
    }
    return output;
  },
});
