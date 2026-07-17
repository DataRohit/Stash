import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

export async function ensureAutoWatch(
  ctx: MutationCtx,
  input: {
    clerkOrgId: string;
    userId: string;
    projectId: Id<"projects">;
    documentId: Id<"documents">;
  },
): Promise<void> {
  const preference = await ctx.db
    .query("watchPreferences")
    .withIndex("by_user_org", (q) =>
      q.eq("userId", input.userId).eq("clerkOrgId", input.clerkOrgId),
    )
    .unique();
  if (preference?.autoWatch === false) return;
  const existing = await ctx.db
    .query("documentWatches")
    .withIndex("by_document_user", (q) =>
      q.eq("documentId", input.documentId).eq("userId", input.userId),
    )
    .unique();
  if (!existing) {
    await ctx.db.insert("documentWatches", { ...input, createdAt: Date.now() });
  }
}
