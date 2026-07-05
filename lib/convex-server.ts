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

function convexClient(): ConvexHttpClient | null {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) {
    return null;
  }
  return new ConvexHttpClient(url);
}

export async function leaveDocumentPresence(documentId: string, sessionId: string): Promise<void> {
  const client = await authedClient();
  if (!client) {
    throw new Error("unauthenticated");
  }
  await client.mutation(api.presence.leave, {
    documentId: documentId as Id<"documents">,
    sessionId,
  });
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
  maxProjects: number,
): Promise<Id<"projects">> {
  const client = await authedClient();
  if (!client) {
    throw new Error("Convex is not configured");
  }
  return await client.mutation(api.projects.create, {
    clerkOrgId,
    title,
    description,
    tags,
    maxProjects,
  });
}

export async function fetchProject(projectId: string) {
  const client = await authedClient();
  if (!client) {
    return null;
  }
  return await client.query(api.projects.get, { projectId: projectId as Id<"projects"> });
}

export async function setOrgPlanLimits(
  clerkOrgId: string,
  limits: {
    maxProjects: number;
    maxCollaborators: number;
    maxSizeBytes: number;
  },
): Promise<void> {
  try {
    const client = await authedClient();
    if (!client) {
      return;
    }
    await client.mutation(api.organizations.setPlanLimits, {
      clerkOrgId,
      maxProjects: limits.maxProjects,
      maxCollaborators: limits.maxCollaborators,
      maxSizeBytes: limits.maxSizeBytes,
    });
  } catch {
    return;
  }
}

export async function purgeDeletedOrganization(clerkOrgId: string): Promise<void> {
  const secret = process.env.CONVEX_PURGE_SECRET;
  const client = convexClient();
  if (!client || !secret) {
    throw new Error("Convex purge is not configured");
  }
  await client.mutation(api.organizations.purgeDeletedOrg, { clerkOrgId, secret });
}

function webhookConvexClient(): { client: ConvexHttpClient; secret: string } {
  const secret = process.env.CONVEX_PURGE_SECRET;
  const client = convexClient();
  if (!client || !secret) {
    throw new Error("Convex webhook sync is not configured");
  }
  return { client, secret };
}

export async function webhookUpsertAcceptedMember(input: {
  clerkOrgId: string;
  ownerUserId: string;
  memberUserId: string;
  email: string;
  role: string;
  firstName: string | null;
  lastName: string | null;
  imageUrl: string | null;
}): Promise<void> {
  const { client, secret } = webhookConvexClient();
  await client.mutation(api.members.webhookUpsertMember, { ...input, secret });
}

export async function webhookDeleteAcceptedMember(
  clerkOrgId: string,
  memberUserId: string,
): Promise<void> {
  const { client, secret } = webhookConvexClient();
  await client.mutation(api.members.webhookDeleteMember, { clerkOrgId, memberUserId, secret });
}

export async function webhookUpsertPendingInvitation(input: {
  clerkOrgId: string;
  email: string;
  role: string;
  clerkInvitationId: string;
}): Promise<void> {
  const { client, secret } = webhookConvexClient();
  await client.mutation(api.members.webhookUpsertInvitation, { ...input, secret });
}

export async function webhookDeleteInvitation(
  clerkOrgId: string,
  clerkInvitationId: string,
): Promise<void> {
  const { client, secret } = webhookConvexClient();
  await client.mutation(api.members.webhookDeleteInvitation, {
    clerkOrgId,
    clerkInvitationId,
    secret,
  });
}

export async function claimReconcile(clerkOrgId: string, staleMs: number): Promise<boolean> {
  try {
    const client = await authedClient();
    if (!client) {
      return false;
    }
    return await client.mutation(api.organizations.claimReconcile, { clerkOrgId, staleMs });
  } catch {
    return false;
  }
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
  try {
    const client = await authedClient();
    if (!client) {
      return;
    }
    await client.mutation(api.documents.setMaxSize, {
      projectId: projectId as Id<"projects">,
      maxSizeBytes,
    });
  } catch {
    return;
  }
}

export async function setProjectMaxCollaborators(
  projectId: string,
  maxCollaborators: number,
): Promise<void> {
  try {
    const client = await authedClient();
    if (!client) {
      return;
    }
    await client.mutation(api.projects.setMaxCollaborators, {
      projectId: projectId as Id<"projects">,
      maxCollaborators,
    });
  } catch {
    return;
  }
}
