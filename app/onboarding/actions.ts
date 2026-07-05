"use server";

import { auth, clerkClient } from "@clerk/nextjs/server";
import { fetchOrgAvatarFile } from "@/lib/org-avatar";
import { getUserPlanLimits } from "@/lib/plan-limits";

export type CreateOrganizationResult =
  | { id: string }
  | { error: "unauthenticated" | "invalid" | "duplicate" | "limit" | "failed" };

type ClerkClient = Awaited<ReturnType<typeof clerkClient>>;

async function ownedMemberships(client: ClerkClient, userId: string) {
  const memberships = await client.users.getOrganizationMembershipList({ userId, limit: 100 });
  return memberships.data.filter((membership) => membership.organization.createdBy === userId);
}

export async function createOrganization(name: string): Promise<CreateOrganizationResult> {
  const { userId } = await auth();
  if (!userId) {
    return { error: "unauthenticated" };
  }

  const trimmed = name.trim();
  if (trimmed.length < 2) {
    return { error: "invalid" };
  }

  const { maxOrganizations } = await getUserPlanLimits();
  const client = await clerkClient();
  const owned = await ownedMemberships(client, userId);

  if (owned.length >= maxOrganizations) {
    return { error: "limit" };
  }

  const duplicate = owned.some(
    (membership) => membership.organization.name.trim().toLowerCase() === trimmed.toLowerCase(),
  );
  if (duplicate) {
    return { error: "duplicate" };
  }

  try {
    const organization = await client.organizations.createOrganization({
      name: trimmed,
      createdBy: userId,
    });
    const latestOwned = await ownedMemberships(client, userId);
    const normalizedName = trimmed.toLowerCase();
    const duplicateAfterCreate = latestOwned.some(
      (membership) =>
        membership.organization.id !== organization.id &&
        membership.organization.name.trim().toLowerCase() === normalizedName,
    );
    if (latestOwned.length > maxOrganizations || duplicateAfterCreate) {
      await client.organizations.deleteOrganization(organization.id).catch(() => null);
      return { error: duplicateAfterCreate ? "duplicate" : "limit" };
    }
    const file = await fetchOrgAvatarFile(organization.id).catch(() => null);
    if (file) {
      await client.organizations
        .updateOrganizationLogo(organization.id, { file, uploaderUserId: userId })
        .catch(() => null);
    }
    return { id: organization.id };
  } catch {
    return { error: "failed" };
  }
}
