import { UserButton } from "@clerk/nextjs";
import { auth, clerkClient } from "@clerk/nextjs/server";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CreateOrgForm } from "@/app/onboarding/create-org-form";
import { OrgList } from "@/app/onboarding/org-list";
import { UpgradeButton } from "@/app/onboarding/upgrade-button";
import { GridBackground } from "@/components/landing/grid-background";
import { ThemeToggle } from "@/components/landing/theme-toggle";
import { orgAvatarUrl } from "@/lib/org-avatar";
import { limitsFromFeatures } from "@/lib/plan-limits";
import { site } from "@/lib/site";
import { getUserSubscription } from "@/lib/subscription";

export const metadata: Metadata = {
  title: "Create your organization",
};

export default async function OnboardingPage() {
  const { userId } = await auth();
  if (!userId) {
    redirect("/sign-in");
  }

  const { isPro, featureSlugs } = await getUserSubscription();
  const { maxOrganizations } = limitsFromFeatures(featureSlugs);
  const client = await clerkClient();
  const memberships = await client.users.getOrganizationMembershipList({ userId, limit: 100 });
  const ownedCount = memberships.data.filter(
    (membership) => membership.organization.createdBy === userId,
  ).length;
  const atLimit = ownedCount >= maxOrganizations;
  const hasOrganizations = memberships.totalCount > 0;
  const organizations = memberships.data.map((membership) => ({
    id: membership.organization.id,
    name: membership.organization.name,
    iconUrl: membership.organization.hasImage
      ? membership.organization.imageUrl
      : orgAvatarUrl(membership.organization.id),
  }));

  return (
    <main className="aurora isolate flex min-h-screen flex-col items-center justify-center overflow-hidden px-6 py-24">
      <div className="pointer-events-none absolute inset-0 -z-10" aria-hidden="true">
        <GridBackground ripples={false} />
      </div>

      <header className="fixed top-3 right-0 left-0 z-50 w-full px-3 sm:px-6">
        <div className="glass mx-auto flex h-14 max-w-7xl items-center justify-between rounded-lg bg-surface/55 px-3 sm:px-4">
          <Link href="/dashboard" className="flex items-center gap-2.5">
            <span className="flex size-7 items-center justify-center rounded-sm border border-hairline bg-foreground font-bold font-mono text-background text-sm">
              S
            </span>
            <span className="font-semibold text-sm tracking-display">{site.name}</span>
          </Link>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <UserButton />
          </div>
        </div>
      </header>

      <div className="glass w-full max-w-md rounded-lg p-6 sm:p-8">
        <div className="flex flex-col gap-2">
          <span className="font-medium font-mono text-muted-foreground text-xs uppercase tracking-widest">
            — {hasOrganizations ? "Your organizations" : "Welcome"}
          </span>
          <h1 className="font-serif text-3xl tracking-display">
            {hasOrganizations ? "Choose an organization" : "Create your organization"}
          </h1>
          <p className="text-muted-foreground text-sm leading-relaxed">
            Every workspace in Stash lives inside an organization.{" "}
            {hasOrganizations
              ? "Select one to continue."
              : "Create one to get started — you can invite collaborators and add projects next."}
          </p>
        </div>

        <div className="mt-6 flex flex-col gap-6">
          {atLimit ? (
            <div className="flex flex-col gap-3 rounded-md border border-hairline bg-foreground/[0.025] p-4">
              <p className="text-sm leading-relaxed">
                You’ve reached your plan’s limit of {maxOrganizations} organization
                {maxOrganizations === 1 ? "" : "s"}.{isPro ? "" : " Upgrade to Pro to create more."}
              </p>
              <UpgradeButton
                label={isPro ? "Manage billing" : "Upgrade to Pro"}
                highlight={!isPro}
              />
            </div>
          ) : (
            <CreateOrgForm used={ownedCount} max={maxOrganizations} />
          )}

          {hasOrganizations ? <OrgList organizations={organizations} /> : null}
        </div>
      </div>
    </main>
  );
}
