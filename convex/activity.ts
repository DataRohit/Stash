import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { recordOrganizationEvent } from "./audit";
import { accessForProject, isInactiveTree, requireProjectAccess } from "./documents";

export type ProjectEventKind =
  | "node_created"
  | "documents_imported"
  | "document_duplicated"
  | "node_renamed"
  | "node_moved"
  | "node_trashed"
  | "node_restored"
  | "node_deleted"
  | "checkpoint_created"
  | "checkpoint_deleted"
  | "checkpoint_restored"
  | "share_changed"
  | "access_granted"
  | "access_revoked";

const RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const PRUNE_BATCH = 200;

export async function recordProjectEvent(
  ctx: MutationCtx,
  value: {
    projectId: Id<"projects">;
    clerkOrgId: string;
    kind: ProjectEventKind;
    actorUserId?: string;
    actorName?: string;
    documentId?: Id<"documents">;
    memberUserId?: string;
    checkpointId?: Id<"yjsSnapshots">;
    targetName: string;
    detail?: string;
    previousValue?: string;
    nextValue?: string;
  },
) {
  const identity = await ctx.auth.getUserIdentity();
  const actorUserId = value.actorUserId ?? identity?.subject;
  if (!actorUserId) throw new Error("Unauthenticated");
  const actorName = value.actorName ?? identity?.name ?? identity?.email ?? actorUserId;
  await ctx.db.insert("projectEvents", {
    ...value,
    actorUserId,
    actorName,
    createdAt: Date.now(),
  });
  const project = await ctx.db.get(value.projectId);
  const kind =
    value.kind === "node_created" && value.detail !== "folder"
      ? "document.created"
      : `project.${value.kind}`;
  await recordOrganizationEvent(ctx, {
    clerkOrgId: value.clerkOrgId,
    actorUserId,
    actorName,
    kind,
    projectId: value.projectId,
    projectName: project?.title,
    targetId: value.documentId ?? value.memberUserId ?? value.checkpointId,
    targetName: value.targetName,
    metadata: value.detail
      ? JSON.stringify({
          detail: value.detail,
          previousValue: value.previousValue,
          nextValue: value.nextValue,
        })
      : undefined,
  });
}

export const listProjectEvents = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const access = await accessForProject(ctx, args.projectId);
    if (!access) return [];
    const rows = await ctx.db
      .query("projectEvents")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(50);
    const members = await ctx.db
      .query("members")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", access.project.clerkOrgId))
      .collect();
    const emailByUser = new Map<string, string>();
    for (const member of members) {
      if (member.memberUserId) emailByUser.set(member.memberUserId, member.email);
    }
    return await Promise.all(
      rows.map(async (row) => {
        const doc = row.documentId ? await ctx.db.get(row.documentId) : null;
        const documentActive = Boolean(doc && !(await isInactiveTree(ctx, doc)));
        return {
          id: row._id,
          kind: row.kind,
          actorName: row.actorName,
          actorEmail: emailByUser.get(row.actorUserId) ?? null,
          targetName: row.targetName,
          targetEmail: row.memberUserId ? (emailByUser.get(row.memberUserId) ?? null) : null,
          detail: row.detail ?? null,
          previousValue: row.previousValue ?? null,
          nextValue: row.nextValue ?? null,
          documentId: documentActive ? (row.documentId ?? null) : null,
          createdAt: row.createdAt,
        };
      }),
    );
  },
});

export const getPreference = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const access = await accessForProject(ctx, args.projectId);
    if (!access) return null;
    const row = await ctx.db
      .query("notificationPreferences")
      .withIndex("by_project_user", (q) =>
        q.eq("projectId", args.projectId).eq("userId", access.userId),
      )
      .unique();
    return { muted: row?.muted ?? false };
  },
});

export const setMuted = mutation({
  args: { projectId: v.id("projects"), muted: v.boolean() },
  handler: async (ctx, args) => {
    const access = await requireProjectAccess(ctx, args.projectId);
    const row = await ctx.db
      .query("notificationPreferences")
      .withIndex("by_project_user", (q) =>
        q.eq("projectId", args.projectId).eq("userId", access.userId),
      )
      .unique();
    const value = {
      clerkOrgId: access.project.clerkOrgId,
      projectId: args.projectId,
      userId: access.userId,
      muted: args.muted,
      updatedAt: Date.now(),
    };
    if (row) await ctx.db.patch(row._id, value);
    else await ctx.db.insert("notificationPreferences", value);
    return { muted: args.muted };
  },
});

export const pruneProjectEvents = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("projectEvents")
      .withIndex("by_created", (q) => q.lt("createdAt", Date.now() - RETENTION_MS))
      .take(PRUNE_BATCH);
    for (const row of rows) await ctx.db.delete(row._id);
    if (rows.length === PRUNE_BATCH)
      await ctx.scheduler.runAfter(0, internal.activity.pruneProjectEvents, {});
  },
});
