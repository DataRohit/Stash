import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { accessForProject, isInactiveTree } from "./documents";

const RECENT_LIMIT = 8;
const PALETTE_LIMIT = 16;
const PAGE_LIMIT = 60;
const CONTENT_LIMIT = 8;
const MAX_QUERY_LENGTH = 120;

type SearchResult = {
  id: string;
  projectId: Id<"projects">;
  projectTitle: string;
  documentId: Id<"documents"> | null;
  kind: "project" | "file" | "folder" | "asset" | "content";
  name: string;
  path: string;
  fileType: "md" | "html" | "doc" | null;
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

function pathsFor(docs: Doc<"documents">[]) {
  const byId = new Map(docs.map((doc) => [doc._id, doc]));
  const path = (doc: Doc<"documents">) => {
    const parts = [doc.name];
    let parent = doc.parentId ? byId.get(doc.parentId) : undefined;
    const seen = new Set<Id<"documents">>();
    while (parent && !seen.has(parent._id)) {
      seen.add(parent._id);
      parts.unshift(parent.name);
      parent = parent.parentId ? byId.get(parent.parentId) : undefined;
    }
    return `/${parts.join("/")}`;
  };
  return { byId, path };
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
    const { projects } = await accessibleProjects(ctx, args.clerkOrgId);
    const needle = term.toLowerCase();
    const results: SearchResult[] = [];
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
      const docs = await ctx.db
        .query("documents")
        .withIndex("by_project", (q) => q.eq("projectId", project._id))
        .collect();
      const byIdAll = new Map(docs.map((doc) => [doc._id, doc]));
      const inactive = (doc: Doc<"documents">) => {
        let current: Doc<"documents"> | undefined = doc;
        const seen = new Set<Id<"documents">>();
        while (current && !seen.has(current._id)) {
          seen.add(current._id);
          if (current.deletingAt || current.trashedAt) return true;
          current = current.parentId ? byIdAll.get(current.parentId) : undefined;
        }
        return false;
      };
      const visible = docs.filter((doc) => !inactive(doc));
      const { path } = pathsFor(visible);
      for (const doc of visible) {
        const fullPath = path(doc);
        const name = doc.name.toLowerCase();
        if (name.includes(needle) || fullPath.toLowerCase().includes(needle)) {
          results.push({
            id: `node:${doc._id}`,
            projectId: project._id,
            projectTitle: project.title,
            documentId: doc._id,
            kind: doc.kind,
            name: doc.name,
            path: fullPath,
            fileType: doc.fileType,
            snippet: null,
            rank: name === needle ? 0 : name.startsWith(needle) ? 1 : 3,
          });
        }
      }
      const hits = await ctx.db
        .query("documents")
        .withSearchIndex("search_content", (q) =>
          q.search("content", term).eq("projectId", project._id).eq("kind", "file"),
        )
        .take(PAGE_LIMIT);
      const exactHits = hits.slice(0, CONTENT_LIMIT);
      for (const [index, doc] of exactHits.entries()) {
        if (inactive(doc)) {
          continue;
        }
        const existing = results.find((result) => result.documentId === doc._id);
        if (existing) {
          existing.snippet = snippet(doc.content, term);
          continue;
        }
        results.push({
          id: `content:${doc._id}`,
          projectId: project._id,
          projectTitle: project.title,
          documentId: doc._id,
          kind: "content",
          name: doc.name,
          path: path(doc),
          fileType: doc.fileType,
          snippet: snippet(doc.content, term),
          rank: 10 + index,
        });
      }
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
      .collect();
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
      const docs = await ctx.db
        .query("documents")
        .withIndex("by_project", (q) => q.eq("projectId", row.projectId))
        .collect();
      output.push({
        id: row._id,
        documentId: doc._id,
        projectId: project._id,
        projectTitle: project.title,
        name: doc.name,
        path: pathsFor(docs).path(doc),
        kind: doc.kind,
        fileType: doc.fileType,
        lastOpenedAt: row.lastOpenedAt,
      });
      if (output.length === RECENT_LIMIT) break;
    }
    return output;
  },
});
