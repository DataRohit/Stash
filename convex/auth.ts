import type { UserIdentity } from "convex/server";

type OrganizationClaim = {
  id?: unknown;
  rol?: unknown;
};

function compactOrganizationClaim(identity: UserIdentity): OrganizationClaim | null {
  const claim = identity.o;
  if (!claim || typeof claim !== "object" || Array.isArray(claim)) {
    return null;
  }
  return claim as OrganizationClaim;
}

export function organizationId(identity: UserIdentity): string | null {
  if (typeof identity.org_id === "string") {
    return identity.org_id;
  }
  const id = compactOrganizationClaim(identity)?.id;
  return typeof id === "string" ? id : null;
}

export function organizationRole(identity: UserIdentity): string | null {
  const role =
    typeof identity.org_role === "string"
      ? identity.org_role
      : compactOrganizationClaim(identity)?.rol;
  if (typeof role !== "string" || role.length === 0) {
    return null;
  }
  return role.startsWith("org:") ? role : `org:${role}`;
}

export function belongsToOrganization(identity: UserIdentity, clerkOrgId: string): boolean {
  return organizationId(identity) === clerkOrgId;
}

export function isOrganizationAdmin(identity: UserIdentity, clerkOrgId: string): boolean {
  return belongsToOrganization(identity, clerkOrgId) && organizationRole(identity) === "org:admin";
}
