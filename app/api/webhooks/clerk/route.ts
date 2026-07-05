import { clerkClient } from "@clerk/nextjs/server";
import { verifyWebhook } from "@clerk/nextjs/webhooks";
import type { NextRequest } from "next/server";
import {
  purgeDeletedOrganization,
  webhookDeleteAcceptedMember,
  webhookDeleteInvitation,
  webhookUpsertAcceptedMember,
  webhookUpsertPendingInvitation,
} from "@/lib/convex-server";

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
  } catch {
    return fallback.toLowerCase();
  }
}

async function revokeUserSessions(userId: string): Promise<void> {
  try {
    const client = await clerkClient();
    const sessions = await client.sessions.getSessionList({ userId, status: "active" });
    await Promise.all(
      sessions.data.map((session) => client.sessions.revokeSession(session.id).catch(() => null)),
    );
  } catch {}
}

export async function POST(req: NextRequest) {
  let event: Awaited<ReturnType<typeof verifyWebhook>>;
  try {
    event = await verifyWebhook(req);
  } catch {
    return new Response("Verification failed", { status: 400 });
  }

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
      }
      break;
    }
    case "organizationMembership.deleted": {
      const orgId = event.data.organization.id;
      const userId = event.data.public_user_data.user_id;
      if (orgId && userId) {
        await webhookDeleteAcceptedMember(orgId, userId);
        await revokeUserSessions(userId);
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

  return new Response("OK", { status: 200 });
}
