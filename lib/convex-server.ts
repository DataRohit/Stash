import { createHash } from "node:crypto";
import { auth } from "@clerk/nextjs/server";
import { ConvexHttpClient } from "convex/browser";
import { cache } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { logServerError } from "@/lib/server-log";

export type OrgDetails = {
  description: string;
  tags: string[];
  publicSharingEnabled: boolean;
};

const EMPTY_DETAILS: OrgDetails = { description: "", tags: [], publicSharingEnabled: true };
const SHARE_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const MAX_SHARE_RATE_ID_LENGTH = 128;
const CONVEX_TOKEN_REFRESH_BUFFER_MS = 5_000;
const CONVEX_TOKEN_FALLBACK_LIFETIME_MS = 30_000;
const CONVEX_TOKEN_ERROR_GRACE_MS = 1_000;
const MAX_CACHED_CONVEX_TOKENS = 256;

type CachedConvexToken = {
  token: string;
  expiresAt: number;
};

const cachedConvexTokens = new Map<string, CachedConvexToken>();
const pendingConvexTokens = new Map<string, Promise<string | null>>();

function convexTokenExpiresAt(token: string, now: number): number {
  const payload = token.split(".")[1];
  if (!payload) {
    return now + CONVEX_TOKEN_FALLBACK_LIFETIME_MS;
  }
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    if (typeof claims.exp === "number" && Number.isFinite(claims.exp)) {
      return Math.max(now, claims.exp * 1_000);
    }
  } catch {
    return now + CONVEX_TOKEN_FALLBACK_LIFETIME_MS;
  }
  return now + CONVEX_TOKEN_FALLBACK_LIFETIME_MS;
}

function storeConvexToken(cacheKey: string, token: string, now: number): void {
  for (const [key, cached] of cachedConvexTokens) {
    if (cached.expiresAt <= now) {
      cachedConvexTokens.delete(key);
    }
  }
  while (cachedConvexTokens.size >= MAX_CACHED_CONVEX_TOKENS) {
    const oldestKey = cachedConvexTokens.keys().next().value;
    if (typeof oldestKey !== "string") {
      break;
    }
    cachedConvexTokens.delete(oldestKey);
  }
  cachedConvexTokens.set(cacheKey, {
    token,
    expiresAt: convexTokenExpiresAt(token, now),
  });
}

async function getCachedConvexToken(
  cacheKey: string,
  loadToken: () => Promise<string | null>,
): Promise<string | null> {
  const now = Date.now();
  const cached = cachedConvexTokens.get(cacheKey);
  if (cached && cached.expiresAt > now + CONVEX_TOKEN_REFRESH_BUFFER_MS) {
    cachedConvexTokens.delete(cacheKey);
    cachedConvexTokens.set(cacheKey, cached);
    return cached.token;
  }
  const pending = pendingConvexTokens.get(cacheKey);
  if (pending) {
    return await pending;
  }
  const request = loadToken()
    .then((token) => {
      if (!token) {
        cachedConvexTokens.delete(cacheKey);
        return null;
      }
      storeConvexToken(cacheKey, token, Date.now());
      return token;
    })
    .catch((error: unknown) => {
      const stale = cachedConvexTokens.get(cacheKey);
      if (stale && stale.expiresAt > Date.now() + CONVEX_TOKEN_ERROR_GRACE_MS) {
        return stale.token;
      }
      throw error;
    })
    .finally(() => {
      pendingConvexTokens.delete(cacheKey);
    });
  pendingConvexTokens.set(cacheKey, request);
  return await request;
}

const convexToken = cache(async (): Promise<string | null> => {
  const { getToken, isAuthenticated, orgId, orgRole, sessionClaims, sessionId, userId } =
    await auth();
  if (!isAuthenticated || !sessionId || !userId) {
    return null;
  }
  const cacheKey = JSON.stringify([sessionId, userId, orgId, orgRole, sessionClaims.iat]);
  return await getCachedConvexToken(cacheKey, () => getToken({ template: "convex" }));
});

async function authedClient(): Promise<ConvexHttpClient | null> {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) {
    return null;
  }
  const token = await convexToken();
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
  } catch (error) {
    logServerError("convex.fetch_org_details", error, { clerkOrgId });
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

export async function setOrgPublicSharing(clerkOrgId: string, enabled: boolean): Promise<void> {
  const client = await authedClient();
  if (!client) {
    throw new Error("Convex is not configured");
  }
  await client.mutation(api.organizations.setPublicSharing, { clerkOrgId, enabled });
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
  const secret = process.env.CONVEX_PURGE_SECRET;
  const client = await authedClient();
  if (!client || !secret) {
    throw new Error("Convex member reconciliation is not configured");
  }
  await client.mutation(api.members.reconcile, {
    secret,
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
    throw new Error("Convex is not configured");
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
    throw new Error("Convex is not configured");
  }
  await client.mutation(api.members.deleteByInvitationId, { clerkOrgId, clerkInvitationId });
}

export async function mirrorDeleteMember(clerkOrgId: string, memberUserId: string): Promise<void> {
  const client = await authedClient();
  if (!client) {
    throw new Error("Convex is not configured");
  }
  await client.mutation(api.members.deleteByUserId, { clerkOrgId, memberUserId });
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

export async function fetchSharedDocument(token: string, ip: string) {
  if (!SHARE_TOKEN_PATTERN.test(token)) {
    return null;
  }
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  const secret = process.env.CONVEX_PURGE_SECRET;
  const salt = process.env.SHARE_IP_SALT;
  if (!url || !secret || !salt) {
    return { status: "unconfigured" as const };
  }
  const rateId = ip.slice(0, MAX_SHARE_RATE_ID_LENGTH);
  const rateKey = createHash("sha256").update(`${rateId}\0${salt}`).digest("hex");
  const { userId, orgId, orgRole } = await auth();
  const client = new ConvexHttpClient(url);
  try {
    const rate = await client.mutation(api.sharing.checkShareRate, { secret, rateKey });
    if (rate.limited) return { status: "rate-limited" as const };
    return await client.query(api.sharing.redeemShare, {
      secret,
      token,
      viewerUserId: userId ?? undefined,
      viewerOrgId: orgId ?? undefined,
      viewerOrgRole: orgRole ?? undefined,
    });
  } catch (error) {
    logServerError("convex.fetch_shared_document", error);
    return { status: "error" as const };
  }
}

export async function fetchSharedProject(
  token: string,
  documentId: string | undefined,
  treeCursor: string | undefined,
  ip: string,
) {
  if (!SHARE_TOKEN_PATTERN.test(token)) return null;
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  const secret = process.env.CONVEX_PURGE_SECRET;
  const salt = process.env.SHARE_IP_SALT;
  if (!url || !secret || !salt) return { status: "unconfigured" as const };
  const rateId = `${ip.slice(0, MAX_SHARE_RATE_ID_LENGTH)}\0project`;
  const rateKey = createHash("sha256").update(`${rateId}\0${salt}`).digest("hex");
  const { userId, orgId, orgRole } = await auth();
  const client = new ConvexHttpClient(url);
  try {
    const rate = await client.mutation(api.sharing.checkShareRate, { secret, rateKey });
    if (rate.limited) return { status: "rate-limited" as const };
    return await client.query(api.projectSharing.redeem, {
      secret,
      token,
      documentId: documentId as Id<"documents"> | undefined,
      treeCursor,
      viewerUserId: userId ?? undefined,
      viewerOrgId: orgId ?? undefined,
      viewerOrgRole: orgRole ?? undefined,
    });
  } catch (error) {
    logServerError("convex.fetch_shared_project", error);
    return { status: "error" as const };
  }
}

export async function fetchProject(projectId: string) {
  const client = await authedClient();
  if (!client) {
    return null;
  }
  return await client.query(api.projects.get, {
    projectId: projectId as Id<"projects">,
  });
}

export async function setOrgPlanLimits(
  clerkOrgId: string,
  limits: {
    maxProjects: number;
    maxCollaborators: number;
    maxGuests?: number;
    maxSizeBytes: number;
    historyRetentionDays: number;
  },
): Promise<void> {
  const secret = process.env.CONVEX_PURGE_SECRET;
  const client = await authedClient();
  if (!client || !secret) {
    throw new Error("Convex plan synchronization is not configured");
  }
  await client.mutation(api.organizations.setPlanLimits, {
    secret,
    clerkOrgId,
    maxProjects: limits.maxProjects,
    maxCollaborators: limits.maxCollaborators,
    maxGuests: limits.maxGuests,
    maxSizeBytes: limits.maxSizeBytes,
    historyRetentionDays: limits.historyRetentionDays,
  });
}

export async function webhookSetOrgPlanLimits(
  clerkOrgId: string,
  limits: {
    maxProjects: number;
    maxCollaborators: number;
    maxGuests?: number;
    maxSizeBytes: number;
    historyRetentionDays: number;
  },
): Promise<void> {
  const { client, secret } = webhookConvexClient();
  await client.mutation(api.organizations.setPlanLimits, { clerkOrgId, secret, ...limits });
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

export async function webhookDeleteUser(memberUserId: string): Promise<void> {
  const { client, secret } = webhookConvexClient();
  await client.mutation(api.members.webhookDeleteUser, { memberUserId, secret });
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

export async function recordTrustedOrgEvent(input: {
  clerkOrgId: string;
  actorUserId: string | null;
  actorName: string;
  kind: string;
  targetId?: string;
  targetName: string;
  metadata?: string;
}): Promise<void> {
  const { client, secret } = webhookConvexClient();
  await client.mutation(api.audit.recordTrusted, { ...input, secret });
}

export async function fetchAuditExport(
  clerkOrgId: string,
  filters: {
    kind?: string;
    actorUserId?: string;
    projectId?: string;
    from?: number;
    to?: number;
  } = {},
) {
  const client = await authedClient();
  if (!client) throw new Error("Unauthenticated");
  const items: Array<{
    id: string;
    actorUserId: string | null;
    actorName: string;
    kind: string;
    projectId?: string;
    projectName?: string;
    targetId?: string;
    targetName: string;
    metadata?: string;
    createdAt: number;
  }> = [];
  let cursor: string | null = null;
  for (let pageNumber = 0; pageNumber < 50; pageNumber += 1) {
    const page: {
      items: typeof items;
      nextCursor: string | null;
    } = await client.query(api.audit.list, {
      clerkOrgId,
      cursor,
      limit: 100,
      kind: filters.kind,
      actorUserId: filters.actorUserId,
      projectId: filters.projectId as Id<"projects"> | undefined,
      from: filters.from,
      to: filters.to,
    });
    items.push(...page.items);
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  return { items, truncated: cursor !== null };
}

export async function fetchOrganizationExportUrl(
  clerkOrgId: string,
  jobId: string,
  fileName: string,
): Promise<string | null> {
  const client = await authedClient();
  if (!client) throw new Error("Unauthenticated");
  return await client.query(api.organizationExports.downloadUrl, {
    clerkOrgId,
    jobId: jobId as Id<"organizationExports">,
    fileName,
  });
}

export async function claimReconcile(clerkOrgId: string, staleMs: number): Promise<boolean> {
  try {
    const client = await authedClient();
    if (!client) {
      return false;
    }
    return await client.mutation(api.organizations.claimReconcile, { clerkOrgId, staleMs });
  } catch (error) {
    logServerError("convex.claim_reconcile", error, { clerkOrgId });
    return false;
  }
}

export async function revokeAllProjectAccessForUser(
  clerkOrgId: string,
  userId: string,
): Promise<void> {
  const client = await authedClient();
  if (!client) {
    throw new Error("Convex is not configured");
  }
  await client.mutation(api.projects.revokeAllAccessForUser, { clerkOrgId, userId });
}

export async function setProjectMaxSize(projectId: string, maxSizeBytes: number): Promise<void> {
  const client = await authedClient();
  if (!client) {
    throw new Error("Convex is not configured");
  }
  await client.mutation(api.documents.setMaxSize, {
    projectId: projectId as Id<"projects">,
    maxSizeBytes,
  });
}

export async function setProjectMaxCollaborators(
  projectId: string,
  maxCollaborators: number,
): Promise<void> {
  const client = await authedClient();
  if (!client) {
    throw new Error("Convex is not configured");
  }
  await client.mutation(api.projects.setMaxCollaborators, {
    projectId: projectId as Id<"projects">,
    maxCollaborators,
  });
}

export async function registerGuestInvitation(input: {
  projectId: string;
  email: string;
  clerkInvitationId: string;
  level: "viewer" | "editor";
}): Promise<void> {
  const client = await authedClient();
  if (!client) throw new Error("Convex is not configured");
  await client.mutation(api.guests.registerInvitation, {
    ...input,
    projectId: input.projectId as Id<"projects">,
  });
}

export async function cancelGuestInvitation(
  projectId: string,
  clerkInvitationId: string,
): Promise<void> {
  const client = await authedClient();
  if (!client) throw new Error("Convex is not configured");
  await client.mutation(api.guests.cancelInvitation, {
    projectId: projectId as Id<"projects">,
    clerkInvitationId,
  });
}

export async function unsubscribeNotificationEmail(input: {
  userId: string;
  clerkOrgId: string;
  kind: "mention" | "reply" | "resolved" | "reopened" | "watching" | "digest";
}): Promise<void> {
  const secret = process.env.CONVEX_PURGE_SECRET;
  const client = convexClient();
  if (!client || !secret) throw new Error("Convex email preferences are not configured");
  await client.mutation(api.email.unsubscribeWithSecret, { ...input, secret });
}
