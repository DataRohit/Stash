import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { purgeAccessForUser } from "./projects";
import { secretMatches } from "./secrets";

const memberInput = v.object({
  memberUserId: v.string(),
  email: v.string(),
  role: v.string(),
  firstName: v.union(v.string(), v.null()),
  lastName: v.union(v.string(), v.null()),
  imageUrl: v.union(v.string(), v.null()),
});

const pendingInput = v.object({
  clerkInvitationId: v.string(),
  email: v.string(),
  role: v.string(),
});

function requireWebhookSecret(secret: string): void {
  if (!secretMatches(secret, process.env.CONVEX_PURGE_SECRET)) {
    throw new Error("Forbidden");
  }
}

async function requireOrgMember(ctx: QueryCtx, clerkOrgId: string): Promise<boolean> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    return false;
  }
  return identity.org_id === clerkOrgId;
}

async function requireOrgAdmin(ctx: MutationCtx, clerkOrgId: string): Promise<boolean> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    return false;
  }
  return identity.org_id === clerkOrgId && identity.org_role === "org:admin";
}

function rowsByOrg(ctx: QueryCtx, clerkOrgId: string) {
  return ctx.db
    .query("members")
    .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", clerkOrgId))
    .collect();
}

function statusRank(row: Doc<"members">): number {
  if (row.isOwner) {
    return 0;
  }
  return row.status === "accepted" ? 1 : 2;
}

export const listByOrg = query({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    if (!(await requireOrgMember(ctx, args.clerkOrgId))) {
      return [];
    }
    const rows = await rowsByOrg(ctx, args.clerkOrgId);
    return rows
      .sort((a, b) => statusRank(a) - statusRank(b) || a.invitedAt - b.invitedAt)
      .map((row) => ({
        id: row._id,
        email: row.email,
        memberUserId: row.memberUserId,
        status: row.status,
        role: row.role,
        isOwner: row.isOwner,
        firstName: row.firstName,
        lastName: row.lastName,
        imageUrl: row.imageUrl,
        clerkInvitationId: row.clerkInvitationId,
      }));
  },
});

export const pendingForMe = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    const email = typeof identity?.email === "string" ? identity.email.toLowerCase() : null;
    if (!email) {
      return [];
    }
    const rows = await ctx.db
      .query("members")
      .withIndex("by_email", (q) => q.eq("email", email))
      .collect();
    return rows
      .filter((row) => row.status === "pending")
      .map((row) => ({ id: row._id, clerkOrgId: row.clerkOrgId }));
  },
});

export const upsertPending = mutation({
  args: {
    clerkOrgId: v.string(),
    email: v.string(),
    role: v.string(),
    clerkInvitationId: v.string(),
  },
  handler: async (ctx, args) => {
    if (!(await requireOrgAdmin(ctx, args.clerkOrgId))) {
      throw new Error("Forbidden");
    }
    const now = Date.now();
    const existing = await ctx.db
      .query("members")
      .withIndex("by_org_email", (q) => q.eq("clerkOrgId", args.clerkOrgId).eq("email", args.email))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        role: args.role,
        status: "pending",
        clerkInvitationId: args.clerkInvitationId,
        updatedAt: now,
      });
      return;
    }
    await ctx.db.insert("members", {
      clerkOrgId: args.clerkOrgId,
      email: args.email,
      memberUserId: null,
      status: "pending",
      role: args.role,
      isOwner: false,
      firstName: null,
      lastName: null,
      imageUrl: null,
      clerkInvitationId: args.clerkInvitationId,
      invitedAt: now,
      updatedAt: now,
    });
  },
});

export const deleteByInvitationId = mutation({
  args: { clerkOrgId: v.string(), clerkInvitationId: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthenticated");
    }
    const isAdmin = identity.org_id === args.clerkOrgId && identity.org_role === "org:admin";
    const callerEmail = typeof identity.email === "string" ? identity.email.toLowerCase() : null;
    const rows = await rowsByOrg(ctx, args.clerkOrgId);
    for (const row of rows) {
      if (row.clerkInvitationId !== args.clerkInvitationId) {
        continue;
      }
      if (!isAdmin && row.email !== callerEmail) {
        throw new Error("Forbidden");
      }
      await ctx.db.delete(row._id);
    }
  },
});

export const deleteByUserId = mutation({
  args: { clerkOrgId: v.string(), memberUserId: v.string() },
  handler: async (ctx, args) => {
    if (!(await requireOrgAdmin(ctx, args.clerkOrgId))) {
      throw new Error("Forbidden");
    }
    const existing = await ctx.db
      .query("members")
      .withIndex("by_org_user", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId).eq("memberUserId", args.memberUserId),
      )
      .unique();
    if (existing) {
      await ctx.db.delete(existing._id);
    }
  },
});

export const deleteAllByOrg = mutation({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    if (!(await requireOrgAdmin(ctx, args.clerkOrgId))) {
      throw new Error("Forbidden");
    }
    const rows = await rowsByOrg(ctx, args.clerkOrgId);
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
  },
});

export const reconcile = mutation({
  args: {
    secret: v.string(),
    clerkOrgId: v.string(),
    ownerUserId: v.string(),
    members: v.array(memberInput),
    pendingInvites: v.array(pendingInput),
  },
  handler: async (ctx, args) => {
    requireWebhookSecret(args.secret);
    if (!(await requireOrgMember(ctx, args.clerkOrgId))) {
      throw new Error("Forbidden");
    }
    const now = Date.now();
    const rows = await rowsByOrg(ctx, args.clerkOrgId);
    const byUser = new Map<string, Doc<"members">>();
    const byEmail = new Map<string, Doc<"members">>();
    for (const row of rows) {
      if (row.memberUserId) {
        byUser.set(row.memberUserId, row);
      }
      byEmail.set(row.email, row);
    }

    const matched = new Set<string>();
    const acceptedUserIds = new Set(args.members.map((member) => member.memberUserId));
    const acceptedEmails = new Set(args.members.map((member) => member.email));

    for (const member of args.members) {
      const isOwner = member.memberUserId === args.ownerUserId;
      const existing = byUser.get(member.memberUserId) ?? byEmail.get(member.email);
      const fields = {
        clerkOrgId: args.clerkOrgId,
        email: member.email,
        memberUserId: member.memberUserId,
        status: "accepted" as const,
        role: member.role,
        isOwner,
        firstName: member.firstName,
        lastName: member.lastName,
        imageUrl: member.imageUrl,
        clerkInvitationId: null,
        updatedAt: now,
      };
      if (existing) {
        await ctx.db.patch(existing._id, fields);
        matched.add(existing._id);
      } else {
        await ctx.db.insert("members", { ...fields, invitedAt: now });
      }
      if (isOwner || member.role === "org:admin") {
        await purgeAccessForUser(ctx, args.clerkOrgId, member.memberUserId);
      }
    }

    for (const invite of args.pendingInvites) {
      const existing = byEmail.get(invite.email);
      if (existing && (matched.has(existing._id) || existing.status === "accepted")) {
        continue;
      }
      if (existing) {
        await ctx.db.patch(existing._id, {
          role: invite.role,
          status: "pending",
          clerkInvitationId: invite.clerkInvitationId,
          updatedAt: now,
        });
        matched.add(existing._id);
      } else {
        await ctx.db.insert("members", {
          clerkOrgId: args.clerkOrgId,
          email: invite.email,
          memberUserId: null,
          status: "pending",
          role: invite.role,
          isOwner: false,
          firstName: null,
          lastName: null,
          imageUrl: null,
          clerkInvitationId: invite.clerkInvitationId,
          invitedAt: now,
          updatedAt: now,
        });
      }
    }

    for (const row of rows) {
      if (matched.has(row._id)) {
        continue;
      }
      if (row.memberUserId && acceptedUserIds.has(row.memberUserId)) {
        continue;
      }
      if (acceptedEmails.has(row.email)) {
        continue;
      }
      if (row.memberUserId) {
        await purgeAccessForUser(ctx, args.clerkOrgId, row.memberUserId);
      }
      await ctx.db.delete(row._id);
    }
  },
});

export const webhookUpsertMember = mutation({
  args: {
    secret: v.string(),
    clerkOrgId: v.string(),
    ownerUserId: v.string(),
    memberUserId: v.string(),
    email: v.string(),
    role: v.string(),
    firstName: v.union(v.string(), v.null()),
    lastName: v.union(v.string(), v.null()),
    imageUrl: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    requireWebhookSecret(args.secret);
    const now = Date.now();
    const email = args.email.toLowerCase();
    const existingByUser = await ctx.db
      .query("members")
      .withIndex("by_org_user", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId).eq("memberUserId", args.memberUserId),
      )
      .unique();
    const existingByEmail = await ctx.db
      .query("members")
      .withIndex("by_org_email", (q) => q.eq("clerkOrgId", args.clerkOrgId).eq("email", email))
      .unique();
    const existing = existingByUser ?? existingByEmail;
    if (existingByUser && existingByEmail && existingByUser._id !== existingByEmail._id) {
      await ctx.db.delete(existingByEmail._id);
    }
    const fields = {
      clerkOrgId: args.clerkOrgId,
      email,
      memberUserId: args.memberUserId,
      status: "accepted" as const,
      role: args.role,
      isOwner: args.memberUserId === args.ownerUserId,
      firstName: args.firstName,
      lastName: args.lastName,
      imageUrl: args.imageUrl,
      clerkInvitationId: null,
      updatedAt: now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, fields);
    } else {
      await ctx.db.insert("members", { ...fields, invitedAt: now });
    }
    if (fields.isOwner || fields.role === "org:admin") {
      await purgeAccessForUser(ctx, args.clerkOrgId, args.memberUserId);
    }
  },
});

export const webhookDeleteMember = mutation({
  args: { secret: v.string(), clerkOrgId: v.string(), memberUserId: v.string() },
  handler: async (ctx, args) => {
    requireWebhookSecret(args.secret);
    const existing = await ctx.db
      .query("members")
      .withIndex("by_org_user", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId).eq("memberUserId", args.memberUserId),
      )
      .unique();
    if (existing) {
      await ctx.db.delete(existing._id);
    }
    await purgeAccessForUser(ctx, args.clerkOrgId, args.memberUserId);
  },
});

export const webhookDeleteUser = mutation({
  args: { secret: v.string(), memberUserId: v.string() },
  handler: async (ctx, args) => {
    requireWebhookSecret(args.secret);
    const memberships = await ctx.db
      .query("members")
      .withIndex("by_user", (q) => q.eq("memberUserId", args.memberUserId))
      .collect();
    for (const membership of memberships) {
      await ctx.db.delete(membership._id);
      await purgeAccessForUser(ctx, membership.clerkOrgId, args.memberUserId);
    }
  },
});

export const webhookUpsertInvitation = mutation({
  args: {
    secret: v.string(),
    clerkOrgId: v.string(),
    clerkInvitationId: v.string(),
    email: v.string(),
    role: v.string(),
  },
  handler: async (ctx, args) => {
    requireWebhookSecret(args.secret);
    const now = Date.now();
    const email = args.email.toLowerCase();
    const existing = await ctx.db
      .query("members")
      .withIndex("by_org_email", (q) => q.eq("clerkOrgId", args.clerkOrgId).eq("email", email))
      .unique();
    const fields = {
      role: args.role,
      status: "pending" as const,
      clerkInvitationId: args.clerkInvitationId,
      updatedAt: now,
    };
    if (existing) {
      if (existing.status === "accepted") {
        return;
      }
      await ctx.db.patch(existing._id, fields);
    } else {
      await ctx.db.insert("members", {
        clerkOrgId: args.clerkOrgId,
        email,
        memberUserId: null,
        isOwner: false,
        firstName: null,
        lastName: null,
        imageUrl: null,
        invitedAt: now,
        ...fields,
      });
    }
  },
});

export const webhookDeleteInvitation = mutation({
  args: { secret: v.string(), clerkOrgId: v.string(), clerkInvitationId: v.string() },
  handler: async (ctx, args) => {
    requireWebhookSecret(args.secret);
    const rows = await rowsByOrg(ctx, args.clerkOrgId);
    for (const row of rows) {
      if (row.clerkInvitationId === args.clerkInvitationId) {
        await ctx.db.delete(row._id);
      }
    }
  },
});
