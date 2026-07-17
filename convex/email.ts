import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { secretMatches } from "./secrets";

const deliveryChoice = v.union(v.literal("immediate"), v.literal("digest"), v.literal("off"));
const notificationKind = v.union(
  v.literal("mention"),
  v.literal("reply"),
  v.literal("resolved"),
  v.literal("reopened"),
  v.literal("watching"),
);
const unsubscribeKind = v.union(notificationKind, v.literal("digest"));
const DIGEST_PAGE = 200;
const DIGEST_ITEMS = 100;
const RETRY_DELAYS = [5 * 60 * 1000, 30 * 60 * 1000, 2 * 60 * 60 * 1000];

type Kind = "mention" | "reply" | "resolved" | "reopened" | "watching";
type Choice = "immediate" | "digest" | "off";

const defaults: Record<Kind, Choice> = {
  mention: "immediate",
  reply: "digest",
  resolved: "digest",
  reopened: "digest",
  watching: "digest",
};

function kindFor(row: Doc<"notifications">): Kind {
  return row.kind ?? "mention";
}

function preferenceFor(row: Doc<"emailPreferences"> | null, kind: Kind): Choice {
  return row?.[kind] ?? defaults[kind];
}

function memberName(member: Doc<"members">): string {
  return [member.firstName, member.lastName].filter(Boolean).join(" ").trim() || member.email;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function labelFor(kind: Kind): string {
  if (kind === "mention") return "mentioned you";
  if (kind === "reply") return "replied to a thread";
  if (kind === "resolved") return "resolved a thread";
  if (kind === "reopened") return "reopened a thread";
  return "commented on a document you watch";
}

async function recipientCanAccess(ctx: QueryCtx, row: Doc<"notifications">): Promise<boolean> {
  const member = await ctx.db
    .query("members")
    .withIndex("by_org_user", (q) =>
      q.eq("clerkOrgId", row.clerkOrgId).eq("memberUserId", row.recipientUserId),
    )
    .unique();
  if (member?.status !== "accepted") return false;
  if (member.isOwner || member.role === "org:admin") return true;
  return Boolean(
    await ctx.db
      .query("projectAccess")
      .withIndex("by_project_user", (q) =>
        q.eq("projectId", row.projectId).eq("userId", row.recipientUserId),
      )
      .unique(),
  );
}

export const getPreferences = query({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || identity.org_id !== args.clerkOrgId) return null;
    const row = await ctx.db
      .query("emailPreferences")
      .withIndex("by_user_org", (q) =>
        q.eq("userId", identity.subject).eq("clerkOrgId", args.clerkOrgId),
      )
      .unique();
    return {
      mention: row?.mention ?? defaults.mention,
      reply: row?.reply ?? defaults.reply,
      resolved: row?.resolved ?? defaults.resolved,
      reopened: row?.reopened ?? defaults.reopened,
      watching: row?.watching ?? defaults.watching,
    };
  },
});

export const setPreferences = mutation({
  args: {
    clerkOrgId: v.string(),
    mention: deliveryChoice,
    reply: deliveryChoice,
    resolved: deliveryChoice,
    reopened: deliveryChoice,
    watching: deliveryChoice,
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || identity.org_id !== args.clerkOrgId) throw new Error("forbidden");
    const existing = await ctx.db
      .query("emailPreferences")
      .withIndex("by_user_org", (q) =>
        q.eq("userId", identity.subject).eq("clerkOrgId", args.clerkOrgId),
      )
      .unique();
    const value = { ...args, userId: identity.subject, updatedAt: Date.now() };
    if (existing) await ctx.db.patch(existing._id, value);
    else await ctx.db.insert("emailPreferences", value);
  },
});

export const notificationPayload = internalQuery({
  args: { notificationId: v.id("notifications") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.notificationId);
    if (!row || row.readAt !== null || row.emailSentAt) return null;
    const kind = kindFor(row);
    const [preference, member, project, document, thread] = await Promise.all([
      ctx.db
        .query("emailPreferences")
        .withIndex("by_user_org", (q) =>
          q.eq("userId", row.recipientUserId).eq("clerkOrgId", row.clerkOrgId),
        )
        .unique(),
      ctx.db
        .query("members")
        .withIndex("by_org_user", (q) =>
          q.eq("clerkOrgId", row.clerkOrgId).eq("memberUserId", row.recipientUserId),
        )
        .unique(),
      ctx.db.get(row.projectId),
      ctx.db.get(row.documentId),
      ctx.db.get(row.commentId),
    ]);
    if (
      preferenceFor(preference, kind) !== "immediate" ||
      !member ||
      member.status !== "accepted" ||
      !project ||
      project.deletedAt ||
      !document ||
      document.deletingAt ||
      document.trashedAt ||
      !thread ||
      !(await recipientCanAccess(ctx, row))
    ) {
      return null;
    }
    return {
      id: row._id,
      kind,
      email: member.email,
      recipientName: memberName(member),
      actorName: row.actorName,
      projectTitle: project.title,
      documentName: document.name,
      quote: row.quote,
      snippet: row.bodySnippet,
      clerkOrgId: row.clerkOrgId,
      recipientUserId: row.recipientUserId,
      projectId: row.projectId,
      documentId: row.documentId,
      commentId: row.commentId,
    };
  },
});

export const recordNotificationAttempt = internalMutation({
  args: { notificationId: v.id("notifications"), sent: v.boolean() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.notificationId);
    if (!row) return;
    await ctx.db.patch(row._id, {
      emailAttempts: (row.emailAttempts ?? 0) + 1,
      ...(args.sent ? { emailSentAt: Date.now() } : {}),
    });
  },
});

async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function unsubscribeUrl(
  userId: string,
  clerkOrgId: string,
  kind: Kind | "digest",
): Promise<string> {
  const site = process.env.NEXT_PUBLIC_SITE_URL;
  const secret = process.env.EMAIL_UNSUBSCRIBE_SECRET;
  if (!site || !secret || secret.length < 32) return site ?? "";
  const expires = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const payload = `${userId}.${clerkOrgId}.${kind}.${expires}`;
  const signature = await hmac(payload, secret);
  const token = btoa(payload).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return `${site}/api/notifications/unsubscribe?token=${token}&signature=${signature}`;
}

async function sendResend(input: {
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
}): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) return false;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": input.idempotencyKey,
    },
    body: JSON.stringify({
      from,
      to: [input.to],
      subject: input.subject,
      html: input.html,
      text: input.text,
    }),
  });
  if (!response.ok) throw new Error(`email-provider-${response.status}`);
  return true;
}

export const sendNotification = internalAction({
  args: { notificationId: v.id("notifications"), attempt: v.number() },
  handler: async (ctx, args) => {
    if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM_EMAIL) return;
    const payload = await ctx.runQuery(internal.email.notificationPayload, {
      notificationId: args.notificationId,
    });
    if (!payload) return;
    const site = process.env.NEXT_PUBLIC_SITE_URL ?? "";
    const link = `${site}/dashboard/projects/${payload.projectId}/editor?file=${payload.documentId}&thread=${payload.commentId}`;
    const unsubscribe = await unsubscribeUrl(
      payload.recipientUserId,
      payload.clerkOrgId,
      payload.kind,
    );
    const action = labelFor(payload.kind);
    const subject = `${payload.actorName} ${action} in ${payload.documentName}`;
    const text = `${payload.actorName} ${action} in ${payload.projectTitle} / ${payload.documentName}\n\n${payload.snippet}\n\nOpen thread: ${link}\n\nTurn off these emails: ${unsubscribe}`;
    const html = `<main style="font-family:ui-sans-serif,system-ui;max-width:560px;margin:auto;padding:24px;color:#171717"><p style="color:#666">${escapeHtml(payload.projectTitle)} / ${escapeHtml(payload.documentName)}</p><h1 style="font-size:22px">${escapeHtml(payload.actorName)} ${escapeHtml(action)}</h1><blockquote style="margin:20px 0;padding:12px 16px;border-left:3px solid #7c3aed;background:#f5f3ff">${escapeHtml(payload.snippet)}</blockquote><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 18px;background:#171717;color:white;text-decoration:none;border-radius:8px">Open thread</a><p style="margin-top:28px;font-size:12px;color:#777"><a href="${escapeHtml(unsubscribe)}">Turn off these emails</a></p></main>`;
    try {
      const sent = await sendResend({
        to: payload.email,
        subject,
        html,
        text,
        idempotencyKey: `notification/${payload.id}`,
      });
      if (sent) {
        await ctx.runMutation(internal.email.recordNotificationAttempt, {
          notificationId: payload.id,
          sent: true,
        });
      }
    } catch (error) {
      await ctx.runMutation(internal.email.recordNotificationAttempt, {
        notificationId: payload.id,
        sent: false,
      });
      console.error("[stash-server]", {
        level: "error",
        event: "email.notification_failed",
        notificationId: payload.id,
        attempt: args.attempt,
        error: error instanceof Error ? error.message : String(error),
      });
      const delay = RETRY_DELAYS[args.attempt];
      if (delay !== undefined) {
        await ctx.scheduler.runAfter(delay, internal.email.sendNotification, {
          notificationId: payload.id,
          attempt: args.attempt + 1,
        });
      }
    }
  },
});

export const queueDailyDigests = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("notifications")
      .withIndex("by_creation_time")
      .paginate({
        cursor: args.cursor ?? null,
        numItems: DIGEST_PAGE,
        maximumRowsRead: DIGEST_PAGE,
      });
    const recipients = new Map<string, { userId: string; clerkOrgId: string }>();
    for (const row of page.page) {
      if (row.readAt !== null || row.digestSentAt) continue;
      const preference = await ctx.db
        .query("emailPreferences")
        .withIndex("by_user_org", (q) =>
          q.eq("userId", row.recipientUserId).eq("clerkOrgId", row.clerkOrgId),
        )
        .unique();
      if (preferenceFor(preference, kindFor(row)) === "digest") {
        recipients.set(`${row.recipientUserId}\0${row.clerkOrgId}`, {
          userId: row.recipientUserId,
          clerkOrgId: row.clerkOrgId,
        });
      }
    }
    for (const recipient of recipients.values()) {
      await ctx.scheduler.runAfter(0, internal.email.sendDigest, { ...recipient, attempt: 0 });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.email.queueDailyDigests, {
        cursor: page.continueCursor,
      });
    }
  },
});

export const pruneDigestRuns = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - 35 * 24 * 60 * 60 * 1000;
    const rows = await ctx.db
      .query("emailDigestRuns")
      .withIndex("by_updated", (q) => q.lt("updatedAt", cutoff))
      .take(DIGEST_PAGE);
    for (const row of rows) await ctx.db.delete(row._id);
    if (rows.length === DIGEST_PAGE) {
      await ctx.scheduler.runAfter(0, internal.email.pruneDigestRuns, {});
    }
  },
});

export const digestPayload = internalQuery({
  args: { userId: v.string(), clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    const member = await ctx.db
      .query("members")
      .withIndex("by_org_user", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId).eq("memberUserId", args.userId),
      )
      .unique();
    if (member?.status !== "accepted") return null;
    const preference = await ctx.db
      .query("emailPreferences")
      .withIndex("by_user_org", (q) =>
        q.eq("userId", args.userId).eq("clerkOrgId", args.clerkOrgId),
      )
      .unique();
    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_recipient_org_read", (q) =>
        q.eq("recipientUserId", args.userId).eq("clerkOrgId", args.clerkOrgId).eq("readAt", null),
      )
      .order("desc")
      .take(DIGEST_ITEMS);
    const items = [];
    for (const row of rows) {
      const kind = kindFor(row);
      if (row.digestSentAt || preferenceFor(preference, kind) !== "digest") continue;
      const [project, document] = await Promise.all([
        ctx.db.get(row.projectId),
        ctx.db.get(row.documentId),
      ]);
      if (!project || project.deletedAt || !document || document.deletingAt || document.trashedAt) {
        continue;
      }
      if (!(await recipientCanAccess(ctx, row))) continue;
      items.push({
        id: row._id,
        actorName: row.actorName,
        action: labelFor(kind),
        projectTitle: project.title,
        documentName: document.name,
        snippet: row.bodySnippet,
        link: `/dashboard/projects/${row.projectId}/editor?file=${row.documentId}&thread=${row.commentId}`,
      });
    }
    return items.length > 0
      ? { email: member.email, recipientName: memberName(member), items }
      : null;
  },
});

export const claimDigest = internalMutation({
  args: { userId: v.string(), clerkOrgId: v.string(), day: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("emailDigestRuns")
      .withIndex("by_user_org_day", (q) =>
        q.eq("userId", args.userId).eq("clerkOrgId", args.clerkOrgId).eq("day", args.day),
      )
      .unique();
    if (row?.state === "sent" || row?.state === "sending") return false;
    const value = {
      ...args,
      state: "sending" as const,
      attempts: (row?.attempts ?? 0) + 1,
      updatedAt: Date.now(),
    };
    if (row) await ctx.db.patch(row._id, value);
    else await ctx.db.insert("emailDigestRuns", value);
    return true;
  },
});

export const finishDigest = internalMutation({
  args: {
    userId: v.string(),
    clerkOrgId: v.string(),
    day: v.string(),
    sent: v.boolean(),
    notificationIds: v.array(v.id("notifications")),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("emailDigestRuns")
      .withIndex("by_user_org_day", (q) =>
        q.eq("userId", args.userId).eq("clerkOrgId", args.clerkOrgId).eq("day", args.day),
      )
      .unique();
    if (row) {
      await ctx.db.patch(row._id, { state: args.sent ? "sent" : "failed", updatedAt: Date.now() });
    }
    if (args.sent) {
      for (const id of args.notificationIds) {
        const notification = await ctx.db.get(id);
        if (notification && notification.readAt === null) {
          await ctx.db.patch(id, { digestSentAt: Date.now() });
        }
      }
    }
  },
});

export const sendDigest = internalAction({
  args: { userId: v.string(), clerkOrgId: v.string(), attempt: v.number() },
  handler: async (ctx, args) => {
    if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM_EMAIL) return;
    const day = new Date().toISOString().slice(0, 10);
    if (!(await ctx.runMutation(internal.email.claimDigest, { ...args, day }))) return;
    const payload = await ctx.runQuery(internal.email.digestPayload, {
      userId: args.userId,
      clerkOrgId: args.clerkOrgId,
    });
    if (!payload) {
      await ctx.runMutation(internal.email.finishDigest, {
        userId: args.userId,
        clerkOrgId: args.clerkOrgId,
        day,
        sent: true,
        notificationIds: [],
      });
      return;
    }
    const site = process.env.NEXT_PUBLIC_SITE_URL ?? "";
    const lines = payload.items.map(
      (item) =>
        `${item.actorName} ${item.action} in ${item.projectTitle} / ${item.documentName}\n${item.snippet}\n${site}${item.link}`,
    );
    const htmlItems = payload.items
      .map(
        (item) =>
          `<li style="margin-bottom:18px"><strong>${escapeHtml(item.actorName)} ${escapeHtml(item.action)}</strong><br><span style="color:#666">${escapeHtml(item.projectTitle)} / ${escapeHtml(item.documentName)}</span><p>${escapeHtml(item.snippet)}</p><a href="${escapeHtml(site + item.link)}">Open thread</a></li>`,
      )
      .join("");
    const unsubscribe = await unsubscribeUrl(args.userId, args.clerkOrgId, "digest");
    try {
      await sendResend({
        to: payload.email,
        subject: `Your Stash daily digest (${payload.items.length})`,
        text: `Hello ${payload.recipientName},\n\n${lines.join("\n\n")}\n\nTurn off daily digest emails: ${unsubscribe}`,
        html: `<main style="font-family:ui-sans-serif,system-ui;max-width:600px;margin:auto;padding:24px"><h1>Your daily digest</h1><p>${payload.items.length} unread updates</p><ul style="padding:0;list-style:none">${htmlItems}</ul><p style="margin-top:28px;font-size:12px;color:#777"><a href="${escapeHtml(unsubscribe)}">Turn off daily digest emails</a></p></main>`,
        idempotencyKey: `digest/${args.userId}/${args.clerkOrgId}/${day}`,
      });
      await ctx.runMutation(internal.email.finishDigest, {
        userId: args.userId,
        clerkOrgId: args.clerkOrgId,
        day,
        sent: true,
        notificationIds: payload.items.map((item) => item.id),
      });
    } catch (error) {
      await ctx.runMutation(internal.email.finishDigest, {
        userId: args.userId,
        clerkOrgId: args.clerkOrgId,
        day,
        sent: false,
        notificationIds: [],
      });
      console.error("[stash-server]", {
        level: "error",
        event: "email.digest_failed",
        userId: args.userId,
        clerkOrgId: args.clerkOrgId,
        attempt: args.attempt,
        error: error instanceof Error ? error.message : String(error),
      });
      const delay = RETRY_DELAYS[args.attempt];
      if (delay !== undefined) {
        await ctx.scheduler.runAfter(delay, internal.email.sendDigest, {
          ...args,
          attempt: args.attempt + 1,
        });
      }
    }
  },
});

export const unsubscribeWithSecret = mutation({
  args: {
    secret: v.string(),
    userId: v.string(),
    clerkOrgId: v.string(),
    kind: unsubscribeKind,
  },
  handler: async (ctx, args) => {
    if (!secretMatches(args.secret, process.env.CONVEX_PURGE_SECRET)) throw new Error("forbidden");
    const existing = await ctx.db
      .query("emailPreferences")
      .withIndex("by_user_org", (q) =>
        q.eq("userId", args.userId).eq("clerkOrgId", args.clerkOrgId),
      )
      .unique();
    const current = {
      mention: existing?.mention ?? defaults.mention,
      reply: existing?.reply ?? defaults.reply,
      resolved: existing?.resolved ?? defaults.resolved,
      reopened: existing?.reopened ?? defaults.reopened,
      watching: existing?.watching ?? defaults.watching,
    };
    const value = {
      clerkOrgId: args.clerkOrgId,
      userId: args.userId,
      mention:
        args.kind === "mention" || (args.kind === "digest" && current.mention === "digest")
          ? ("off" as const)
          : current.mention,
      reply:
        args.kind === "reply" || (args.kind === "digest" && current.reply === "digest")
          ? ("off" as const)
          : current.reply,
      resolved:
        args.kind === "resolved" || (args.kind === "digest" && current.resolved === "digest")
          ? ("off" as const)
          : current.resolved,
      reopened:
        args.kind === "reopened" || (args.kind === "digest" && current.reopened === "digest")
          ? ("off" as const)
          : current.reopened,
      watching:
        args.kind === "watching" || (args.kind === "digest" && current.watching === "digest")
          ? ("off" as const)
          : current.watching,
      updatedAt: Date.now(),
    };
    if (existing) await ctx.db.patch(existing._id, value);
    else await ctx.db.insert("emailPreferences", value);
  },
});
