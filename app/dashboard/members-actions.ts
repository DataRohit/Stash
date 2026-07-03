"use server";

import { auth, clerkClient } from "@clerk/nextjs/server";
import {
  mirrorDeleteInvitation,
  mirrorDeleteMember,
  mirrorUpsertPending,
  reconcileOrgMembers,
} from "@/lib/convex-server";
import { getUserPlanLimits } from "@/lib/plan-limits";

type ClerkClient = Awaited<ReturnType<typeof clerkClient>>;

export type MemberRole = "org:admin" | "org:member";
export type MemberActionResult = { ok: true } | { error: string };

const ALLOWED_ROLES: MemberRole[] = ["org:admin", "org:member"];
const PAGE_SIZE = 100;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

export async function reconcileMembers(): Promise<MemberActionResult> {
  const { userId, orgId } = await auth();
  if (!userId || !orgId) {
    return { error: "unauthenticated" };
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
  } catch {
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
    if (members.some((member) => member.publicUserData?.identifier?.toLowerCase() === email)) {
      return { error: "already-member" };
    }
    if (pending.some((invite) => invite.emailAddress.toLowerCase() === email)) {
      return { error: "already-invited" };
    }
    if (matchingUsers.totalCount === 0) {
      return { error: "no-account" };
    }

    const invitation = await client.organizations.createOrganizationInvitation({
      organizationId: orgId,
      inviterUserId: userId,
      emailAddress: email,
      role,
    });
    await mirrorUpsertPending(orgId, email, role, invitation.id);
    return { ok: true };
  } catch {
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
  } catch {
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
  } catch {
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
    return { ok: true };
  } catch {
    return { error: "failed" };
  }
}
