import { v } from "convex/values";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { recordOrganizationEvent } from "./audit";
import { isOrganizationAdmin } from "./auth";
import { secretMatches } from "./secrets";
import { enforceWriteRateLimit } from "./writeRateLimit";

const KEY_PATTERN = /^stash_v1_[a-f0-9]{64}$/;
const ALLOWED_SCOPES = new Set([
  "projects:read",
  "documents:read",
  "documents:write",
  "properties:write",
]);

async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function requireAdmin(ctx: QueryCtx, clerkOrgId: string) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity || !isOrganizationAdmin(identity, clerkOrgId)) {
    throw new Error("Forbidden");
  }
  return identity;
}

function normalizeScopes(scopes: string[]): string[] {
  return [...new Set(scopes.filter((scope) => ALLOWED_SCOPES.has(scope)))].sort();
}

export const create = mutation({
  args: { clerkOrgId: v.string(), name: v.string(), scopes: v.array(v.string()) },
  handler: async (ctx, args) => {
    const identity = await requireAdmin(ctx, args.clerkOrgId);
    const name = args.name.trim().slice(0, 80);
    const scopes = normalizeScopes(args.scopes);
    if (!name) throw new Error("invalid-name");
    if (scopes.length === 0) throw new Error("invalid-scopes");
    const existing = await ctx.db
      .query("apiKeys")
      .withIndex("by_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .take(101);
    if (existing.filter((key) => !key.revokedAt).length >= 100) throw new Error("key-limit");
    const rawKey = `stash_v1_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
    const now = Date.now();
    const id = await ctx.db.insert("apiKeys", {
      clerkOrgId: args.clerkOrgId,
      name,
      keyHash: await digest(rawKey),
      keyPrefix: rawKey.slice(0, 20),
      scopes,
      createdBy: identity.subject,
      createdAt: now,
    });
    await recordOrganizationEvent(ctx, {
      clerkOrgId: args.clerkOrgId,
      actorUserId: identity.subject,
      actorName: identity.name ?? identity.email ?? identity.subject,
      kind: "api_key.created",
      targetId: id,
      targetName: name,
      metadata: JSON.stringify({ scopes }),
    });
    return { id, key: rawKey };
  },
});

export const list = query({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.clerkOrgId);
    return (
      await ctx.db
        .query("apiKeys")
        .withIndex("by_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
        .order("desc")
        .take(100)
    ).map((key) => ({
      id: key._id,
      name: key.name,
      prefix: key.keyPrefix,
      scopes: key.scopes,
      createdAt: key.createdAt,
      lastUsedAt: key.lastUsedAt,
      revokedAt: key.revokedAt,
    }));
  },
});

export const revoke = mutation({
  args: { clerkOrgId: v.string(), keyId: v.id("apiKeys") },
  handler: async (ctx, args) => {
    const identity = await requireAdmin(ctx, args.clerkOrgId);
    const key = await ctx.db.get(args.keyId);
    if (!key || key.clerkOrgId !== args.clerkOrgId) return false;
    if (!key.revokedAt) await ctx.db.patch(key._id, { revokedAt: Date.now() });
    await recordOrganizationEvent(ctx, {
      clerkOrgId: args.clerkOrgId,
      actorUserId: identity.subject,
      actorName: identity.name ?? identity.email ?? identity.subject,
      kind: "api_key.revoked",
      targetId: key._id,
      targetName: key.name,
    });
    return true;
  },
});

export const authorize = mutation({
  args: { secret: v.string(), key: v.string(), requiredScope: v.string() },
  handler: async (ctx: MutationCtx, args) => {
    if (!secretMatches(args.secret, process.env.CONVEX_PURGE_SECRET)) throw new Error("Forbidden");
    if (!KEY_PATTERN.test(args.key) || !ALLOWED_SCOPES.has(args.requiredScope)) return null;
    const keyHash = await digest(args.key);
    const key = await ctx.db
      .query("apiKeys")
      .withIndex("by_hash", (q) => q.eq("keyHash", keyHash))
      .unique();
    if (!key || key.revokedAt || !key.scopes.includes(args.requiredScope)) return null;
    const allowed = await enforceWriteRateLimit(ctx, "api", key._id, key._id, {
      capacity: 120,
      refillPerSecond: 2,
    });
    if (!allowed) return { rateLimited: true as const };
    const now = Date.now();
    if (!key.lastUsedAt || now - key.lastUsedAt > 60_000) {
      await ctx.db.patch(key._id, { lastUsedAt: now });
    }
    return {
      rateLimited: false as const,
      keyId: key._id,
      clerkOrgId: key.clerkOrgId,
      scopes: key.scopes,
    };
  },
});
