"use server";

import { auth, clerkClient } from "@clerk/nextjs/server";
import {
  deleteAllOrgMembers,
  deleteAllOrgProjects,
  removeOrgDetails,
  saveOrgDetails,
} from "@/lib/convex-server";
import { MAX_IMAGE_BYTES, MAX_TAGS, MIN_ORG_NAME_LENGTH, sanitizeTags } from "@/lib/org";
import { fetchOrgAvatarFile } from "@/lib/org-avatar";

export type UpdateOrganizationInput = {
  name: string;
  description: string;
  tags: string[];
};

export type UpdateOrganizationResult = { ok: true } | { error: string };
export type DeleteOrganizationResult = { nextOrgId: string } | { error: string };
export type LogoResult = { ok: true } | { error: string };

export async function updateOrganization(
  input: UpdateOrganizationInput,
): Promise<UpdateOrganizationResult> {
  const { userId, orgId, orgRole } = await auth();
  if (!userId || !orgId) {
    return { error: "unauthenticated" };
  }
  if (orgRole !== "org:admin") {
    return { error: "forbidden" };
  }

  const name = input.name.trim();
  if (name.length < MIN_ORG_NAME_LENGTH) {
    return { error: "invalid-name" };
  }

  const tags = sanitizeTags(input.tags);
  if (tags.length > MAX_TAGS) {
    return { error: "too-many-tags" };
  }

  const client = await clerkClient();
  const memberships = await client.users.getOrganizationMembershipList({ userId });
  const duplicate = memberships.data.some(
    (membership) =>
      membership.organization.id !== orgId &&
      membership.organization.name.trim().toLowerCase() === name.toLowerCase(),
  );
  if (duplicate) {
    return { error: "duplicate-name" };
  }

  try {
    await client.organizations.updateOrganization(orgId, { name });
    await saveOrgDetails(orgId, input.description, tags);
    return { ok: true };
  } catch {
    return { error: "failed" };
  }
}

export async function deleteOrganization(): Promise<DeleteOrganizationResult> {
  const { userId, orgId, orgRole } = await auth();
  if (!userId || !orgId) {
    return { error: "unauthenticated" };
  }
  if (orgRole !== "org:admin") {
    return { error: "forbidden" };
  }

  const client = await clerkClient();
  const memberships = await client.users.getOrganizationMembershipList({ userId, limit: 100 });
  const current = memberships.data.find((membership) => membership.organization.id === orgId);
  const isOwner = current?.organization.createdBy === userId;
  const otherMemberships = memberships.data.filter(
    (membership) => membership.organization.id !== orgId,
  );
  const ownedOthers = otherMemberships.filter(
    (membership) => membership.organization.createdBy === userId,
  );

  if (isOwner && ownedOthers.length === 0) {
    return { error: "last-owned-org" };
  }
  const next = ownedOthers[0] ?? otherMemberships[0];
  if (!next) {
    return { error: "last-org" };
  }

  try {
    await deleteAllOrgMembers(orgId);
    await deleteAllOrgProjects(orgId);
    await client.organizations.deleteOrganization(orgId);
    await removeOrgDetails(orgId);
    return { nextOrgId: next.organization.id };
  } catch {
    return { error: "failed" };
  }
}

export async function updateOrganizationLogo(formData: FormData): Promise<LogoResult> {
  const { userId, orgId, orgRole } = await auth();
  if (!userId || !orgId) {
    return { error: "unauthenticated" };
  }
  if (orgRole !== "org:admin") {
    return { error: "forbidden" };
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "invalid" };
  }
  if (!file.type.startsWith("image/")) {
    return { error: "invalid-type" };
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return { error: "too-large" };
  }

  try {
    const client = await clerkClient();
    await client.organizations.updateOrganizationLogo(orgId, { file, uploaderUserId: userId });
    return { ok: true };
  } catch {
    return { error: "failed" };
  }
}

export async function resetOrganizationLogo(): Promise<LogoResult> {
  const { userId, orgId, orgRole } = await auth();
  if (!userId || !orgId) {
    return { error: "unauthenticated" };
  }
  if (orgRole !== "org:admin") {
    return { error: "forbidden" };
  }

  try {
    const client = await clerkClient();
    const file = await fetchOrgAvatarFile(orgId);
    await client.organizations.updateOrganizationLogo(orgId, { file, uploaderUserId: userId });
    return { ok: true };
  } catch {
    return { error: "failed" };
  }
}
