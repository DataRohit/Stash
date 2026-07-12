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
    publicSharingEnabled: v.optional(v.boolean()),
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
    cloneState: v.optional(v.union(v.literal("copying"), v.literal("ready"), v.literal("failed"))),
    cloneCopied: v.optional(v.number()),
    cloneTotal: v.optional(v.number()),
    cloneError: v.optional(v.string()),
    deletedAt: v.optional(v.number()),
    createdBy: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_clerk_org", ["clerkOrgId"])
    .index("by_deleted", ["deletedAt"])
    .index("by_clone_state", ["cloneState"]),

  orgTemplates: defineTable({
    clerkOrgId: v.string(),
    name: v.string(),
    normalizedName: v.string(),
    fileType: v.union(v.literal("md"), v.literal("html"), v.literal("doc")),
    content: v.string(),
    contentState: v.optional(v.bytes()),
    createdByUserId: v.string(),
    createdByName: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["clerkOrgId"])
    .index("by_org_name", ["clerkOrgId", "normalizedName"]),

  documents: defineTable({
    projectId: v.id("projects"),
    clerkOrgId: v.string(),
    parentId: v.union(v.id("documents"), v.null()),
    kind: v.union(v.literal("folder"), v.literal("file"), v.literal("asset")),
    name: v.string(),
    fileType: v.union(v.literal("md"), v.literal("html"), v.literal("doc"), v.null()),
    content: v.string(),
    contentSeq: v.optional(v.number()),
    contentState: v.optional(v.bytes()),
    storageId: v.union(v.id("_storage"), v.null()),
    mimeType: v.union(v.string(), v.null()),
    size: v.number(),
    deletingAt: v.optional(v.number()),
    trashedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_parent", ["projectId", "parentId"])
    .index("by_deleting", ["deletingAt"])
    .index("by_trashed", ["trashedAt"])
    .searchIndex("search_content", {
      searchField: "content",
      filterFields: ["projectId", "kind"],
    }),

  projectAccess: defineTable({
    projectId: v.id("projects"),
    clerkOrgId: v.string(),
    userId: v.string(),
    level: v.optional(v.union(v.literal("viewer"), v.literal("editor"))),
    createdAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_org_user", ["clerkOrgId", "userId"])
    .index("by_project_user", ["projectId", "userId"]),

  recentDocuments: defineTable({
    clerkOrgId: v.string(),
    userId: v.string(),
    projectId: v.id("projects"),
    documentId: v.id("documents"),
    lastOpenedAt: v.number(),
  })
    .index("by_user_org_time", ["userId", "clerkOrgId", "lastOpenedAt"])
    .index("by_user_document", ["userId", "documentId"])
    .index("by_document", ["documentId"])
    .index("by_project", ["projectId"]),

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
    purpose: v.optional(v.union(v.literal("base"), v.literal("history"))),
    label: v.optional(v.string()),
    authorUserId: v.optional(v.string()),
    authorName: v.optional(v.string()),
    authorEmail: v.optional(v.string()),
    previewText: v.optional(v.string()),
    createdAt: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
    sizeBytes: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_document", ["documentId"])
    .index("by_document_purpose", ["documentId", "purpose"])
    .index("by_purpose_created", ["purpose", "createdAt"]),

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

  comments: defineTable({
    documentId: v.id("documents"),
    projectId: v.id("projects"),
    clerkOrgId: v.string(),
    startRel: v.bytes(),
    endRel: v.bytes(),
    quote: v.string(),
    status: v.union(v.literal("open"), v.literal("resolved")),
    authorUserId: v.string(),
    authorName: v.string(),
    authorEmail: v.union(v.string(), v.null()),
    authorImage: v.union(v.string(), v.null()),
    resolvedByUserId: v.union(v.string(), v.null()),
    resolvedByName: v.union(v.string(), v.null()),
    resolvedAt: v.union(v.number(), v.null()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_document", ["documentId"])
    .index("by_project", ["projectId"]),

  commentMessages: defineTable({
    commentId: v.id("comments"),
    documentId: v.id("documents"),
    projectId: v.id("projects"),
    clerkOrgId: v.string(),
    body: v.string(),
    mentionUserIds: v.array(v.string()),
    authorUserId: v.string(),
    authorName: v.string(),
    authorEmail: v.union(v.string(), v.null()),
    authorImage: v.union(v.string(), v.null()),
    createdAt: v.number(),
  })
    .index("by_comment", ["commentId"])
    .index("by_document", ["documentId"]),

  notifications: defineTable({
    kind: v.optional(
      v.union(
        v.literal("mention"),
        v.literal("reply"),
        v.literal("resolved"),
        v.literal("reopened"),
      ),
    ),
    recipientUserId: v.string(),
    clerkOrgId: v.string(),
    projectId: v.id("projects"),
    documentId: v.id("documents"),
    commentId: v.id("comments"),
    messageId: v.optional(v.id("commentMessages")),
    actorUserId: v.string(),
    actorName: v.string(),
    quote: v.string(),
    bodySnippet: v.string(),
    readAt: v.union(v.number(), v.null()),
    createdAt: v.number(),
  })
    .index("by_recipient", ["recipientUserId", "createdAt"])
    .index("by_recipient_org", ["recipientUserId", "clerkOrgId", "createdAt"])
    .index("by_recipient_read", ["recipientUserId", "readAt"])
    .index("by_recipient_org_read", ["recipientUserId", "clerkOrgId", "readAt"])
    .index("by_comment", ["commentId"])
    .index("by_document", ["documentId"])
    .index("by_created", ["createdAt"]),

  notificationPreferences: defineTable({
    clerkOrgId: v.string(),
    projectId: v.id("projects"),
    userId: v.string(),
    muted: v.boolean(),
    updatedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_project_user", ["projectId", "userId"]),

  projectEvents: defineTable({
    clerkOrgId: v.string(),
    projectId: v.id("projects"),
    kind: v.union(
      v.literal("node_created"),
      v.literal("documents_imported"),
      v.literal("document_duplicated"),
      v.literal("node_renamed"),
      v.literal("node_moved"),
      v.literal("node_trashed"),
      v.literal("node_restored"),
      v.literal("node_deleted"),
      v.literal("checkpoint_created"),
      v.literal("checkpoint_deleted"),
      v.literal("checkpoint_restored"),
      v.literal("share_changed"),
      v.literal("access_granted"),
      v.literal("access_revoked"),
    ),
    actorUserId: v.string(),
    actorName: v.string(),
    documentId: v.optional(v.id("documents")),
    memberUserId: v.optional(v.string()),
    checkpointId: v.optional(v.id("yjsSnapshots")),
    targetName: v.string(),
    detail: v.optional(v.string()),
    previousValue: v.optional(v.string()),
    nextValue: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_project", ["projectId", "createdAt"])
    .index("by_created", ["createdAt"]),

  documentShares: defineTable({
    documentId: v.id("documents"),
    projectId: v.id("projects"),
    clerkOrgId: v.string(),
    mode: v.union(v.literal("private"), v.literal("org"), v.literal("public")),
    token: v.union(v.string(), v.null()),
    expiresAt: v.optional(v.number()),
    createdByUserId: v.string(),
    createdByName: v.string(),
    updatedByUserId: v.string(),
    updatedByName: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_document", ["documentId"])
    .index("by_project", ["projectId"])
    .index("by_token", ["token"]),

  shareAccessWindows: defineTable({
    ipHash: v.string(),
    windowStart: v.number(),
    count: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ip", ["ipHash"])
    .index("by_updated", ["updatedAt"]),

  documentShareEvents: defineTable({
    documentId: v.id("documents"),
    projectId: v.id("projects"),
    clerkOrgId: v.string(),
    actorUserId: v.string(),
    actorName: v.string(),
    previousMode: v.union(v.literal("private"), v.literal("org"), v.literal("public")),
    nextMode: v.union(v.literal("private"), v.literal("org"), v.literal("public")),
    createdAt: v.number(),
  })
    .index("by_document", ["documentId", "createdAt"])
    .index("by_project", ["projectId", "createdAt"])
    .index("by_created", ["createdAt"]),
});

export default schema;
