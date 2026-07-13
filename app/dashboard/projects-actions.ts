"use server";

import { auth } from "@clerk/nextjs/server";
import { countOrgProjects, createProjectDoc, setOrgPlanLimits } from "@/lib/convex-server";
import { getUserPlanLimits } from "@/lib/plan-limits";
import { logServerError } from "@/lib/server-log";

export type CreateProjectResult = { id: string } | { error: string };

export async function createProject(input: {
  title: string;
  description: string;
  tags: string[];
}): Promise<CreateProjectResult> {
  const { userId, orgId, orgRole } = await auth();
  if (!userId || !orgId) {
    return { error: "unauthenticated" };
  }
  if (orgRole !== "org:admin") {
    return { error: "forbidden" };
  }

  const title = input.title.trim();
  if (title.length < 2) {
    return { error: "invalid-title" };
  }

  try {
    const [count, limits] = await Promise.all([countOrgProjects(orgId), getUserPlanLimits()]);
    if (count >= limits.maxProjectsPerOrganization) {
      return { error: "limit-reached" };
    }
    await setOrgPlanLimits(orgId, {
      maxProjects: limits.maxProjectsPerOrganization,
      maxCollaborators: limits.maxCollaboratorsPerProject,
      maxSizeBytes: limits.maxProjectSizeMb * 1024 * 1024,
    });
    const id = await createProjectDoc(
      orgId,
      title,
      input.description,
      input.tags,
      limits.maxProjectsPerOrganization,
    );
    return { id };
  } catch (error) {
    if (error instanceof Error && error.message.includes("too-many-projects")) {
      return { error: "limit-reached" };
    }
    logServerError("dashboard.create_project_failed", error, { clerkOrgId: orgId, userId });
    return { error: "failed" };
  }
}
