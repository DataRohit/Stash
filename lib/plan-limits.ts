import { getUserSubscription } from "@/lib/subscription";

export type PlanLimits = {
  maxOrganizations: number;
  maxProjectsPerOrganization: number;
  maxCollaboratorsPerProject: number;
};

const DEFAULT_LIMITS: PlanLimits = {
  maxOrganizations: 1,
  maxProjectsPerOrganization: 5,
  maxCollaboratorsPerProject: 5,
};

const ORGANIZATIONS_PATTERN = /^(\d+)_organizations?$/;
const PROJECTS_PATTERN = /^(\d+)_projects_per_organization$/;
const COLLABORATORS_PATTERN = /^(\d+)_collaborators_per_project$/;

function firstMatch(slugs: string[], pattern: RegExp): number | null {
  for (const slug of slugs) {
    const match = slug.match(pattern);
    if (match) {
      return Number(match[1]);
    }
  }
  return null;
}

export function limitsFromFeatures(featureSlugs: string[]): PlanLimits {
  if (featureSlugs.length === 0) {
    return DEFAULT_LIMITS;
  }

  return {
    maxOrganizations:
      firstMatch(featureSlugs, ORGANIZATIONS_PATTERN) ?? DEFAULT_LIMITS.maxOrganizations,
    maxProjectsPerOrganization:
      firstMatch(featureSlugs, PROJECTS_PATTERN) ?? DEFAULT_LIMITS.maxProjectsPerOrganization,
    maxCollaboratorsPerProject:
      firstMatch(featureSlugs, COLLABORATORS_PATTERN) ?? DEFAULT_LIMITS.maxCollaboratorsPerProject,
  };
}

export async function getUserPlanLimits(): Promise<PlanLimits> {
  const { featureSlugs } = await getUserSubscription();
  return limitsFromFeatures(featureSlugs);
}
