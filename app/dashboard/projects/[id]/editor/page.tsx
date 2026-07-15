import { auth } from "@clerk/nextjs/server";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ProjectEditor } from "@/app/dashboard/projects/[id]/editor/project-editor";
import { fetchProject, setOrgPlanLimits, setProjectMaxSize } from "@/lib/convex-server";
import { getUserPlanLimitsForSync } from "@/lib/plan-limits";

export const metadata: Metadata = {
  title: "Editor",
};

export default async function ProjectEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { isAuthenticated, userId, orgId } = await auth();

  if (!isAuthenticated || !userId) {
    redirect("/sign-in");
  }
  if (!orgId) {
    redirect("/onboarding");
  }

  const { id } = await params;
  const project = await fetchProject(id);
  if (!project || project.clerkOrgId !== orgId) {
    notFound();
  }

  if (project.viewerIsOwner) {
    const limits = await getUserPlanLimitsForSync();
    if (limits) {
      await setOrgPlanLimits(orgId, {
        maxProjects: limits.maxProjectsPerOrganization,
        maxCollaborators: limits.maxCollaboratorsPerProject,
        maxSizeBytes: limits.maxProjectSizeMb * 1024 * 1024,
        historyRetentionDays: limits.historyRetentionDays,
      });
      await setProjectMaxSize(id, limits.maxProjectSizeMb * 1024 * 1024);
    }
  }

  const canEdit = project.isAdmin || project.viewerLevel === "editor";

  return (
    <main className="flex h-dvh w-full flex-col px-3 pt-32 pb-4 sm:px-6 lg:pt-24">
      <ProjectEditor
        projectId={id}
        projectTitle={project.title}
        clerkOrgId={orgId}
        canEdit={canEdit}
        isAdmin={project.isAdmin}
      />
    </main>
  );
}
