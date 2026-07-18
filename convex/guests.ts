import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { recordOrganizationEvent } from "./audit";
import { accessForProject, requireProjectAdmin } from "./documents";
import { DEFAULT_MAX_GUESTS } from "./limits";
import { enforceWriteRateLimit } from "./writeRateLimit";

const INVITATION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_GUEST_INVITATIONS = 1_000;

export const registerInvitation = mutation({
  args: {
    projectId: v.id("projects"),
    email: v.string(),
    clerkInvitationId: v.string(),
    level: v.union(v.literal("viewer"), v.literal("editor")),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectAdmin(ctx, args.projectId);
    const allowed = await enforceWriteRateLimit(
      ctx,
      "guest-invite",
      args.projectId,
      access.userId,
      {
        capacity: 20,
        refillPerSecond: 20 / 60,
      },
    );
    if (!allowed) throw new Error("rate-limited");
    const email = args.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("invalid-email");
    const organization = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", access.project.clerkOrgId))
      .unique();
    const members = await ctx.db
      .query("members")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", access.project.clerkOrgId))
      .take(MAX_GUEST_INVITATIONS);
    const pending = await ctx.db
      .query("guestInvitations")
      .withIndex("by_org", (q) => q.eq("clerkOrgId", access.project.clerkOrgId))
      .take(MAX_GUEST_INVITATIONS);
    const now = Date.now();
    const guests = members.filter(
      (member) => member.role === "org:guest" && member.status === "accepted",
    ).length;
    const livePending = pending.filter((invite) => invite.expiresAt > now);
    if (guests + livePending.length >= (organization?.maxGuests ?? DEFAULT_MAX_GUESTS)) {
      throw new Error("guest-limit-reached");
    }
    const duplicate = pending.find((invite) => invite.email === email && invite.expiresAt > now);
    if (duplicate) throw new Error("already-invited");
    const existingInvitation = await ctx.db
      .query("guestInvitations")
      .withIndex("by_invitation", (q) => q.eq("clerkInvitationId", args.clerkInvitationId))
      .unique();
    if (existingInvitation) return existingInvitation._id;
    const id = await ctx.db.insert("guestInvitations", {
      clerkOrgId: access.project.clerkOrgId,
      projectId: args.projectId,
      email,
      clerkInvitationId: args.clerkInvitationId,
      level: args.level,
      invitedBy: access.userId,
      expiresAt: now + INVITATION_TTL_MS,
      createdAt: now,
      updatedAt: now,
    });
    await recordOrganizationEvent(ctx, {
      clerkOrgId: access.project.clerkOrgId,
      actorUserId: access.userId,
      actorName: access.userId,
      kind: "guest.invited",
      projectId: access.project._id,
      projectName: access.project.title,
      targetId: id,
      targetName: email,
      metadata: JSON.stringify({ level: args.level }),
    });
    return id;
  },
});

export const cancelInvitation = mutation({
  args: { projectId: v.id("projects"), clerkInvitationId: v.string() },
  handler: async (ctx, args) => {
    const access = await requireProjectAdmin(ctx, args.projectId);
    const invitation = await ctx.db
      .query("guestInvitations")
      .withIndex("by_invitation", (q) => q.eq("clerkInvitationId", args.clerkInvitationId))
      .unique();
    if (!invitation || invitation.projectId !== args.projectId) return false;
    await ctx.db.delete(invitation._id);
    await recordOrganizationEvent(ctx, {
      clerkOrgId: access.project.clerkOrgId,
      actorUserId: access.userId,
      actorName: access.userId,
      kind: "guest.invitation_cancelled",
      projectId: access.project._id,
      projectName: access.project.title,
      targetId: invitation._id,
      targetName: invitation.email,
    });
    return true;
  },
});

export const listForProject = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const access = await accessForProject(ctx, args.projectId);
    if (!access?.isAdmin) throw new Error("Forbidden");
    const now = Date.now();
    return (
      await ctx.db
        .query("guestInvitations")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .order("desc")
        .take(100)
    )
      .filter((invitation) => invitation.expiresAt > now)
      .map((invitation) => ({
        id: invitation._id,
        email: invitation.email,
        level: invitation.level,
        clerkInvitationId: invitation.clerkInvitationId,
        expiresAt: invitation.expiresAt,
      }));
  },
});

export const acceptForMember = internalMutation({
  args: { clerkOrgId: v.string(), userId: v.string(), email: v.string() },
  handler: async (ctx, args) => {
    const invitations = await ctx.db
      .query("guestInvitations")
      .withIndex("by_org_email", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId).eq("email", args.email.toLowerCase()),
      )
      .collect();
    const now = Date.now();
    for (const invitation of invitations) {
      if (invitation.expiresAt <= now) {
        await ctx.db.delete(invitation._id);
        continue;
      }
      const existing = await ctx.db
        .query("projectAccess")
        .withIndex("by_project_user", (q) =>
          q.eq("projectId", invitation.projectId).eq("userId", args.userId),
        )
        .unique();
      if (existing) await ctx.db.patch(existing._id, { level: invitation.level });
      else {
        await ctx.db.insert("projectAccess", {
          projectId: invitation.projectId,
          clerkOrgId: invitation.clerkOrgId,
          userId: args.userId,
          level: invitation.level,
          createdAt: now,
        });
      }
      const project = await ctx.db.get(invitation.projectId);
      await recordOrganizationEvent(ctx, {
        clerkOrgId: invitation.clerkOrgId,
        actorUserId: args.userId,
        actorName: args.email,
        kind: "guest.joined",
        projectId: invitation.projectId,
        projectName: project?.title,
        targetId: args.userId,
        targetName: args.email,
        metadata: JSON.stringify({ level: invitation.level }),
      });
      await ctx.db.delete(invitation._id);
    }
  },
});

export const pruneExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("guestInvitations")
      .withIndex("by_expiry", (q) => q.lt("expiresAt", Date.now()))
      .take(200);
    for (const row of rows) await ctx.db.delete(row._id);
    return rows.length;
  },
});

export const deleteByInvitation = internalMutation({
  args: { clerkOrgId: v.string(), clerkInvitationId: v.string() },
  handler: async (ctx, args) => {
    const invitation = await ctx.db
      .query("guestInvitations")
      .withIndex("by_invitation", (q) => q.eq("clerkInvitationId", args.clerkInvitationId))
      .unique();
    if (invitation?.clerkOrgId === args.clerkOrgId) await ctx.db.delete(invitation._id);
  },
});
