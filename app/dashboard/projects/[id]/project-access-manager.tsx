"use client";

import { useMutation, useQuery } from "convex/react";
import { Check, Loader2, UserPlus, X } from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import { RoleBadge } from "@/components/dashboard/role-badge";
import { Button } from "@/components/ui/button";
import { notify } from "@/components/ui/toast";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { labelClass } from "@/lib/ui";
import { cn } from "@/lib/utils";

type ProjectAccessManagerProps = {
  projectId: string;
  clerkOrgId: string;
  accessUserIds: string[];
  maxCollaborators: number;
};

function initial(firstName: string | null, lastName: string | null, email: string): string {
  const full = [firstName, lastName].filter(Boolean).join(" ").trim();
  return (full.length > 0 ? full : email).slice(0, 1).toUpperCase();
}

export function ProjectAccessManager({
  projectId,
  clerkOrgId,
  accessUserIds,
  maxCollaborators,
}: ProjectAccessManagerProps) {
  const people = useQuery(api.members.listByOrg, { clerkOrgId });
  const grant = useMutation(api.projects.grantAccess);
  const revoke = useMutation(api.projects.revokeAccess);
  const [busyId, setBusyId] = useState<string | null>(null);

  const pid = projectId as Id<"projects">;
  const accessSet = new Set(accessUserIds);
  const used = accessUserIds.length;
  const full = used >= maxCollaborators;

  const toggle = async (userId: string, hasAccess: boolean) => {
    setBusyId(userId);
    try {
      if (hasAccess) {
        await revoke({ projectId: pid, userId });
      } else {
        await grant({ projectId: pid, userId });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("too-many-collaborators")) {
        notify.error("Collaborator limit reached", {
          description: "Upgrade your plan to grant access to more members on this project.",
        });
      } else {
        notify.error("Couldn’t update access", { description: "Please try again." });
      }
    } finally {
      setBusyId(null);
    }
  };

  const members = (people ?? []).filter((person) => person.status === "accepted");

  return (
    <div className="flex flex-col gap-3 border-hairline border-t pt-6">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="flex flex-col gap-1">
          <span className={labelClass}>Access</span>
          <p className="text-muted-foreground text-sm">
            Admins always have access. Grant specific members to unlock this project for them.
          </p>
        </div>
        <span
          className={cn(
            "shrink-0 font-mono text-xs tabular-nums",
            full ? "text-warning" : "text-muted-foreground",
          )}
        >
          {used} of {maxCollaborators} collaborators
        </span>
      </div>
      {full ? (
        <p className="text-warning text-xs">
          You’ve reached your plan’s collaborator limit for this project. Upgrade to add more.
        </p>
      ) : null}
      <ul className="flex flex-col divide-y divide-hairline">
        {members.map((person) => {
          const userId = person.memberUserId;
          const privileged = person.isOwner || person.role === "org:admin";
          const hasAccess = userId ? accessSet.has(userId) : false;
          const busy = busyId === userId;
          return (
            <li key={person.id} className="flex items-center gap-3 py-3">
              {person.imageUrl ? (
                <Image
                  src={person.imageUrl}
                  alt=""
                  width={36}
                  height={36}
                  unoptimized
                  className="size-9 shrink-0 rounded-md border border-hairline object-cover"
                />
              ) : (
                <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-hairline bg-surface/60 font-medium font-mono text-muted-foreground text-sm">
                  {initial(person.firstName, person.lastName, person.email)}
                </span>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-sm">
                  {[person.firstName, person.lastName].filter(Boolean).join(" ").trim() ||
                    person.email}
                </p>
                <p className="truncate text-muted-foreground text-xs">{person.email}</p>
              </div>
              <RoleBadge
                role={person.role}
                isOwner={person.isOwner}
                className="hidden sm:inline-flex"
              />
              {privileged ? (
                <span className="font-medium font-mono text-muted-foreground text-xs uppercase tracking-widest">
                  Full access
                </span>
              ) : hasAccess ? (
                <Button
                  variant="success"
                  size="sm"
                  className="group w-28 hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => userId && toggle(userId, true)}
                  disabled={busy || !userId}
                  aria-label="Revoke access"
                >
                  {busy ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <>
                      <span className="flex items-center gap-2 group-hover:hidden">
                        <Check className="size-4" aria-hidden="true" />
                        Access
                      </span>
                      <span className="hidden items-center gap-2 group-hover:flex">
                        <X className="size-4" aria-hidden="true" />
                        Revoke
                      </span>
                    </>
                  )}
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-28"
                  onClick={() => userId && toggle(userId, false)}
                  disabled={busy || !userId || full}
                  aria-label="Grant access"
                >
                  {busy ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <>
                      <UserPlus className="size-4" aria-hidden="true" />
                      Grant
                    </>
                  )}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
