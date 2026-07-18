import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { recordOrganizationEvent } from "./audit";

const EVENT_KINDS = new Set([
  "document.created",
  "comment.created",
  "project_share.changed",
  "member.joined",
  "member.left",
  "guest.joined",
]);
const MAX_ENDPOINTS = 25;
const MAX_ATTEMPTS = 8;
const DELIVERY_BATCH = 20;
const LEASE_MS = 30_000;
const REQUEST_TIMEOUT_MS = 8_000;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer as ArrayBuffer;
}

function encryptionKey(): Uint8Array {
  const value = process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
  if (!value) throw new Error("webhook-encryption-unconfigured");
  const bytes = base64ToBytes(value);
  if (bytes.length !== 32) throw new Error("webhook-encryption-invalid");
  return bytes;
}

async function encryptSecret(secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", exactBuffer(encryptionKey()), "AES-GCM", false, [
    "encrypt",
  ]);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(secret),
  );
  return `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(encrypted))}`;
}

async function decryptSecret(encryptedSecret: string): Promise<string> {
  const [ivValue, bodyValue] = encryptedSecret.split(".");
  if (!ivValue || !bodyValue) throw new Error("webhook-secret-invalid");
  const key = await crypto.subtle.importKey("raw", exactBuffer(encryptionKey()), "AES-GCM", false, [
    "decrypt",
  ]);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: exactBuffer(base64ToBytes(ivValue)) },
    key,
    exactBuffer(base64ToBytes(bodyValue)),
  );
  return new TextDecoder().decode(decrypted);
}

function validEndpointUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("invalid-url");
  if (url.port && url.port !== "443") throw new Error("invalid-url");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^(?:0|10|127|169\.254|172\.(?:1[6-9]|2\d|3[01])|192\.168)\./.test(host) ||
    host === "::1" ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("fe80:")
  ) {
    throw new Error("invalid-url");
  }
  url.hash = "";
  return url.toString().slice(0, 2_000);
}

function eventKinds(values: string[]): string[] {
  return [...new Set(values.filter((value) => EVENT_KINDS.has(value)))].slice(0, EVENT_KINDS.size);
}

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return Array.from(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export const createRecord = internalMutation({
  args: {
    clerkOrgId: v.string(),
    name: v.string(),
    url: v.string(),
    eventKinds: v.array(v.string()),
    encryptedSecret: v.string(),
    createdBy: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("webhookEndpoints")
      .withIndex("by_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .take(MAX_ENDPOINTS + 1);
    if (existing.filter((row) => !row.disabledAt).length >= MAX_ENDPOINTS) {
      throw new Error("endpoint-limit");
    }
    const now = Date.now();
    const id = await ctx.db.insert("webhookEndpoints", {
      clerkOrgId: args.clerkOrgId,
      name: args.name,
      url: args.url,
      encryptedSecret: args.encryptedSecret,
      eventKinds: args.eventKinds,
      createdBy: args.createdBy,
      failureCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    await recordOrganizationEvent(ctx, {
      clerkOrgId: args.clerkOrgId,
      actorUserId: args.createdBy,
      actorName: args.createdBy,
      kind: "webhook.created",
      targetId: id,
      targetName: args.name,
      metadata: JSON.stringify({ url: args.url, eventKinds: args.eventKinds }),
    });
    return id;
  },
});

export const create = action({
  args: {
    clerkOrgId: v.string(),
    name: v.string(),
    url: v.string(),
    eventKinds: v.array(v.string()),
  },
  handler: async (ctx, args): Promise<{ id: Id<"webhookEndpoints">; signingSecret: string }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || identity.org_id !== args.clerkOrgId || identity.org_role !== "org:admin") {
      throw new Error("Forbidden");
    }
    const name = args.name.trim().slice(0, 80);
    const kinds = eventKinds(args.eventKinds);
    if (!name || kinds.length === 0) throw new Error("invalid-endpoint");
    const signingSecret = `whsec_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
    const id = await ctx.runMutation(internal.webhooks.createRecord, {
      clerkOrgId: args.clerkOrgId,
      name,
      url: validEndpointUrl(args.url),
      eventKinds: kinds,
      encryptedSecret: await encryptSecret(signingSecret),
      createdBy: identity.subject,
    });
    return { id, signingSecret };
  },
});

export const list = query({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || identity.org_id !== args.clerkOrgId || identity.org_role !== "org:admin") {
      throw new Error("Forbidden");
    }
    const endpoints = await ctx.db
      .query("webhookEndpoints")
      .withIndex("by_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .order("desc")
      .take(MAX_ENDPOINTS);
    const result = [];
    for (const endpoint of endpoints) {
      const deliveries = await ctx.db
        .query("webhookDeliveries")
        .withIndex("by_endpoint_time", (q) => q.eq("endpointId", endpoint._id))
        .order("desc")
        .take(10);
      result.push({
        id: endpoint._id,
        name: endpoint.name,
        url: endpoint.url,
        eventKinds: endpoint.eventKinds,
        disabledAt: endpoint.disabledAt,
        failureCount: endpoint.failureCount,
        createdAt: endpoint.createdAt,
        deliveries: deliveries.map((delivery) => ({
          id: delivery._id,
          state: delivery.state,
          eventKind: delivery.eventKind,
          responseStatus: delivery.responseStatus,
          attemptCount: delivery.attemptCount,
          lastError: delivery.lastError,
          createdAt: delivery.createdAt,
          updatedAt: delivery.updatedAt,
        })),
      });
    }
    return result;
  },
});

export const setDisabled = mutation({
  args: { endpointId: v.id("webhookEndpoints"), disabled: v.boolean() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    const endpoint = await ctx.db.get(args.endpointId);
    if (
      !identity ||
      !endpoint ||
      identity.org_id !== endpoint.clerkOrgId ||
      identity.org_role !== "org:admin"
    )
      throw new Error("Forbidden");
    await ctx.db.patch(endpoint._id, {
      disabledAt: args.disabled ? Date.now() : undefined,
      failureCount: args.disabled ? endpoint.failureCount : 0,
      updatedAt: Date.now(),
    });
  },
});

export const remove = mutation({
  args: { endpointId: v.id("webhookEndpoints") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    const endpoint = await ctx.db.get(args.endpointId);
    if (
      !identity ||
      !endpoint ||
      identity.org_id !== endpoint.clerkOrgId ||
      identity.org_role !== "org:admin"
    ) {
      throw new Error("Forbidden");
    }
    const deliveries = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_endpoint_time", (q) => q.eq("endpointId", endpoint._id))
      .take(500);
    for (const delivery of deliveries) await ctx.db.delete(delivery._id);
    await ctx.db.delete(endpoint._id);
  },
});

export const queueTest = mutation({
  args: { endpointId: v.id("webhookEndpoints") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    const endpoint = await ctx.db.get(args.endpointId);
    if (
      !identity ||
      !endpoint ||
      identity.org_id !== endpoint.clerkOrgId ||
      identity.org_role !== "org:admin"
    ) {
      throw new Error("Forbidden");
    }
    const eventId = await recordOrganizationEvent(ctx, {
      clerkOrgId: endpoint.clerkOrgId,
      actorUserId: identity.subject,
      actorName: identity.name ?? identity.email ?? identity.subject,
      kind: "webhook.test",
      targetId: endpoint._id,
      targetName: endpoint.name,
    });
    const now = Date.now();
    await ctx.db.insert("webhookDeliveries", {
      clerkOrgId: endpoint.clerkOrgId,
      endpointId: endpoint._id,
      eventId,
      eventKind: "webhook.test",
      state: "pending",
      attemptCount: 0,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.webhooks.drain, {});
  },
});

export const claimDue = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_due", (q) => q.eq("state", "pending").lte("nextAttemptAt", now))
      .take(DELIVERY_BATCH * 5);
    const claimed: Id<"webhookDeliveries">[] = [];
    const endpointIds = new Set<string>();
    for (const delivery of due) {
      if (claimed.length >= DELIVERY_BATCH || endpointIds.has(delivery.endpointId)) continue;
      const endpoint = await ctx.db.get(delivery.endpointId);
      if (!endpoint || endpoint.disabledAt) {
        await ctx.db.patch(delivery._id, {
          state: "failed",
          lastError: "endpoint-disabled",
          updatedAt: now,
        });
        continue;
      }
      const active = await ctx.db
        .query("webhookDeliveries")
        .withIndex("by_endpoint_time", (q) => q.eq("endpointId", delivery.endpointId))
        .filter((q) => q.eq(q.field("state"), "delivering"))
        .first();
      if (active && (active.leaseExpiresAt ?? 0) > now) continue;
      if (active)
        await ctx.db.patch(active._id, { state: "pending", nextAttemptAt: now, updatedAt: now });
      endpointIds.add(delivery.endpointId);
      await ctx.db.patch(delivery._id, {
        state: "delivering",
        leaseExpiresAt: now + LEASE_MS,
        updatedAt: now,
      });
      claimed.push(delivery._id);
    }
    return claimed;
  },
});

export const deliveryPayload = internalQuery({
  args: { deliveryId: v.id("webhookDeliveries") },
  handler: async (ctx, args) => {
    const delivery = await ctx.db.get(args.deliveryId);
    if (delivery?.state !== "delivering") return null;
    const [endpoint, event] = await Promise.all([
      ctx.db.get(delivery.endpointId),
      ctx.db.get(delivery.eventId),
    ]);
    if (!endpoint || !event || endpoint.disabledAt) return null;
    return { delivery, endpoint, event };
  },
});

export const finish = internalMutation({
  args: {
    deliveryId: v.id("webhookDeliveries"),
    ok: v.boolean(),
    responseStatus: v.optional(v.number()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const delivery = await ctx.db.get(args.deliveryId);
    if (!delivery) return;
    const endpoint = await ctx.db.get(delivery.endpointId);
    if (!endpoint) {
      await ctx.db.delete(delivery._id);
      return;
    }
    const now = Date.now();
    const attemptCount = delivery.attemptCount + 1;
    if (args.ok) {
      await ctx.db.patch(delivery._id, {
        state: "delivered",
        attemptCount,
        responseStatus: args.responseStatus,
        lastError: undefined,
        leaseExpiresAt: undefined,
        updatedAt: now,
      });
      await ctx.db.patch(endpoint._id, { failureCount: 0, updatedAt: now });
      return;
    }
    const terminal = attemptCount >= MAX_ATTEMPTS;
    await ctx.db.patch(delivery._id, {
      state: terminal ? "failed" : "pending",
      attemptCount,
      responseStatus: args.responseStatus,
      lastError: args.error?.slice(0, 300) ?? "delivery-failed",
      nextAttemptAt: now + Math.min(6 * 60 * 60 * 1_000, 2 ** attemptCount * 30_000),
      leaseExpiresAt: undefined,
      updatedAt: now,
    });
    const failures = endpoint.failureCount + 1;
    await ctx.db.patch(endpoint._id, {
      failureCount: failures,
      disabledAt: terminal ? now : endpoint.disabledAt,
      updatedAt: now,
    });
    if (terminal) {
      await recordOrganizationEvent(ctx, {
        clerkOrgId: endpoint.clerkOrgId,
        actorUserId: null,
        actorName: "Stash",
        kind: "webhook.disabled",
        targetId: endpoint._id,
        targetName: endpoint.name,
        metadata: JSON.stringify({ reason: args.error ?? "delivery-failed" }),
      });
    }
  },
});

export const deliver = internalAction({
  args: { deliveryId: v.id("webhookDeliveries") },
  handler: async (ctx, args) => {
    const payload = await ctx.runQuery(internal.webhooks.deliveryPayload, args);
    if (!payload) return;
    const body = JSON.stringify({
      id: payload.delivery._id,
      type: payload.event.kind,
      createdAt: new Date(payload.event.createdAt).toISOString(),
      organizationId: payload.event.clerkOrgId,
      data: {
        projectId: payload.event.projectId,
        projectName: payload.event.projectName,
        targetId: payload.event.targetId,
        targetName: payload.event.targetName,
      },
    });
    const timestamp = Math.floor(Date.now() / 1_000).toString();
    const signature = await hmac(
      await decryptSecret(payload.endpoint.encryptedSecret),
      `${timestamp}.${body}`,
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(payload.endpoint.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Stash-Webhooks/1.0",
          "X-Stash-Delivery": payload.delivery._id,
          "X-Stash-Signature": `v1=${signature}`,
          "X-Stash-Timestamp": timestamp,
        },
        body,
        redirect: "manual",
        signal: controller.signal,
      });
      await ctx.runMutation(internal.webhooks.finish, {
        deliveryId: args.deliveryId,
        ok: response.status >= 200 && response.status < 300,
        responseStatus: response.status,
        error:
          response.status >= 200 && response.status < 300 ? undefined : `http-${response.status}`,
      });
    } catch (error) {
      await ctx.runMutation(internal.webhooks.finish, {
        deliveryId: args.deliveryId,
        ok: false,
        error: error instanceof Error ? error.name : "network-error",
      });
    } finally {
      clearTimeout(timeout);
    }
  },
});

export const drain = internalAction({
  args: {},
  handler: async (ctx) => {
    const ids = await ctx.runMutation(internal.webhooks.claimDue, {});
    await Promise.all(
      ids.map((deliveryId) => ctx.runAction(internal.webhooks.deliver, { deliveryId })),
    );
  },
});

export const prune = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1_000;
    const rows = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_created", (q) => q.lt("createdAt", cutoff))
      .take(200);
    for (const row of rows) {
      if (row.state === "delivered" || row.state === "failed") await ctx.db.delete(row._id);
    }
  },
});
