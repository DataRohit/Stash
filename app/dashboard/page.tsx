import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { OrgCard } from "@/app/dashboard/org-card";
import { GridBackground } from "@/components/landing/grid-background";
import { ThemeToggle } from "@/components/landing/theme-toggle";
import { buttonVariants } from "@/components/ui/button";
import { fetchOrgDetails } from "@/lib/convex-server";
import { orgAvatarUrl } from "@/lib/org-avatar";
import { site } from "@/lib/site";
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
  const [organization, orgMembers, userMemberships, details] = await Promise.all([
    client.organizations.getOrganization({ organizationId: orgId }),
    client.organizations.getOrganizationMembershipList({ organizationId: orgId }),
    client.users.getOrganizationMembershipList({ userId }),
    fetchOrgDetails(orgId),
  ]);

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
        <div className="glass mx-auto flex h-14 max-w-7xl items-center justify-between rounded-[12px] bg-surface/80 px-3 sm:px-4">
          <div className="flex items-center gap-3">
            <Link href="/dashboard" className="flex items-center gap-2.5">
              <span className="flex size-7 items-center justify-center rounded-[6px] border border-hairline bg-foreground font-bold font-mono text-background text-sm">
                S
              </span>
              <span className="font-semibold text-sm tracking-display">{site.name}</span>
            </Link>
            <span className="h-5 w-px bg-hairline" aria-hidden="true" />
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
          <div className="flex items-center gap-2">
            <Link
              href="/onboarding"
              className={cn(buttonVariants({ variant: "secondary" }), "text-xs")}
            >
              <Plus className="size-4" aria-hidden="true" />
              New organization
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

      <main className="mx-auto flex max-w-7xl justify-center px-4 pt-28 pb-16 sm:px-6">
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
          canDelete={userMemberships.totalCount > 1}
        />
      </main>
    </div>
  );
}
