import { v } from "convex/values";
import { zipSync } from "fflate";
import { api, internal } from "./_generated/api";
import { internalAction, internalMutation, mutation, query } from "./_generated/server";
import { recordOrganizationEvent } from "./audit";

const MAX_PROJECTS = 500;
const MAX_PROJECT_EXPORT_BYTES = 200 * 1024 * 1024;
const EXPORT_TTL_MS = 24 * 60 * 60 * 1_000;

type BundleNode = {
  id: string;
  parentId: string | null;
  kind: "folder" | "file" | "asset";
  name: string;
  fileType: string | null;
  content: string;
  assetUrl: string | null;
};

function safeName(value: string): string {
  return (
    [...value]
      .map((character) =>
        character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character) ? "-" : character,
      )
      .join("")
      .trim()
      .slice(0, 120) || "Untitled"
  );
}

function nodePath(node: BundleNode, byId: Map<string, BundleNode>): string {
  const parts = [];
  const seen = new Set<string>();
  let current: BundleNode | undefined = node;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    parts.unshift(safeName(current.name));
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return parts.join("/");
}

function exportedPath(node: BundleNode, path: string): string {
  if (node.fileType === "sheet") return path.replace(/\.sheet$/i, ".csv");
  if (node.fileType === "board") return path.replace(/\.board$/i, ".md");
  if (node.fileType === "view") return path.replace(/\.view$/i, ".json");
  if (node.fileType === "chart") return path.replace(/\.chart$/i, ".svg");
  if (node.fileType === "dashboard") return path.replace(/\.dashboard$/i, ".json");
  return path;
}

function uniquePath(path: string, used: Set<string>): string {
  if (!used.has(path.toLowerCase())) {
    used.add(path.toLowerCase());
    return path;
  }
  const slash = path.lastIndexOf("/");
  const directory = slash >= 0 ? path.slice(0, slash + 1) : "";
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  for (let suffix = 2; suffix <= 10_000; suffix += 1) {
    const candidate = `${directory}${stem} (${suffix})${extension}`;
    if (!used.has(candidate.toLowerCase())) {
      used.add(candidate.toLowerCase());
      return candidate;
    }
  }
  throw new Error("too-many-name-collisions");
}

export const request = mutation({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || identity.org_id !== args.clerkOrgId || identity.org_role !== "org:admin") {
      throw new Error("Forbidden");
    }
    const running = await ctx.db
      .query("organizationExports")
      .withIndex("by_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .order("desc")
      .take(10);
    if (running.some((job) => job.state === "queued" || job.state === "running")) {
      throw new Error("export-already-running");
    }
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .take(MAX_PROJECTS + 1);
    const ids = projects.filter((project) => !project.deletedAt).map((project) => project._id);
    if (ids.length > MAX_PROJECTS) throw new Error("too-many-projects");
    const now = Date.now();
    const id = await ctx.db.insert("organizationExports", {
      clerkOrgId: args.clerkOrgId,
      state: "queued",
      projectIds: ids,
      completedProjectIds: [],
      files: [],
      createdBy: identity.subject,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.organizationExports.run, { jobId: id });
    return id;
  },
});

export const claim = internalMutation({
  args: { jobId: v.id("organizationExports") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || !["queued", "running"].includes(job.state)) return null;
    const projectId = job.projectIds.find((id) => !job.completedProjectIds.includes(id));
    await ctx.db.patch(job._id, { state: "running", updatedAt: Date.now() });
    return { job, projectId: projectId ?? null };
  },
});

export const recordProject = internalMutation({
  args: {
    jobId: v.id("organizationExports"),
    projectId: v.id("projects"),
    name: v.string(),
    storageId: v.id("_storage"),
    size: v.number(),
    capturedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (job?.state !== "running") return;
    await ctx.db.patch(job._id, {
      completedProjectIds: [...new Set([...job.completedProjectIds, args.projectId])],
      files: [
        ...(job.files ?? []),
        {
          projectId: args.projectId,
          name: args.name,
          storageId: args.storageId,
          size: args.size,
          capturedAt: args.capturedAt,
        },
      ],
      updatedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.organizationExports.run, { jobId: job._id });
  },
});

export const complete = internalMutation({
  args: {
    jobId: v.id("organizationExports"),
    manifest: v.string(),
    manifestStorageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (job?.state !== "running") return;
    const now = Date.now();
    await ctx.db.patch(job._id, {
      state: "completed",
      manifest: args.manifest,
      manifestStorageId: args.manifestStorageId,
      expiresAt: now + EXPORT_TTL_MS,
      updatedAt: now,
    });
    await recordOrganizationEvent(ctx, {
      clerkOrgId: job.clerkOrgId,
      actorUserId: job.createdBy,
      actorName: job.createdBy,
      kind: "organization_export.completed",
      targetId: job._id,
      targetName: "Organization export",
      metadata: JSON.stringify({ projects: job.projectIds.length }),
    });
  },
});

export const fail = internalMutation({
  args: { jobId: v.id("organizationExports"), error: v.string() },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return;
    for (const file of job.files ?? []) await ctx.storage.delete(file.storageId);
    if (job.manifestStorageId) await ctx.storage.delete(job.manifestStorageId);
    await ctx.db.patch(job._id, {
      state: "failed",
      completedProjectIds: [],
      files: [],
      manifestStorageId: undefined,
      error: args.error.slice(0, 500),
      expiresAt: Date.now() + EXPORT_TTL_MS,
      updatedAt: Date.now(),
    });
  },
});

export const run = internalAction({
  args: { jobId: v.id("organizationExports") },
  handler: async (ctx, args) => {
    const claimed = await ctx.runMutation(internal.organizationExports.claim, args);
    if (!claimed) return;
    const secret = process.env.CONVEX_PURGE_SECRET;
    if (!secret) {
      await ctx.runMutation(internal.organizationExports.fail, {
        jobId: args.jobId,
        error: "export-unconfigured",
      });
      return;
    }
    if (!claimed.projectId) {
      const manifest = JSON.stringify(
        {
          organizationId: claimed.job.clerkOrgId,
          capturedAt: new Date().toISOString(),
          projects: (claimed.job.files ?? []).map((file) => ({
            projectId: file.projectId,
            file: file.name,
            size: file.size,
            capturedAt: new Date(file.capturedAt).toISOString(),
          })),
        },
        null,
        2,
      );
      const storageId = await ctx.storage.store(new Blob([manifest], { type: "application/json" }));
      await ctx.runMutation(internal.organizationExports.complete, {
        jobId: args.jobId,
        manifest,
        manifestStorageId: storageId,
      });
      return;
    }
    try {
      const nodes: BundleNode[] = [];
      let cursor: string | undefined;
      let title = "Project";
      let projectVersion: string | undefined;
      do {
        const page = await ctx.runQuery(api.documents.exportBundle, {
          projectId: claimed.projectId,
          cursor,
          secret,
          clerkOrgId: claimed.job.clerkOrgId,
        });
        if (!page) throw new Error("project-unavailable");
        if (projectVersion && projectVersion !== page.projectVersion) {
          throw new Error("project-changed-during-export");
        }
        projectVersion = page.projectVersion;
        title = page.projectTitle;
        nodes.push(...(page.nodes as BundleNode[]));
        cursor = page.cursor ?? undefined;
      } while (cursor);
      const byId = new Map(nodes.map((node) => [node.id, node]));
      const encoder = new TextEncoder();
      const entries: Record<string, Uint8Array> = {};
      const usedPaths = new Set<string>();
      let expandedBytes = 0;
      for (const node of nodes) {
        const path = nodePath(node, byId);
        if (!path || node.kind === "folder") continue;
        if (node.kind === "file") {
          const value = encoder.encode(node.content);
          expandedBytes += value.byteLength;
          if (expandedBytes > MAX_PROJECT_EXPORT_BYTES) throw new Error("project-export-too-large");
          entries[uniquePath(exportedPath(node, path), usedPaths)] = value;
        } else if (node.assetUrl) {
          const response = await fetch(node.assetUrl, { redirect: "error" });
          if (!response.ok) throw new Error("asset-fetch-failed");
          const declaredSize = Number(response.headers.get("content-length") ?? 0);
          if (declaredSize > MAX_PROJECT_EXPORT_BYTES - expandedBytes) {
            throw new Error("project-export-too-large");
          }
          const value = new Uint8Array(await response.arrayBuffer());
          expandedBytes += value.byteLength;
          if (expandedBytes > MAX_PROJECT_EXPORT_BYTES) throw new Error("project-export-too-large");
          entries[uniquePath(path, usedPaths)] = value;
        }
      }
      const verification = await ctx.runQuery(api.documents.exportBundle, {
        projectId: claimed.projectId,
        secret,
        clerkOrgId: claimed.job.clerkOrgId,
      });
      if (!verification || verification.projectVersion !== projectVersion) {
        throw new Error("project-changed-during-export");
      }
      const bytes = zipSync(entries, { level: 6 });
      const capturedAt = Date.now();
      const name = `${safeName(title)}-${claimed.projectId}.zip`;
      const storageId = await ctx.storage.store(new Blob([bytes], { type: "application/zip" }));
      await ctx.runMutation(internal.organizationExports.recordProject, {
        jobId: args.jobId,
        projectId: claimed.projectId,
        name,
        storageId,
        size: bytes.length,
        capturedAt,
      });
    } catch (error) {
      await ctx.runMutation(internal.organizationExports.fail, {
        jobId: args.jobId,
        error: error instanceof Error ? error.message : "export-failed",
      });
    }
  },
});

export const list = query({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || identity.org_id !== args.clerkOrgId || identity.org_role !== "org:admin")
      throw new Error("Forbidden");
    return (
      await ctx.db
        .query("organizationExports")
        .withIndex("by_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
        .order("desc")
        .take(10)
    ).map((job) => ({
      id: job._id,
      state: job.state,
      projectCount: job.projectIds.length,
      completedCount: job.completedProjectIds.length,
      files: (job.files ?? []).map((file) => ({
        projectId: file.projectId,
        name: file.name,
        size: file.size,
        capturedAt: file.capturedAt,
      })),
      hasManifest: Boolean(job.manifestStorageId),
      error: job.error,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      expiresAt: job.expiresAt,
    }));
  },
});

export const downloadUrl = query({
  args: { clerkOrgId: v.string(), jobId: v.id("organizationExports"), fileName: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || identity.org_id !== args.clerkOrgId || identity.org_role !== "org:admin")
      throw new Error("Forbidden");
    const job = await ctx.db.get(args.jobId);
    if (
      !job ||
      job.clerkOrgId !== args.clerkOrgId ||
      job.state !== "completed" ||
      !job.expiresAt ||
      job.expiresAt <= Date.now()
    )
      return null;
    const storageId =
      args.fileName === "manifest.json"
        ? job.manifestStorageId
        : job.files?.find((file) => file.name === args.fileName)?.storageId;
    return storageId ? await ctx.storage.getUrl(storageId) : null;
  },
});

export const pruneExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("organizationExports")
      .filter((q) =>
        q.and(q.neq(q.field("expiresAt"), undefined), q.lte(q.field("expiresAt"), Date.now())),
      )
      .take(20);
    for (const job of rows) {
      for (const file of job.files ?? []) await ctx.storage.delete(file.storageId);
      if (job.manifestStorageId) await ctx.storage.delete(job.manifestStorageId);
      await ctx.db.delete(job._id);
    }
  },
});
