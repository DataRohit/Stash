import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const schema = defineSchema({
  organizations: defineTable({
    clerkOrgId: v.string(),
    description: v.string(),
    tags: v.array(v.string()),
    maxProjects: v.optional(v.number()),
    maxCollaborators: v.optional(v.number()),
    maxSizeBytes: v.optional(v.number()),
    reconciledAt: v.optional(v.number()),
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

  projects: defineTable({
    clerkOrgId: v.string(),
    title: v.string(),
    description: v.string(),
    tags: v.array(v.string()),
    imageStorageId: v.union(v.id("_storage"), v.null()),
    maxSizeBytes: v.optional(v.number()),
    maxCollaborators: v.optional(v.number()),
    totalBytes: v.optional(v.number()),
    deletedAt: v.optional(v.number()),
    createdBy: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_clerk_org", ["clerkOrgId"])
    .index("by_deleted", ["deletedAt"]),

  documents: defineTable({
    projectId: v.id("projects"),
    clerkOrgId: v.string(),
    parentId: v.union(v.id("documents"), v.null()),
    kind: v.union(v.literal("folder"), v.literal("file"), v.literal("asset")),
    name: v.string(),
    fileType: v.union(v.literal("md"), v.literal("html"), v.null()),
    content: v.string(),
    contentSeq: v.optional(v.number()),
    contentState: v.optional(v.bytes()),
    storageId: v.union(v.id("_storage"), v.null()),
    mimeType: v.union(v.string(), v.null()),
    size: v.number(),
    deletingAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_parent", ["projectId", "parentId"])
    .index("by_deleting", ["deletingAt"]),

  projectAccess: defineTable({
    projectId: v.id("projects"),
    clerkOrgId: v.string(),
    userId: v.string(),
    createdAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_org_user", ["clerkOrgId", "userId"])
    .index("by_project_user", ["projectId", "userId"]),

  yjsUpdates: defineTable({
    documentId: v.id("documents"),
    seq: v.number(),
    update: v.bytes(),
    createdAt: v.number(),
  }).index("by_document", ["documentId", "seq"]),

  yjsSnapshots: defineTable({
    documentId: v.id("documents"),
    snapshot: v.bytes(),
    throughSeq: v.number(),
    updatedAt: v.number(),
  }).index("by_document", ["documentId"]),

  presence: defineTable({
    documentId: v.id("documents"),
    sessionId: v.optional(v.string()),
    userId: v.string(),
    name: v.string(),
    email: v.optional(v.string()),
    color: v.string(),
    image: v.union(v.string(), v.null()),
    state: v.string(),
    lastSeen: v.number(),
  })
    .index("by_document", ["documentId"])
    .index("by_document_session", ["documentId", "sessionId"]),
});

export default schema;
