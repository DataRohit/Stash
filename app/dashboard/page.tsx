import { auth, clerkClient } from "@clerk/nextjs/server";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { reconcileMembers } from "@/app/dashboard/members-actions";
import { OrgCard } from "@/app/dashboard/org-card";
import { OrgInvitations } from "@/app/dashboard/org-invitations";
import { OrgMembers } from "@/app/dashboard/org-members";
import { OrgTemplates } from "@/app/dashboard/org-templates";
import { fetchOrgDetails } from "@/lib/convex-server";
import { orgAvatarUrl } from "@/lib/org-avatar";
import { limitsFromFeatures } from "@/lib/plan-limits";
import { getUserSubscription } from "@/lib/subscription";

export const metadata: Metadata = {
  title: "Dashboard",
};

function memberName(firstName: string | null, lastName: string | null, fallback: string): string {
  const full = [firstName, lastName].filter(Boolean).join(" ").trim();
  return full.length > 0 ? full : fallback;
}

export default async function DashboardPage() {
  const { isAuthenticated, userId, orgId, orgRole } = await auth();

  if (!isAuthenticated || !userId) {
    redirect("/sign-in");
  }

  if (!orgId) {
    redirect("/onboarding");
  }

  const client = await clerkClient();
  const [organization, orgMembers, userMemberships, details, subscription] = await Promise.all([
    client.organizations.getOrganization({ organizationId: orgId }),
    client.organizations.getOrganizationMembershipList({ organizationId: orgId }),
    client.users.getOrganizationMembershipList({ userId, limit: 100 }),
    fetchOrgDetails(orgId),
    getUserSubscription(),
    reconcileMembers(),
  ]);

  const limits = limitsFromFeatures(subscription.featureSlugs);
  const isOwner = organization.createdBy === userId;
  const ownedCount = userMemberships.data.filter(
    (membership) => membership.organization.createdBy === userId,
  ).length;
  const canDelete = isOwner ? ownedCount > 1 : userMemberships.totalCount > 1;

  const admin =
    orgMembers.data.find(
      (member) =>
        member.role === "org:admin" && member.publicUserData?.userId === organization.createdBy,
    ) ??
    orgMembers.data.find((member) => member.role === "org:admin") ??
    orgMembers.data[0];
  const adminEmail = admin?.publicUserData?.identifier ?? "—";
  const adminName = memberName(
    admin?.publicUserData?.firstName ?? null,
    admin?.publicUserData?.lastName ?? null,
    adminEmail,
  );

  return (
    <main className="flex w-full flex-col items-center px-3 pt-32 pb-16 sm:px-6 lg:pt-28">
      <div className="flex w-full max-w-7xl flex-col gap-6">
        <OrgInvitations />
        <OrgCard
          name={organization.name}
          createdAt={organization.createdAt}
          adminName={adminName}
          adminEmail={adminEmail}
          description={details.description}
          tags={details.tags}
          imageUrl={organization.hasImage ? organization.imageUrl : null}
          defaultIconUrl={orgAvatarUrl(orgId)}
          isAdmin={orgRole === "org:admin"}
          canDelete={canDelete}
          publicSharingEnabled={details.publicSharingEnabled}
        />
        <OrgMembers
          clerkOrgId={orgId}
          currentUserId={userId}
          isAdmin={orgRole === "org:admin"}
          maxMembers={limits.maxMembersPerOrganization}
        />
        <OrgTemplates clerkOrgId={orgId} isAdmin={orgRole === "org:admin"} />
      </div>
    </main>
  );
}
