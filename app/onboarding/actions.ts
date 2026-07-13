"use server";

import { auth, clerkClient } from "@clerk/nextjs/server";
import { fetchOrgAvatarFile } from "@/lib/org-avatar-server";
import { getUserPlanLimits } from "@/lib/plan-limits";
import { logServerError } from "@/lib/server-log";

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
      try {
        await client.organizations.deleteOrganization(organization.id);
      } catch (error) {
        logServerError("onboarding.organization_rollback_failed", error, { userId });
      }
      return { error: duplicateAfterCreate ? "duplicate" : "limit" };
    }
    let file: File | null = null;
    try {
      file = await fetchOrgAvatarFile(organization.id);
    } catch (error) {
      logServerError("onboarding.organization_avatar_failed", error, { userId });
    }
    if (file) {
      try {
        await client.organizations.updateOrganizationLogo(organization.id, {
          file,
          uploaderUserId: userId,
        });
      } catch (error) {
        logServerError("onboarding.organization_logo_failed", error, { userId });
      }
    }
    return { id: organization.id };
  } catch (error) {
    logServerError("onboarding.create_organization_failed", error, { userId });
    return { error: "failed" };
  }
}
