import { auth } from "@clerk/nextjs/server";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ProjectDetail } from "@/app/dashboard/projects/[id]/project-detail";
import { fetchProject } from "@/lib/convex-server";

export const metadata: Metadata = {
  title: "Project",
};

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
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

  return (
    <main className="flex w-full flex-col items-center px-3 pt-32 pb-16 sm:px-6 lg:pt-28">
      <div className="flex w-full max-w-7xl flex-col gap-6">
        <ProjectDetail projectId={id} clerkOrgId={orgId} />
      </div>
    </main>
  );
}
