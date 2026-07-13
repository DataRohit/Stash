import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation } from "./_generated/server";

const PRUNE_BATCH = 200;
const WINDOW_RETENTION_MS = 60 * 60 * 1000;
const MAX_REFILL_ELAPSED_MS = WINDOW_RETENTION_MS;

type WriteLimit = {
  capacity: number;
  refillPerSecond: number;
};

async function writeKeyHash(
  scope: string,
  documentId: Id<"documents">,
  userId: string,
): Promise<string> {
  const input = new TextEncoder().encode(`${scope}\0${documentId}\0${userId}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function enforceWriteRateLimit(
  ctx: MutationCtx,
  scope: string,
  documentId: Id<"documents">,
  userId: string,
  limit: WriteLimit,
): Promise<boolean> {
  const keyHash = await writeKeyHash(scope, documentId, userId);
  const now = Date.now();
  const row = await ctx.db
    .query("writeWindows")
    .withIndex("by_key", (q) => q.eq("keyHash", keyHash))
    .unique();
  if (!row) {
    await ctx.db.insert("writeWindows", {
      keyHash,
      tokens: limit.capacity - 1,
      updatedAt: now,
    });
    return true;
  }
  const elapsedMs = Number.isFinite(row.updatedAt)
    ? Math.max(0, Math.min(MAX_REFILL_ELAPSED_MS, now - row.updatedAt))
    : MAX_REFILL_ELAPSED_MS;
  const storedTokens = Number.isFinite(row.tokens) ? row.tokens : 0;
  const replenishedTokens = Math.min(
    limit.capacity,
    Math.max(0, storedTokens) + (elapsedMs * limit.refillPerSecond) / 1000,
  );
  if (replenishedTokens < 1) {
    await ctx.db.patch(row._id, { tokens: replenishedTokens, updatedAt: now });
    return false;
  }
  await ctx.db.patch(row._id, { tokens: replenishedTokens - 1, updatedAt: now });
  return true;
}

export const pruneWriteWindows = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - WINDOW_RETENTION_MS;
    const rows = await ctx.db
      .query("writeWindows")
      .withIndex("by_updated", (q) => q.lt("updatedAt", cutoff))
      .take(PRUNE_BATCH);
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
    if (rows.length === PRUNE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.writeRateLimit.pruneWriteWindows, {});
    }
  },
});
