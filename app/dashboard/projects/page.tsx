import { auth, clerkClient } from "@clerk/nextjs/server";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ProjectsBoard } from "@/app/dashboard/projects/projects-board";
import { setOrgPlanLimits } from "@/lib/convex-server";
import { orgAvatarUrl } from "@/lib/org-avatar";
import { limitsFromFeatures } from "@/lib/plan-limits";
import { getUserSubscription } from "@/lib/subscription";

export const metadata: Metadata = {
  title: "Projects",
};

export default async function ProjectsPage() {
  const { isAuthenticated, userId, orgId, orgRole } = await auth();

  if (!isAuthenticated || !userId) {
    redirect("/sign-in");
  }
  if (!orgId) {
    redirect("/onboarding");
  }

  const client = await clerkClient();
  const [subscription, organization] = await Promise.all([
    getUserSubscription(),
    client.organizations.getOrganization({ organizationId: orgId }),
  ]);
  const limits = limitsFromFeatures(subscription.featureSlugs);
  const orgIconUrl = organization.hasImage ? organization.imageUrl : orgAvatarUrl(orgId);

  if (organization.createdBy === userId && !subscription.degraded) {
    await setOrgPlanLimits(orgId, {
      maxProjects: limits.maxProjectsPerOrganization,
      maxCollaborators: limits.maxCollaboratorsPerProject,
      maxSizeBytes: limits.maxProjectSizeMb * 1024 * 1024,
      historyRetentionDays: limits.historyRetentionDays,
    });
  }

  return (
    <main className="flex w-full flex-col items-center px-3 pt-32 pb-16 sm:px-6 lg:pt-28">
      <div className="flex w-full max-w-7xl flex-col gap-6">
        <ProjectsBoard
          clerkOrgId={orgId}
          isAdmin={orgRole === "org:admin"}
          maxProjects={limits.maxProjectsPerOrganization}
          orgName={organization.name}
          orgIconUrl={orgIconUrl}
        />
      </div>
    </main>
  );
}
