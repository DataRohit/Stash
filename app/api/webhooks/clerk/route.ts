import { clerkClient } from "@clerk/nextjs/server";
import { verifyWebhook } from "@clerk/nextjs/webhooks";
import type { NextRequest } from "next/server";
import {
  purgeDeletedOrganization,
  webhookDeleteAcceptedMember,
  webhookDeleteInvitation,
  webhookDeleteUser,
  webhookSetOrgPlanLimits,
  webhookUpsertAcceptedMember,
  webhookUpsertPendingInvitation,
} from "@/lib/convex-server";
import { limitsFromFeatures } from "@/lib/plan-limits";
import { logServerError, logServerWarning } from "@/lib/server-log";
import { getUserSubscriptionFor } from "@/lib/subscription";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function primaryEmailForUser(userId: string, fallback: string): Promise<string> {
  try {
    const client = await clerkClient();
    const user = await client.users.getUser(userId);
    const primary = user.emailAddresses.find((email) => email.id === user.primaryEmailAddressId);
    return (
      primary?.emailAddress ??
      user.emailAddresses[0]?.emailAddress ??
      fallback
    ).toLowerCase();
  } catch (error) {
    logServerWarning("clerk_webhook.email_lookup_failed", {
      userId,
      reason: error instanceof Error ? error.name : "UnknownError",
    });
    return fallback.toLowerCase();
  }
}

export async function POST(req: NextRequest) {
  let event: Awaited<ReturnType<typeof verifyWebhook>>;
  try {
    event = await verifyWebhook(req);
  } catch {
    return new Response("Verification failed", { status: 400 });
  }

  try {
    switch (event.type) {
      case "organization.deleted": {
        const orgId = event.data.id;
        if (orgId) {
          await purgeDeletedOrganization(orgId);
        }
        break;
      }
      case "organizationMembership.created":
      case "organizationMembership.updated": {
        const userData = event.data.public_user_data;
        const orgId = event.data.organization.id;
        const userId = userData.user_id;
        const email = await primaryEmailForUser(
          userId,
          EMAIL_PATTERN.test(userData.identifier) ? userData.identifier : "",
        );
        if (orgId && userId && EMAIL_PATTERN.test(email)) {
          await webhookUpsertAcceptedMember({
            clerkOrgId: orgId,
            ownerUserId: event.data.organization.created_by ?? "",
            memberUserId: userId,
            email,
            role: event.data.role,
            firstName: userData.first_name,
            lastName: userData.last_name,
            imageUrl: userData.image_url,
          });
        } else if (orgId && userId) {
          logServerWarning("clerk_webhook.membership_email_unresolved", {
            eventType: event.type,
            clerkOrgId: orgId,
            userId,
          });
        }
        break;
      }
      case "organizationMembership.deleted": {
        const orgId = event.data.organization.id;
        const userId = event.data.public_user_data.user_id;
        if (orgId && userId) {
          await webhookDeleteAcceptedMember(orgId, userId);
        }
        break;
      }
      case "user.deleted": {
        if (event.data.id) await webhookDeleteUser(event.data.id);
        break;
      }
      case "subscription.created":
      case "subscription.updated":
      case "subscription.active":
      case "subscription.pastDue": {
        const userId = event.data.payer.user_id;
        if (!userId) break;
        const subscription = await getUserSubscriptionFor(userId, true);
        if (subscription.degraded) throw new Error("subscription-unavailable");
        const limits = limitsFromFeatures(subscription.featureSlugs);
        const client = await clerkClient();
        const memberships = await client.users.getOrganizationMembershipList({
          userId,
          limit: 100,
        });
        for (const membership of memberships.data) {
          const organization = await client.organizations.getOrganization({
            organizationId: membership.organization.id,
          });
          if (organization.createdBy !== userId) continue;
          await webhookSetOrgPlanLimits(organization.id, {
            maxProjects: limits.maxProjectsPerOrganization,
            maxCollaborators: limits.maxCollaboratorsPerProject,
            maxSizeBytes: limits.maxProjectSizeMb * 1024 * 1024,
            historyRetentionDays: limits.historyRetentionDays,
          });
        }
        break;
      }
      case "organizationInvitation.created": {
        if (event.data.status === "pending" || !event.data.status) {
          await webhookUpsertPendingInvitation({
            clerkOrgId: event.data.organization_id,
            email: event.data.email_address.toLowerCase(),
            role: event.data.role,
            clerkInvitationId: event.data.id,
          });
        }
        break;
      }
      case "organizationInvitation.revoked":
      case "organizationInvitation.accepted": {
        await webhookDeleteInvitation(event.data.organization_id, event.data.id);
        break;
      }
    }
  } catch (error) {
    logServerError("clerk_webhook.processing_failed", error, { eventType: event.type });
    return new Response("Processing failed", { status: 503 });
  }

  return new Response("OK", { status: 200 });
}
