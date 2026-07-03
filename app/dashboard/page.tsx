import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { reconcileMembers } from "@/app/dashboard/members-actions";
import { OrgCard } from "@/app/dashboard/org-card";
import { OrgInvitations } from "@/app/dashboard/org-invitations";
import { OrgMembers } from "@/app/dashboard/org-members";
import { PlanBadge } from "@/components/dashboard/plan-badge";
import { GridBackground } from "@/components/landing/grid-background";
import { ThemeToggle } from "@/components/landing/theme-toggle";
import { buttonVariants } from "@/components/ui/button";
import { fetchOrgDetails } from "@/lib/convex-server";
import { orgAvatarUrl } from "@/lib/org-avatar";
import { limitsFromFeatures } from "@/lib/plan-limits";
import { site } from "@/lib/site";
import { getUserSubscription } from "@/lib/subscription";
import { cn } from "@/lib/utils";

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
    <div className="aurora isolate min-h-screen overflow-hidden">
      <div className="pointer-events-none absolute inset-0 -z-10" aria-hidden="true">
        <GridBackground ripples={false} />
      </div>
      <header className="fixed top-3 right-0 left-0 z-50 w-full px-3 sm:px-6">
        <div className="glass mx-auto flex h-14 max-w-7xl items-center justify-between gap-2 rounded-[12px] bg-surface/80 px-3 sm:px-4">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <Link href="/dashboard" className="flex shrink-0 items-center gap-2.5">
              <span className="flex size-7 items-center justify-center rounded-[6px] border border-hairline bg-foreground font-bold font-mono text-background text-sm">
                S
              </span>
              <span className="hidden font-semibold text-sm tracking-display sm:inline">
                {site.name}
              </span>
            </Link>
            <span className="hidden h-5 w-px shrink-0 bg-hairline sm:block" aria-hidden="true" />
            <div className="min-w-0">
              <OrganizationSwitcher
                hidePersonal
                afterSelectOrganizationUrl="/dashboard"
                afterLeaveOrganizationUrl="/onboarding"
                appearance={{
                  elements: {
                    organizationSwitcherTrigger: "rounded-[6px]",
                  },
                }}
              />
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <PlanBadge
              isPro={subscription.isPro}
              planPeriod={subscription.planPeriod}
              periodEnd={subscription.periodEnd}
              canceled={subscription.canceled}
            />
            <span className="hidden h-5 w-px shrink-0 bg-hairline sm:block" aria-hidden="true" />
            <Link
              href="/onboarding"
              aria-label="New organization"
              className={cn(buttonVariants({ variant: "secondary" }), "text-xs max-sm:px-2.5")}
            >
              <Plus className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">New organization</span>
            </Link>
            <ThemeToggle />
            <UserButton
              appearance={{
                elements: {
                  userButtonAvatarBox: "rounded-[6px]",
                },
              }}
            />
          </div>
        </div>
      </header>

      <main className="flex w-full flex-col items-center px-3 pt-28 pb-16 sm:px-6">
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
          />
          <OrgMembers
            clerkOrgId={orgId}
            currentUserId={userId}
            isAdmin={orgRole === "org:admin"}
            maxMembers={limits.maxMembersPerOrganization}
          />
        </div>
      </main>
    </div>
  );
}
