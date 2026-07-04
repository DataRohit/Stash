import { auth } from "@clerk/nextjs/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

export type OrgDetails = {
  description: string;
  tags: string[];
};

const EMPTY_DETAILS: OrgDetails = { description: "", tags: [] };

async function authedClient(): Promise<ConvexHttpClient | null> {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) {
    return null;
  }
  const { getToken } = await auth();
  const token = await getToken({ template: "convex" });
  const client = new ConvexHttpClient(url);
  if (token) {
    client.setAuth(token);
  }
  return client;
}

export async function fetchOrgDetails(clerkOrgId: string): Promise<OrgDetails> {
  try {
    const client = await authedClient();
    if (!client) {
      return EMPTY_DETAILS;
    }
    const result = await client.query(api.organizations.get, { clerkOrgId });
    return result ?? EMPTY_DETAILS;
  } catch {
    return EMPTY_DETAILS;
  }
}

export async function saveOrgDetails(
  clerkOrgId: string,
  description: string,
  tags: string[],
): Promise<void> {
  const client = await authedClient();
  if (!client) {
    throw new Error("Convex is not configured");
  }
  await client.mutation(api.organizations.upsertDetails, { clerkOrgId, description, tags });
}

export async function removeOrgDetails(clerkOrgId: string): Promise<void> {
  const client = await authedClient();
  if (!client) {
    return;
  }
  await client.mutation(api.organizations.remove, { clerkOrgId });
}

type ReconcileMember = {
  memberUserId: string;
  email: string;
  role: string;
  firstName: string | null;
  lastName: string | null;
  imageUrl: string | null;
};

type ReconcilePending = {
  clerkInvitationId: string;
  email: string;
  role: string;
};

export async function reconcileOrgMembers(
  clerkOrgId: string,
  ownerUserId: string,
  members: ReconcileMember[],
  pendingInvites: ReconcilePending[],
): Promise<void> {
  const client = await authedClient();
  if (!client) {
    return;
  }
  await client.mutation(api.members.reconcile, {
    clerkOrgId,
    ownerUserId,
    members,
    pendingInvites,
  });
}

export async function mirrorUpsertPending(
  clerkOrgId: string,
  email: string,
  role: string,
  clerkInvitationId: string,
): Promise<void> {
  const client = await authedClient();
  if (!client) {
    return;
  }
  await client.mutation(api.members.upsertPending, {
    clerkOrgId,
    email,
    role,
    clerkInvitationId,
  });
}

export async function mirrorDeleteInvitation(
  clerkOrgId: string,
  clerkInvitationId: string,
): Promise<void> {
  const client = await authedClient();
  if (!client) {
    return;
  }
  await client.mutation(api.members.deleteByInvitationId, { clerkOrgId, clerkInvitationId });
}

export async function mirrorDeleteMember(clerkOrgId: string, memberUserId: string): Promise<void> {
  const client = await authedClient();
  if (!client) {
    return;
  }
  await client.mutation(api.members.deleteByUserId, { clerkOrgId, memberUserId });
}

export async function deleteAllOrgMembers(clerkOrgId: string): Promise<void> {
  const client = await authedClient();
  if (!client) {
    return;
  }
  await client.mutation(api.members.deleteAllByOrg, { clerkOrgId });
}

export async function countOrgProjects(clerkOrgId: string): Promise<number> {
  const client = await authedClient();
  if (!client) {
    return 0;
  }
  return await client.query(api.projects.countByOrg, { clerkOrgId });
}

export async function createProjectDoc(
  clerkOrgId: string,
  title: string,
  description: string,
  tags: string[],
): Promise<Id<"projects">> {
  const client = await authedClient();
  if (!client) {
    throw new Error("Convex is not configured");
  }
  return await client.mutation(api.projects.create, { clerkOrgId, title, description, tags });
}

export async function fetchProject(projectId: string) {
  try {
    const client = await authedClient();
    if (!client) {
      return null;
    }
    return await client.query(api.projects.get, { projectId: projectId as Id<"projects"> });
  } catch {
    return null;
  }
}

export async function deleteAllOrgProjects(clerkOrgId: string): Promise<void> {
  const client = await authedClient();
  if (!client) {
    return;
  }
  await client.mutation(api.projects.deleteAllByOrg, { clerkOrgId });
}

export async function revokeAllProjectAccessForUser(
  clerkOrgId: string,
  userId: string,
): Promise<void> {
  const client = await authedClient();
  if (!client) {
    return;
  }
  await client.mutation(api.projects.revokeAllAccessForUser, { clerkOrgId, userId });
}

export async function setProjectMaxSize(projectId: string, maxSizeBytes: number): Promise<void> {
  const client = await authedClient();
  if (!client) {
    return;
  }
  await client.mutation(api.documents.setMaxSize, {
    projectId: projectId as Id<"projects">,
    maxSizeBytes,
  });
}
