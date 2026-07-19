import { v } from "convex/values";
import * as Y from "yjs";
import { inspectBoard } from "../lib/board-model";
import {
  columnLabel,
  displayedCellValue,
  getSheetRoots,
  inspectSheet,
  readCell,
} from "../lib/sheet-model";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { recordOrganizationEvent } from "./audit";
import { organizationId, organizationRole } from "./auth";
import { accessForProject, documentState, isInactiveTree, requireProjectEditor } from "./documents";
import { ensureAutoWatch } from "./watchHelpers";
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
const MAX_MESSAGES_PER_THREAD = 40;
const MAX_LOADED_MESSAGES_PER_THREAD = 200;
const MARK_READ_BATCH = 200;
const COMMENT_WRITE_LIMIT = { capacity: 20, refillPerSecond: 1 };
const WATCH_NOTIFICATION_COLLAPSE_MS = 5 * 60 * 1000;

type Actor = {
  userId: string;
  name: string;
  email: string | null;
  image: string | null;
  role: string;
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
    role: organizationRole(identity) ?? "org:member",
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
  kind: "mention" | "reply" | "resolved" | "reopened" | "watching",
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
    if (kind === "watching" || kind === "reply") {
      const recent = await ctx.db
        .query("notifications")
        .withIndex("by_recipient_org", (q) =>
          q.eq("recipientUserId", recipientUserId).eq("clerkOrgId", project.clerkOrgId),
        )
        .order("desc")
        .take(12);
      const collapsed = recent.find(
        (row) =>
          row.kind === kind &&
          row.documentId === documentId &&
          row.actorUserId === actor.userId &&
          row.readAt === null &&
          now - row.createdAt <= WATCH_NOTIFICATION_COLLAPSE_MS,
      );
      if (collapsed) {
        await ctx.db.patch(collapsed._id, {
          commentId,
          ...(messageId ? { messageId } : {}),
          quote,
          bodySnippet: body.slice(0, MAX_SNIPPET_LENGTH),
          createdAt: now,
        });
        continue;
      }
    }
    const notificationId = await ctx.db.insert("notifications", {
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
    await ctx.scheduler.runAfter(2 * 60 * 1000, internal.email.sendNotification, {
      notificationId,
      attempt: 0,
    });
  }
}

async function watcherIds(ctx: QueryCtx, documentId: Id<"documents">): Promise<string[]> {
  const rows = await ctx.db
    .query("documentWatches")
    .withIndex("by_document", (q) => q.eq("documentId", documentId))
    .collect();
  return rows.map((row) => row.userId);
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
  const thread = row.commentId ? await ctx.db.get(row.commentId) : null;
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
    (row.kind !== "document-mention" &&
      (!thread || thread.documentId !== row.documentId || thread.projectId !== row.projectId)) ||
    (row.messageId && (!message || message.commentId !== row.commentId)) ||
    !canAccessProject
  ) {
    return null;
  }
  return { project, doc, thread };
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
    let activeRows: Set<string> | null = null;
    let activeCols: Set<string> | null = null;
    let activeCards: Set<string> | null = null;
    const state = await documentState(ctx, doc);
    if (doc.fileType === "sheet" && state) {
      try {
        const ydoc = new Y.Doc();
        Y.applyUpdate(ydoc, new Uint8Array(state));
        const inspection = inspectSheet(ydoc);
        activeRows = inspection.rowSet;
        activeCols = inspection.colSet;
        ydoc.destroy();
      } catch {
        activeRows = new Set();
        activeCols = new Set();
      }
    }
    if (doc.fileType === "board" && state) {
      try {
        const ydoc = new Y.Doc();
        Y.applyUpdate(ydoc, new Uint8Array(state));
        activeCards = new Set(inspectBoard(ydoc).cards.keys());
        ydoc.destroy();
      } catch {
        activeCards = new Set();
      }
    }
    const rows = await Promise.all(
      threads.map(async (thread) => {
        const messages = await ctx.db
          .query("commentMessages")
          .withIndex("by_comment", (q) => q.eq("commentId", thread._id))
          .order("desc")
          .take(MAX_MESSAGES_PER_THREAD + 1);
        return {
          id: thread._id,
          documentId: thread.documentId,
          projectId: thread.projectId,
          anchor:
            thread.anchorKind === "document"
              ? { kind: "document" as const }
              : thread.anchorKind === "cell"
                ? {
                    kind: "cell" as const,
                    rowId: thread.rowId ?? "",
                    colId: thread.colId ?? "",
                  }
                : thread.anchorKind === "card"
                  ? { kind: "card" as const, cardId: thread.cardId ?? "" }
                  : {
                      kind: "text" as const,
                      startRel: thread.startRel ?? new ArrayBuffer(0),
                      endRel: thread.endRel ?? new ArrayBuffer(0),
                    },
          orphaned:
            (thread.anchorKind === "cell" &&
              (!thread.rowId ||
                !thread.colId ||
                !activeRows?.has(thread.rowId) ||
                !activeCols?.has(thread.colId))) ||
            (thread.anchorKind === "card" && (!thread.cardId || !activeCards?.has(thread.cardId))),
          quote: thread.quote,
          status: thread.status,
          authorUserId: thread.authorUserId,
          authorName: thread.authorName,
          authorEmail: thread.authorEmail,
          authorImage: thread.authorImage,
          authorRole: thread.authorRole ?? "org:member",
          resolvedByUserId: thread.resolvedByUserId,
          resolvedByName: thread.resolvedByName,
          resolvedAt: thread.resolvedAt,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          hasMoreMessages: messages.length > MAX_MESSAGES_PER_THREAD,
          messages: messages
            .slice(0, MAX_MESSAGES_PER_THREAD)
            .sort((a, b) => a.createdAt - b.createdAt)
            .map((message) => ({
              id: message._id,
              body: message.body,
              mentionUserIds: message.mentionUserIds,
              authorUserId: message.authorUserId,
              authorName: message.authorName,
              authorEmail: message.authorEmail,
              authorImage: message.authorImage,
              authorRole: message.authorRole ?? "org:member",
              createdAt: message.createdAt,
            })),
        };
      }),
    );
    return rows.sort((a, b) => b.updatedAt - a.updatedAt);
  },
});

export const listThreadMessages = query({
  args: { commentId: v.id("comments") },
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.commentId);
    const doc = thread ? await ctx.db.get(thread.documentId) : null;
    if (
      !thread ||
      doc?.kind !== "file" ||
      (await isInactiveTree(ctx, doc)) ||
      !(await accessForProject(ctx, thread.projectId))
    ) {
      return null;
    }
    const messages = await ctx.db
      .query("commentMessages")
      .withIndex("by_comment", (q) => q.eq("commentId", thread._id))
      .order("desc")
      .take(MAX_LOADED_MESSAGES_PER_THREAD + 1);
    return {
      hasMore: messages.length > MAX_LOADED_MESSAGES_PER_THREAD,
      messages: messages
        .slice(0, MAX_LOADED_MESSAGES_PER_THREAD)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((message) => ({
          id: message._id,
          body: message.body,
          mentionUserIds: message.mentionUserIds,
          authorUserId: message.authorUserId,
          authorName: message.authorName,
          authorEmail: message.authorEmail,
          authorImage: message.authorImage,
          authorRole: message.authorRole ?? "org:member",
          createdAt: message.createdAt,
        })),
    };
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

export const documentMentionCandidates = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const access = await accessForProject(ctx, args.projectId);
    if (!access) return [];
    const accessible = await accessibleMemberIds(ctx, access.project);
    const members = await ctx.db
      .query("members")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", access.project.clerkOrgId))
      .collect();
    return members
      .filter((member) => member.status === "accepted" && member.memberUserId !== null)
      .map((member) => ({
        userId: member.memberUserId as string,
        name: displayName(member),
        email: member.email,
        imageUrl: member.imageUrl,
        role: member.role,
        hasAccess: accessible.has(member.memberUserId as string),
      }))
      .sort(
        (left, right) =>
          Number(right.hasAccess) - Number(left.hasAccess) || left.name.localeCompare(right.name),
      );
  },
});

export const createThread = mutation({
  args: {
    documentId: v.id("documents"),
    anchor: v.union(
      v.object({ kind: v.literal("text"), startRel: v.bytes(), endRel: v.bytes() }),
      v.object({ kind: v.literal("cell"), rowId: v.string(), colId: v.string() }),
      v.object({ kind: v.literal("card"), cardId: v.string() }),
      v.object({ kind: v.literal("document") }),
    ),
    quote: v.string(),
    body: v.string(),
    mentionUserIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const { doc, access } = await fileForAccess(ctx, args.documentId);
    const state = await documentState(ctx, doc);
    if (args.anchor.kind === "text") {
      if (
        doc.fileType === "sheet" ||
        doc.fileType === "board" ||
        doc.fileType === "view" ||
        doc.fileType === "chart" ||
        doc.fileType === "dashboard"
      ) {
        throw new Error("invalid-anchor");
      }
      assertAnchor(args.anchor.startRel);
      assertAnchor(args.anchor.endRel);
    } else if (args.anchor.kind === "cell" && (doc.fileType !== "sheet" || !state)) {
      throw new Error("invalid-anchor");
    } else if (args.anchor.kind === "card" && (doc.fileType !== "board" || !state)) {
      throw new Error("invalid-anchor");
    } else if (
      args.anchor.kind === "document" &&
      doc.fileType !== "view" &&
      doc.fileType !== "chart" &&
      doc.fileType !== "dashboard"
    ) {
      throw new Error("invalid-anchor");
    }
    if (
      !(await enforceWriteRateLimit(ctx, "comments", doc._id, access.userId, COMMENT_WRITE_LIMIT))
    ) {
      throw new Error("rate-limited");
    }
    const actor = await actorFor(ctx, access.userId);
    const body = trimBody(args.body);
    let quote = "";
    if (args.anchor.kind === "text") {
      quote = trimQuote(args.quote);
    } else if (args.anchor.kind === "cell") {
      try {
        const ydoc = new Y.Doc();
        Y.applyUpdate(ydoc, new Uint8Array(state as ArrayBuffer));
        const inspection = inspectSheet(ydoc);
        const rowIndex = inspection.rows.indexOf(args.anchor.rowId);
        const colIndex = inspection.cols.indexOf(args.anchor.colId);
        if (rowIndex < 0 || colIndex < 0) throw new Error("invalid-anchor");
        quote =
          displayedCellValue(readCell(getSheetRoots(ydoc), args.anchor.rowId, args.anchor.colId)) ||
          `${columnLabel(colIndex)}${rowIndex + 1}`;
        ydoc.destroy();
      } catch {
        throw new Error("invalid-anchor");
      }
    } else if (args.anchor.kind === "card") {
      try {
        const ydoc = new Y.Doc();
        Y.applyUpdate(ydoc, new Uint8Array(state as ArrayBuffer));
        const inspection = inspectBoard(ydoc);
        const card = inspection.cards.get(args.anchor.cardId);
        if (!card) throw new Error("invalid-anchor");
        quote = trimQuote(card.title);
        ydoc.destroy();
      } catch {
        throw new Error("invalid-anchor");
      }
    } else {
      quote = trimQuote(doc.name);
    }
    const mentionUserIds = await validatedMentionIds(ctx, access.project, args.mentionUserIds);
    const now = Date.now();
    const commentId = await ctx.db.insert("comments", {
      documentId: doc._id,
      projectId: doc.projectId,
      clerkOrgId: doc.clerkOrgId,
      anchorKind: args.anchor.kind,
      ...(args.anchor.kind === "text"
        ? { startRel: args.anchor.startRel, endRel: args.anchor.endRel }
        : args.anchor.kind === "cell"
          ? { rowId: args.anchor.rowId, colId: args.anchor.colId }
          : args.anchor.kind === "card"
            ? { cardId: args.anchor.cardId }
            : {}),
      quote,
      status: "open",
      authorUserId: actor.userId,
      authorName: actor.name,
      authorEmail: actor.email,
      authorImage: actor.image,
      authorRole: actor.role,
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
      authorRole: actor.role,
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
    await ensureAutoWatch(ctx, {
      clerkOrgId: access.project.clerkOrgId,
      userId: actor.userId,
      projectId: doc.projectId,
      documentId: doc._id,
    });
    const mentioned = new Set(mentionUserIds);
    await notifyRecipients(
      ctx,
      access.project,
      doc._id,
      commentId,
      messageId,
      actor,
      quote,
      body,
      (await watcherIds(ctx, doc._id)).filter((userId) => !mentioned.has(userId)),
      "watching",
    );
    await recordOrganizationEvent(ctx, {
      clerkOrgId: doc.clerkOrgId,
      actorUserId: actor.userId,
      actorName: actor.name,
      kind: "comment.created",
      projectId: doc.projectId,
      projectName: access.project.title,
      targetId: commentId,
      targetName: doc.name,
    });
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
      authorRole: actor.role,
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
    await ensureAutoWatch(ctx, {
      clerkOrgId: access.project.clerkOrgId,
      userId: actor.userId,
      projectId: thread.projectId,
      documentId: thread.documentId,
    });
    const alreadyNotified = new Set([...mentionUserIds, ...participants]);
    await notifyRecipients(
      ctx,
      access.project,
      thread.documentId,
      thread._id,
      messageId,
      actor,
      thread.quote,
      body,
      (await watcherIds(ctx, thread.documentId)).filter((userId) => !alreadyNotified.has(userId)),
      "watching",
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
    if (!identity) {
      return 0;
    }
    const clerkOrgId = organizationId(identity);
    if (!clerkOrgId) return 0;
    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_recipient_org_read", (q) =>
        q.eq("recipientUserId", identity.subject).eq("clerkOrgId", clerkOrgId).eq("readAt", null),
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
    if (!identity) {
      return [];
    }
    const clerkOrgId = organizationId(identity);
    if (!clerkOrgId) return [];
    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_recipient_org", (q) =>
        q.eq("recipientUserId", identity.subject).eq("clerkOrgId", clerkOrgId),
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
        threadStatus: target.thread?.status ?? "open",
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
      notification.clerkOrgId !== organizationId(identity)
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
    if (!identity) {
      return;
    }
    const clerkOrgId = organizationId(identity);
    if (!clerkOrgId) return;
    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_recipient_org_read", (q) =>
        q.eq("recipientUserId", identity.subject).eq("clerkOrgId", clerkOrgId).eq("readAt", null),
      )
      .take(MARK_READ_BATCH);
    const now = Date.now();
    for (const row of rows) {
      await ctx.db.patch(row._id, { readAt: now });
    }
    if (rows.length === MARK_READ_BATCH) {
      await ctx.scheduler.runAfter(0, internal.comments.markAllReadBatch, {
        recipientUserId: identity.subject,
        clerkOrgId,
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
