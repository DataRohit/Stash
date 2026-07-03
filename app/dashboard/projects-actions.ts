"use server";

import { auth } from "@clerk/nextjs/server";
import { countOrgProjects, createProjectDoc } from "@/lib/convex-server";
import { getUserPlanLimits } from "@/lib/plan-limits";

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
    const id = await createProjectDoc(orgId, title, input.description, input.tags);
    return { id };
  } catch {
    return { error: "failed" };
  }
}
