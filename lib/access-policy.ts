export type ProjectRole = "admin" | "editor" | "viewer" | null;

export function projectRole(isAdmin: boolean, grant: "editor" | "viewer" | null): ProjectRole {
  if (isAdmin) return "admin";
  return grant;
}

export function canEditProject(role: ProjectRole): boolean {
  return role === "admin" || role === "editor";
}

export function canAdministerProject(role: ProjectRole): boolean {
  return role === "admin";
}
