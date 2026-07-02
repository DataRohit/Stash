"use server";

import { auth, clerkClient } from "@clerk/nextjs/server";
import { fetchOrgAvatarFile } from "@/lib/org-avatar";
import { getUserPlanLimits } from "@/lib/plan-limits";

export type CreateOrganizationResult =
  | { id: string }
  | { error: "unauthenticated" | "invalid" | "duplicate" | "limit" | "failed" };

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
  const memberships = await client.users.getOrganizationMembershipList({ userId });

  if (memberships.totalCount >= maxOrganizations) {
    return { error: "limit" };
  }

  const duplicate = memberships.data.some(
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
