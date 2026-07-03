import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const schema = defineSchema({
  organizations: defineTable({
    clerkOrgId: v.string(),
    description: v.string(),
    tags: v.array(v.string()),
    updatedAt: v.number(),
  }).index("by_clerk_org", ["clerkOrgId"]),

  members: defineTable({
    clerkOrgId: v.string(),
    email: v.string(),
    memberUserId: v.union(v.string(), v.null()),
    status: v.union(v.literal("pending"), v.literal("accepted")),
    role: v.string(),
    isOwner: v.boolean(),
    firstName: v.union(v.string(), v.null()),
    lastName: v.union(v.string(), v.null()),
    imageUrl: v.union(v.string(), v.null()),
    clerkInvitationId: v.union(v.string(), v.null()),
    invitedAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_clerk_org", ["clerkOrgId"])
    .index("by_org_email", ["clerkOrgId", "email"])
    .index("by_org_user", ["clerkOrgId", "memberUserId"])
    .index("by_email", ["email"]),
});

export default schema;
