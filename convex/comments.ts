import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { accessForProject, isInactiveTree, requireProjectEditor } from "./documents";
import { enforceWriteRateLimit } from "./writeRateLimit";

const MAX_ANCHOR_BYTES = 4096;
const MAX_BODY_LENGTH = 2000;
const MAX_QUOTE_LENGTH = 400;
const MAX_SNIPPET_LENGTH = 160;
const UNREAD_SCAN_LIMIT = 60;
const UNREAD_DISPLAY_CAP = 10;
const NOTIFICATION_RETENTION_MS = 60 * 24 * 60 * 60 * 1000;
const PRUNE_BATCH = 200;
const MAX_THREADS_PER_DOCUMENT = 200;
const MAX_MESSAGES_PER_THREAD = 200;
const MARK_READ_BATCH = 200;
const COMMENT_WRITE_LIMIT = { capacity: 20, refillPerSecond: 1 };

type Actor = {
  userId: string;
  name: string;
  email: string | null;
  image: string | null;
};

function trimBody(body: string): string {
  const value = body.trim();
  if (value.length === 0) {
    throw new Error("empty-comment");
  }
  if (value.length > MAX_BODY_LENGTH) {
    throw new Error("comment-too-long");
  }
  return value;
}

function trimQuote(quote: string): string {
  const value = quote.trim();
  if (value.length === 0) {
    throw new Error("empty-selection");
  }
  return value.slice(0, MAX_QUOTE_LENGTH);
}

function assertAnchor(anchor: ArrayBuffer): void {
  if (anchor.byteLength === 0 || anchor.byteLength > MAX_ANCHOR_BYTES) {
    throw new Error("invalid-anchor");
  }
}

function displayName(member: Doc<"members">): string {
  return [member.firstName, member.lastName].filter(Boolean).join(" ").trim() || member.email;
}

async function actorFor(ctx: QueryCtx, userId: string): Promise<Actor> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity || identity.subject !== userId) {
    throw new Error("Unauthenticated");
  }
  return {
    userId,
    name: identity.name ?? identity.email ?? userId,
    email: identity.email ?? null,
    image: identity.pictureUrl ?? null,
  };
}

async function accessibleMemberIds(ctx: QueryCtx, project: Doc<"projects">): Promise<Set<string>> {
  const [members, grants] = await Promise.all([
    ctx.db
      .query("members")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", project.clerkOrgId))
      .collect(),
    ctx.db
      .query("projectAccess")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .collect(),
  ]);
  const grantIds = new Set(grants.map((grant) => grant.userId));
  const ids = new Set<string>();
  for (const member of members) {
    if (
      member.status === "accepted" &&
      member.memberUserId &&
      (member.isOwner || member.role === "org:admin" || grantIds.has(member.memberUserId))
    ) {
      ids.add(member.memberUserId);
    }
  }
  return ids;
}

async function validatedMentionIds(
  ctx: QueryCtx,
  project: Doc<"projects">,
  rawUserIds: string[],
): Promise<string[]> {
  const accessible = await accessibleMemberIds(ctx, project);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const userId of rawUserIds) {
    if (seen.has(userId)) {
      continue;
    }
    if (!accessible.has(userId)) {
      throw new Error("invalid-mention");
    }
    seen.add(userId);
    result.push(userId);
  }
  return result;
}

async function notifyMentions(
  ctx: MutationCtx,
  project: Doc<"projects">,
  documentId: Id<"documents">,
  commentId: Id<"comments">,
  messageId: Id<"commentMessages">,
  actor: Actor,
  quote: string,
  body: string,
  mentionUserIds: string[],
): Promise<void> {
  await notifyRecipients(
    ctx,
    project,
    documentId,
    commentId,
    messageId,
    actor,
    quote,
    body,
    mentionUserIds,
    "mention",
  );
}

async function notifyRecipients(
  ctx: MutationCtx,
  project: Doc<"projects">,
  documentId: Id<"documents">,
  commentId: Id<"comments">,
  messageId: Id<"commentMessages"> | undefined,
  actor: Actor,
  quote: string,
  body: string,
  recipientIds: string[],
  kind: "mention" | "reply" | "resolved" | "reopened",
): Promise<void> {
  const now = Date.now();
  const accessible = await accessibleMemberIds(ctx, project);
  for (const recipientUserId of new Set(recipientIds)) {
    if (recipientUserId === actor.userId) {
      continue;
    }
    if (!accessible.has(recipientUserId)) continue;
    const preference = await ctx.db
      .query("notificationPreferences")
      .withIndex("by_project_user", (q) =>
        q.eq("projectId", project._id).eq("userId", recipientUserId),
      )
      .unique();
    if (preference?.muted) continue;
    await ctx.db.insert("notifications", {
      kind,
      recipientUserId,
      clerkOrgId: project.clerkOrgId,
      projectId: project._id,
      documentId,
      commentId,
      ...(messageId ? { messageId } : {}),
      actorUserId: actor.userId,
      actorName: actor.name,
      quote,
      bodySnippet: body.slice(0, MAX_SNIPPET_LENGTH),
      readAt: null,
      createdAt: now,
    });
  }
}

async function fileForAccess(ctx: MutationCtx, documentId: Id<"documents">) {
  const doc = await ctx.db.get(documentId);
  if (doc?.kind !== "file" || (await isInactiveTree(ctx, doc))) {
    throw new Error("not-found");
  }
  const access = await requireProjectEditor(ctx, doc.projectId);
  return { doc, access };
}

async function visibleNotificationTarget(
  ctx: QueryCtx,
  row: Doc<"notifications">,
  projectAccess: Map<Id<"projects">, boolean>,
) {
  const project = await ctx.db.get(row.projectId);
  const doc = await ctx.db.get(row.documentId);
  const thread = await ctx.db.get(row.commentId);
  const message = row.messageId ? await ctx.db.get(row.messageId) : null;
  let canAccessProject = projectAccess.get(row.projectId);
  if (canAccessProject === undefined) {
    canAccessProject = Boolean(await accessForProject(ctx, row.projectId));
    projectAccess.set(row.projectId, canAccessProject);
  }
  if (
    !project ||
    project.deletedAt ||
    doc?.kind !== "file" ||
    (await isInactiveTree(ctx, doc)) ||
    !thread ||
    thread.documentId !== row.documentId ||
    thread.projectId !== row.projectId ||
    (row.messageId && (!message || message.commentId !== row.commentId)) ||
    !canAccessProject
  ) {
    return null;
  }
  return { project, doc };
}

export const listForDocument = query({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (
      doc?.kind !== "file" ||
      (await isInactiveTree(ctx, doc)) ||
      !(await accessForProject(ctx, doc.projectId))
    ) {
      return [];
    }
    const threads = await ctx.db
      .query("comments")
      .withIndex("by_document_updated", (q) => q.eq("documentId", args.documentId))
      .order("desc")
      .take(MAX_THREADS_PER_DOCUMENT);
    const rows = await Promise.all(
      threads.map(async (thread) => {
        const messages = await ctx.db
          .query("commentMessages")
          .withIndex("by_comment", (q) => q.eq("commentId", thread._id))
          .order("desc")
          .take(MAX_MESSAGES_PER_THREAD);
        return {
          id: thread._id,
          documentId: thread.documentId,
          projectId: thread.projectId,
          startRel: thread.startRel,
          endRel: thread.endRel,
          quote: thread.quote,
          status: thread.status,
          authorUserId: thread.authorUserId,
          authorName: thread.authorName,
          authorEmail: thread.authorEmail,
          authorImage: thread.authorImage,
          resolvedByUserId: thread.resolvedByUserId,
          resolvedByName: thread.resolvedByName,
          resolvedAt: thread.resolvedAt,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          messages: messages
            .sort((a, b) => a.createdAt - b.createdAt)
            .map((message) => ({
              id: message._id,
              body: message.body,
              mentionUserIds: message.mentionUserIds,
              authorUserId: message.authorUserId,
              authorName: message.authorName,
              authorEmail: message.authorEmail,
              authorImage: message.authorImage,
              createdAt: message.createdAt,
            })),
        };
      }),
    );
    return rows.sort((a, b) => b.updatedAt - a.updatedAt);
  },
});

export const mentionCandidates = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const access = await accessForProject(ctx, args.projectId);
    if (!access) {
      return [];
    }
    const accessible = await accessibleMemberIds(ctx, access.project);
    const members = await ctx.db
      .query("members")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", access.project.clerkOrgId))
      .collect();
    return members
      .filter(
        (member) =>
          member.status === "accepted" &&
          member.memberUserId !== null &&
          accessible.has(member.memberUserId),
      )
      .map((member) => ({
        userId: member.memberUserId as string,
        name: displayName(member),
        email: member.email,
        imageUrl: member.imageUrl,
        role: member.role,
        isOwner: member.isOwner,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

export const createThread = mutation({
  args: {
    documentId: v.id("documents"),
    startRel: v.bytes(),
    endRel: v.bytes(),
    quote: v.string(),
    body: v.string(),
    mentionUserIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    assertAnchor(args.startRel);
    assertAnchor(args.endRel);
    const { doc, access } = await fileForAccess(ctx, args.documentId);
    if (
      !(await enforceWriteRateLimit(ctx, "comments", doc._id, access.userId, COMMENT_WRITE_LIMIT))
    ) {
      throw new Error("rate-limited");
    }
    const actor = await actorFor(ctx, access.userId);
    const body = trimBody(args.body);
    const quote = trimQuote(args.quote);
    const mentionUserIds = await validatedMentionIds(ctx, access.project, args.mentionUserIds);
    const now = Date.now();
    const commentId = await ctx.db.insert("comments", {
      documentId: doc._id,
      projectId: doc.projectId,
      clerkOrgId: doc.clerkOrgId,
      startRel: args.startRel,
      endRel: args.endRel,
      quote,
      status: "open",
      authorUserId: actor.userId,
      authorName: actor.name,
      authorEmail: actor.email,
      authorImage: actor.image,
      resolvedByUserId: null,
      resolvedByName: null,
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    const messageId = await ctx.db.insert("commentMessages", {
      commentId,
      documentId: doc._id,
      projectId: doc.projectId,
      clerkOrgId: doc.clerkOrgId,
      body,
      mentionUserIds,
      authorUserId: actor.userId,
      authorName: actor.name,
      authorEmail: actor.email,
      authorImage: actor.image,
      createdAt: now,
    });
    await notifyMentions(
      ctx,
      access.project,
      doc._id,
      commentId,
      messageId,
      actor,
      quote,
      body,
      mentionUserIds,
    );
    return commentId;
  },
});

export const reply = mutation({
  args: {
    commentId: v.id("comments"),
    body: v.string(),
    mentionUserIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.commentId);
    if (!thread) {
      throw new Error("not-found");
    }
    const doc = await ctx.db.get(thread.documentId);
    if (doc?.kind !== "file" || (await isInactiveTree(ctx, doc))) {
      throw new Error("not-found");
    }
    const access = await requireProjectEditor(ctx, thread.projectId);
    if (
      !(await enforceWriteRateLimit(
        ctx,
        "comments",
        thread.documentId,
        access.userId,
        COMMENT_WRITE_LIMIT,
      ))
    ) {
      throw new Error("rate-limited");
    }
    const actor = await actorFor(ctx, access.userId);
    const body = trimBody(args.body);
    const mentionUserIds = await validatedMentionIds(ctx, access.project, args.mentionUserIds);
    const priorMessages = await ctx.db
      .query("commentMessages")
      .withIndex("by_comment", (q) => q.eq("commentId", thread._id))
      .order("desc")
      .take(MAX_MESSAGES_PER_THREAD);
    const now = Date.now();
    const messageId = await ctx.db.insert("commentMessages", {
      commentId: thread._id,
      documentId: thread.documentId,
      projectId: thread.projectId,
      clerkOrgId: thread.clerkOrgId,
      body,
      mentionUserIds,
      authorUserId: actor.userId,
      authorName: actor.name,
      authorEmail: actor.email,
      authorImage: actor.image,
      createdAt: now,
    });
    await ctx.db.patch(thread._id, { updatedAt: now });
    await notifyMentions(
      ctx,
      access.project,
      thread.documentId,
      thread._id,
      messageId,
      actor,
      thread.quote,
      body,
      mentionUserIds,
    );
    const mentioned = new Set(mentionUserIds);
    const participants = [
      thread.authorUserId,
      ...priorMessages.map((message) => message.authorUserId),
    ].filter((userId) => !mentioned.has(userId));
    await notifyRecipients(
      ctx,
      access.project,
      thread.documentId,
      thread._id,
      messageId,
      actor,
      thread.quote,
      body,
      participants,
      "reply",
    );
    return messageId;
  },
});

export const setResolved = mutation({
  args: { commentId: v.id("comments"), resolved: v.boolean() },
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.commentId);
    if (!thread) {
      throw new Error("not-found");
    }
    const doc = await ctx.db.get(thread.documentId);
    if (doc?.kind !== "file" || (await isInactiveTree(ctx, doc))) {
      throw new Error("not-found");
    }
    const access = await requireProjectEditor(ctx, thread.projectId);
    if (
      !(await enforceWriteRateLimit(
        ctx,
        "comments",
        thread.documentId,
        access.userId,
        COMMENT_WRITE_LIMIT,
      ))
    ) {
      throw new Error("rate-limited");
    }
    const actor = await actorFor(ctx, access.userId);
    if ((thread.status === "resolved") === args.resolved) return;
    const messages = await ctx.db
      .query("commentMessages")
      .withIndex("by_comment", (q) => q.eq("commentId", thread._id))
      .order("desc")
      .take(MAX_MESSAGES_PER_THREAD);
    await ctx.db.patch(thread._id, {
      status: args.resolved ? "resolved" : "open",
      resolvedByUserId: args.resolved ? actor.userId : null,
      resolvedByName: args.resolved ? actor.name : null,
      resolvedAt: args.resolved ? Date.now() : null,
      updatedAt: Date.now(),
    });
    await notifyRecipients(
      ctx,
      access.project,
      thread.documentId,
      thread._id,
      undefined,
      actor,
      thread.quote,
      args.resolved ? "Thread resolved" : "Thread reopened",
      [thread.authorUserId, ...messages.map((message) => message.authorUserId)],
      args.resolved ? "resolved" : "reopened",
    );
  },
});

export const unreadCount = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity?.org_id) {
      return 0;
    }
    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_recipient_org_read", (q) =>
        q
          .eq("recipientUserId", identity.subject)
          .eq("clerkOrgId", identity.org_id as string)
          .eq("readAt", null),
      )
      .order("desc")
      .take(UNREAD_SCAN_LIMIT);
    let count = 0;
    const projectAccess = new Map<Id<"projects">, boolean>();
    for (const row of rows) {
      if (await visibleNotificationTarget(ctx, row, projectAccess)) {
        count += 1;
      }
      if (count >= UNREAD_DISPLAY_CAP) {
        break;
      }
    }
    return count;
  },
});

export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity?.org_id) {
      return [];
    }
    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_recipient_org", (q) =>
        q.eq("recipientUserId", identity.subject).eq("clerkOrgId", identity.org_id as string),
      )
      .order("desc")
      .take(40);
    const visible = [];
    const projectAccess = new Map<Id<"projects">, boolean>();
    for (const row of rows) {
      const target = await visibleNotificationTarget(ctx, row, projectAccess);
      if (!target) {
        continue;
      }
      visible.push({
        id: row._id,
        projectId: row.projectId,
        documentId: row.documentId,
        commentId: row.commentId,
        kind: row.kind ?? "mention",
        actorName: row.actorName,
        quote: row.quote,
        bodySnippet: row.bodySnippet,
        readAt: row.readAt,
        createdAt: row.createdAt,
        projectTitle: target.project.title,
        documentName: target.doc.name,
      });
      if (visible.length >= 20) {
        break;
      }
    }
    return visible;
  },
});

export const markRead = mutation({
  args: { notificationId: v.id("notifications") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    const notification = await ctx.db.get(args.notificationId);
    if (
      !identity ||
      !notification ||
      notification.recipientUserId !== identity.subject ||
      notification.clerkOrgId !== identity.org_id
    ) {
      return;
    }
    if (notification.readAt === null) {
      await ctx.db.patch(notification._id, { readAt: Date.now() });
    }
  },
});

export const markAllRead = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity?.org_id) {
      return;
    }
    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_recipient_org_read", (q) =>
        q
          .eq("recipientUserId", identity.subject)
          .eq("clerkOrgId", identity.org_id as string)
          .eq("readAt", null),
      )
      .take(MARK_READ_BATCH);
    const now = Date.now();
    for (const row of rows) {
      await ctx.db.patch(row._id, { readAt: now });
    }
    if (rows.length === MARK_READ_BATCH) {
      await ctx.scheduler.runAfter(0, internal.comments.markAllReadBatch, {
        recipientUserId: identity.subject,
        clerkOrgId: identity.org_id as string,
      });
    }
  },
});

export const markAllReadBatch = internalMutation({
  args: { recipientUserId: v.string(), clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_recipient_org_read", (q) =>
        q
          .eq("recipientUserId", args.recipientUserId)
          .eq("clerkOrgId", args.clerkOrgId)
          .eq("readAt", null),
      )
      .take(MARK_READ_BATCH);
    const now = Date.now();
    for (const row of rows) {
      await ctx.db.patch(row._id, { readAt: now });
    }
    if (rows.length === MARK_READ_BATCH) {
      await ctx.scheduler.runAfter(0, internal.comments.markAllReadBatch, args);
    }
  },
});

export const pruneNotifications = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - NOTIFICATION_RETENTION_MS;
    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_created", (q) => q.lt("createdAt", cutoff))
      .take(PRUNE_BATCH);
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
    if (rows.length === PRUNE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.comments.pruneNotifications, {});
    }
  },
});
