"use server";

import { auth, clerkClient } from "@clerk/nextjs/server";
import {
  cancelGuestInvitation,
  claimReconcile,
  mirrorDeleteInvitation,
  mirrorDeleteMember,
  mirrorUpsertPending,
  reconcileOrgMembers,
  registerGuestInvitation,
  revokeAllProjectAccessForUser,
} from "@/lib/convex-server";
import { getUserPlanLimits } from "@/lib/plan-limits";
import { logServerError } from "@/lib/server-log";

type ClerkClient = Awaited<ReturnType<typeof clerkClient>>;

export type MemberRole = "org:admin" | "org:member" | "org:guest";
export type MemberActionResult = { ok: true } | { error: string };

const ALLOWED_ROLES: MemberRole[] = ["org:admin", "org:member"];
const PAGE_SIZE = 100;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RECONCILE_STALE_MS = 30_000;

type ClerkMember = {
  role: string;
  publicUserData?: {
    userId?: string | null;
    identifier?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    imageUrl?: string | null;
  } | null;
};

type ClerkInvitation = {
  id: string;
  emailAddress: string;
  role: string;
};

async function fetchAllMembers(
  client: ClerkClient,
  organizationId: string,
): Promise<ClerkMember[]> {
  const all: ClerkMember[] = [];
  let offset = 0;
  while (true) {
    const page = await client.organizations.getOrganizationMembershipList({
      organizationId,
      limit: PAGE_SIZE,
      offset,
    });
    all.push(...(page.data as ClerkMember[]));
    if (page.data.length < PAGE_SIZE) {
      break;
    }
    offset += PAGE_SIZE;
  }
  return all;
}

async function fetchAllPending(
  client: ClerkClient,
  organizationId: string,
): Promise<ClerkInvitation[]> {
  const all: ClerkInvitation[] = [];
  let offset = 0;
  while (true) {
    const page = await client.organizations.getOrganizationInvitationList({
      organizationId,
      status: ["pending"],
      limit: PAGE_SIZE,
      offset,
    });
    all.push(...(page.data as unknown as ClerkInvitation[]));
    if (page.data.length < PAGE_SIZE) {
      break;
    }
    offset += PAGE_SIZE;
  }
  return all;
}

async function revokeUserSessions(client: ClerkClient, userId: string): Promise<void> {
  try {
    const sessions = await client.sessions.getSessionList({ userId, status: "active" });
    await Promise.all(sessions.data.map((session) => client.sessions.revokeSession(session.id)));
  } catch (error) {
    logServerError("dashboard.revoke_member_sessions_failed", error, { userId });
    throw error;
  }
}

function toReconcileMembers(members: ClerkMember[]) {
  return members
    .filter((member) => member.publicUserData?.userId)
    .map((member) => ({
      memberUserId: member.publicUserData?.userId ?? "",
      email: (member.publicUserData?.identifier ?? "").toLowerCase(),
      role: member.role,
      firstName: member.publicUserData?.firstName ?? null,
      lastName: member.publicUserData?.lastName ?? null,
      imageUrl: member.publicUserData?.imageUrl ?? null,
    }));
}

function memberUserIdsForEmail(
  matchingUsers: Awaited<ReturnType<ClerkClient["users"]["getUserList"]>>,
) {
  return new Set(matchingUsers.data.map((user) => user.id));
}

function hasEmailMatchedMember(members: ClerkMember[], userIds: Set<string>): boolean {
  return members.some((member) => {
    const memberUserId = member.publicUserData?.userId;
    return !!memberUserId && userIds.has(memberUserId);
  });
}

export async function reconcileMembers(): Promise<MemberActionResult> {
  const { userId, orgId } = await auth();
  if (!userId || !orgId) {
    return { error: "unauthenticated" };
  }

  if (!(await claimReconcile(orgId, RECONCILE_STALE_MS))) {
    return { ok: true };
  }

  try {
    const client = await clerkClient();
    const [organization, members, pending] = await Promise.all([
      client.organizations.getOrganization({ organizationId: orgId }),
      fetchAllMembers(client, orgId),
      fetchAllPending(client, orgId),
    ]);

    await reconcileOrgMembers(
      orgId,
      organization.createdBy ?? "",
      toReconcileMembers(members),
      pending.map((invite) => ({
        clerkInvitationId: invite.id,
        email: invite.emailAddress.toLowerCase(),
        role: invite.role,
      })),
    );
    return { ok: true };
  } catch (error) {
    logServerError("dashboard.reconcile_members_failed", error, { clerkOrgId: orgId, userId });
    return { error: "failed" };
  }
}

export async function inviteMember(input: {
  email: string;
  role: MemberRole;
}): Promise<MemberActionResult> {
  const { userId, orgId, orgRole } = await auth();
  if (!userId || !orgId) {
    return { error: "unauthenticated" };
  }
  if (orgRole !== "org:admin") {
    return { error: "forbidden" };
  }

  const email = input.email.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) {
    return { error: "invalid-email" };
  }
  const role: MemberRole = ALLOWED_ROLES.includes(input.role) ? input.role : "org:member";

  try {
    const client = await clerkClient();
    const [members, pending, limits, matchingUsers] = await Promise.all([
      fetchAllMembers(client, orgId),
      fetchAllPending(client, orgId),
      getUserPlanLimits(),
      client.users.getUserList({ emailAddress: [email], limit: 1 }),
    ]);

    if (members.length + pending.length >= limits.maxMembersPerOrganization) {
      return { error: "limit-reached" };
    }
    const matchingUserIds = memberUserIdsForEmail(matchingUsers);
    if (pending.some((invite) => invite.emailAddress.toLowerCase() === email)) {
      return { error: "already-invited" };
    }
    if (matchingUsers.totalCount === 0) {
      return { error: "no-account" };
    }
    if (hasEmailMatchedMember(members, matchingUserIds)) {
      return { error: "already-member" };
    }

    const invitation = await client.organizations.createOrganizationInvitation({
      organizationId: orgId,
      inviterUserId: userId,
      emailAddress: email,
      role,
    });
    const [latestMembers, latestPending] = await Promise.all([
      fetchAllMembers(client, orgId),
      fetchAllPending(client, orgId),
    ]);
    const isOverLimit =
      latestMembers.length + latestPending.length > limits.maxMembersPerOrganization;
    const isNowMember = hasEmailMatchedMember(latestMembers, matchingUserIds);
    const duplicatePending =
      latestPending.filter((invite) => invite.emailAddress.toLowerCase() === email).length > 1;
    if (isOverLimit || isNowMember || duplicatePending) {
      try {
        await client.organizations.revokeOrganizationInvitation({
          organizationId: orgId,
          invitationId: invitation.id,
          requestingUserId: userId,
        });
        await mirrorDeleteInvitation(orgId, invitation.id);
      } catch (error) {
        logServerError("dashboard.invitation_rollback_failed", error, {
          clerkOrgId: orgId,
          userId,
        });
      }
      if (isNowMember) {
        return { error: "already-member" };
      }
      if (duplicatePending) {
        return { error: "already-invited" };
      }
      return { error: "limit-reached" };
    }
    await mirrorUpsertPending(orgId, email, role, invitation.id);
    return { ok: true };
  } catch (error) {
    logServerError("dashboard.invite_member_failed", error, { clerkOrgId: orgId, userId });
    return { error: "failed" };
  }
}

export async function inviteGuest(input: {
  projectId: string;
  email: string;
  level: "viewer" | "editor";
}): Promise<MemberActionResult> {
  const { userId, orgId, orgRole } = await auth();
  if (!userId || !orgId) return { error: "unauthenticated" };
  if (orgRole !== "org:admin") return { error: "forbidden" };
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) return { error: "invalid-email" };
  try {
    const client = await clerkClient();
    const [members, pending, limits] = await Promise.all([
      fetchAllMembers(client, orgId),
      fetchAllPending(client, orgId),
      getUserPlanLimits(),
    ]);
    const guestCount = members.filter((member) => member.role === "org:guest").length;
    const pendingGuestCount = pending.filter((invite) => invite.role === "org:guest").length;
    if (guestCount + pendingGuestCount >= limits.maxGuestsPerOrganization) {
      return { error: "guest-limit-reached" };
    }
    if (pending.some((invite) => invite.emailAddress.toLowerCase() === email)) {
      return { error: "already-invited" };
    }
    const invitation = await client.organizations.createOrganizationInvitation({
      organizationId: orgId,
      inviterUserId: userId,
      emailAddress: email,
      role: "org:guest",
    });
    try {
      await registerGuestInvitation({
        projectId: input.projectId,
        email,
        clerkInvitationId: invitation.id,
        level: input.level,
      });
      await mirrorUpsertPending(orgId, email, "org:guest", invitation.id);
      return { ok: true };
    } catch (error) {
      await client.organizations.revokeOrganizationInvitation({
        organizationId: orgId,
        invitationId: invitation.id,
        requestingUserId: userId,
      });
      await cancelGuestInvitation(input.projectId, invitation.id).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    logServerError("dashboard.invite_guest_failed", error, {
      clerkOrgId: orgId,
      userId,
      projectId: input.projectId,
    });
    const message = error instanceof Error ? error.message : "";
    if (message.includes("guest-limit-reached")) return { error: "guest-limit-reached" };
    if (message.includes("already-invited")) return { error: "already-invited" };
    return { error: "failed" };
  }
}

export async function cancelInvitation(input: {
  invitationId: string;
}): Promise<MemberActionResult> {
  const { userId, orgId, orgRole } = await auth();
  if (!userId || !orgId) {
    return { error: "unauthenticated" };
  }
  if (orgRole !== "org:admin") {
    return { error: "forbidden" };
  }

  try {
    const client = await clerkClient();
    await client.organizations.revokeOrganizationInvitation({
      organizationId: orgId,
      invitationId: input.invitationId,
      requestingUserId: userId,
    });
    await mirrorDeleteInvitation(orgId, input.invitationId);
    return { ok: true };
  } catch (error) {
    logServerError("dashboard.cancel_invitation_failed", error, {
      clerkOrgId: orgId,
      userId,
    });
    return { error: "failed" };
  }
}

export async function declineInvitation(input: {
  invitationId: string;
}): Promise<MemberActionResult> {
  const { userId } = await auth();
  if (!userId) {
    return { error: "unauthenticated" };
  }

  try {
    const client = await clerkClient();
    const invitations = await client.users.getOrganizationInvitationList({
      userId,
      status: "pending",
    });
    const invitation = invitations.data.find((entry) => entry.id === input.invitationId);
    if (!invitation) {
      return { error: "not-found" };
    }

    const organization = await client.organizations.getOrganization({
      organizationId: invitation.organizationId,
    });
    await client.organizations.revokeOrganizationInvitation({
      organizationId: invitation.organizationId,
      invitationId: invitation.id,
      requestingUserId: organization.createdBy ?? userId,
    });
    await mirrorDeleteInvitation(invitation.organizationId, invitation.id);
    return { ok: true };
  } catch (error) {
    logServerError("dashboard.decline_invitation_failed", error, { userId });
    return { error: "failed" };
  }
}

export async function removeMember(input: { memberUserId: string }): Promise<MemberActionResult> {
  const { userId, orgId, orgRole } = await auth();
  if (!userId || !orgId) {
    return { error: "unauthenticated" };
  }
  if (orgRole !== "org:admin") {
    return { error: "forbidden" };
  }
  if (input.memberUserId === userId) {
    return { error: "cannot-remove-self" };
  }

  try {
    const client = await clerkClient();
    const organization = await client.organizations.getOrganization({ organizationId: orgId });
    if (input.memberUserId === organization.createdBy) {
      return { error: "cannot-remove-owner" };
    }
    await client.organizations.deleteOrganizationMembership({
      organizationId: orgId,
      userId: input.memberUserId,
    });
    await mirrorDeleteMember(orgId, input.memberUserId);
    await revokeAllProjectAccessForUser(orgId, input.memberUserId);
    await revokeUserSessions(client, input.memberUserId);
    return { ok: true };
  } catch (error) {
    logServerError("dashboard.remove_member_failed", error, { clerkOrgId: orgId, userId });
    return { error: "failed" };
  }
}
