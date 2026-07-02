import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const schema = defineSchema({
  organizations: defineTable({
    clerkOrgId: v.string(),
    description: v.string(),
    tags: v.array(v.string()),
    updatedAt: v.number(),
  }).index("by_clerk_org", ["clerkOrgId"]),
});

export default schema;
