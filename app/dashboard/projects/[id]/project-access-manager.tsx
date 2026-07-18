"use client";

import { useMutation, useQuery } from "convex/react";
import { Loader2, Mail, UserPlus, X } from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import { inviteGuest } from "@/app/dashboard/members-actions";
import { RoleBadge } from "@/components/dashboard/role-badge";
import { Button } from "@/components/ui/button";
import { notify } from "@/components/ui/toast";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { labelClass } from "@/lib/ui";
import { cn } from "@/lib/utils";

type GrantLevel = "viewer" | "editor";

type ProjectAccessManagerProps = {
  projectId: string;
  clerkOrgId: string;
  access: { userId: string; level: GrantLevel }[];
  maxCollaborators: number;
};

function initial(firstName: string | null, lastName: string | null, email: string): string {
  const full = [firstName, lastName].filter(Boolean).join(" ").trim();
  return (full.length > 0 ? full : email).slice(0, 1).toUpperCase();
}

export function ProjectAccessManager({
  projectId,
  clerkOrgId,
  access,
  maxCollaborators,
}: ProjectAccessManagerProps) {
  const people = useQuery(api.members.listByOrg, { clerkOrgId });
  const grant = useMutation(api.projects.grantAccess);
  const revoke = useMutation(api.projects.revokeAccess);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [guestEmail, setGuestEmail] = useState("");
  const [guestLevel, setGuestLevel] = useState<GrantLevel>("viewer");
  const [invitingGuest, setInvitingGuest] = useState(false);

  const pid = projectId as Id<"projects">;
  const levelByUser = new Map(access.map((row) => [row.userId, row.level]));
  const used = access.length;
  const full = used >= maxCollaborators;

  const run = async (userId: string, action: () => Promise<unknown>) => {
    setBusyId(userId);
    try {
      await action();
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

  const submitGuest = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setInvitingGuest(true);
    const result = await inviteGuest({ projectId, email: guestEmail, level: guestLevel });
    setInvitingGuest(false);
    if ("error" in result) {
      const messages: Record<string, string> = {
        "invalid-email": "Enter a valid email address.",
        "already-invited": "That person already has a pending invitation.",
        "guest-limit-reached": "Your organization has reached its guest limit.",
      };
      notify.error("Couldn’t invite guest", {
        description: messages[result.error] ?? "Check your Clerk guest role and try again.",
      });
      return;
    }
    setGuestEmail("");
    notify.success("Guest invited", {
      description: `They will only see this project as a ${guestLevel}.`,
    });
  };

  return (
    <div className="flex flex-col gap-3 border-hairline border-t pt-6">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="flex flex-col gap-1">
          <span className={labelClass}>Access</span>
          <p className="text-muted-foreground text-sm">
            Admins always have full access. Grant members as an editor or a read-only viewer.
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
          const level = userId ? levelByUser.get(userId) : undefined;
          const hasAccess = Boolean(level);
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
              ) : hasAccess && userId ? (
                <div className="flex items-center gap-1.5">
                  <fieldset className="flex items-center gap-0.5 rounded-sm border border-hairline p-0.5">
                    <legend className="sr-only">Access level</legend>
                    {(["viewer", "editor"] as const).map((option) => (
                      <button
                        key={option}
                        type="button"
                        aria-pressed={level === option}
                        disabled={busy || level === option}
                        onClick={() =>
                          run(userId, () => grant({ projectId: pid, userId, level: option }))
                        }
                        className={cn(
                          "flex h-7 cursor-pointer items-center rounded-xs px-2.5 font-medium text-xs capitalize transition-colors disabled:cursor-default",
                          level === option
                            ? "bg-foreground/[0.08] text-foreground"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {option}
                      </button>
                    ))}
                  </fieldset>
                  <button
                    type="button"
                    aria-label="Revoke access"
                    disabled={busy}
                    onClick={() => run(userId, () => revoke({ projectId: pid, userId }))}
                    className="flex shrink-0 cursor-pointer items-center justify-center rounded-sm border border-hairline p-0.5 text-muted-foreground transition-colors hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive disabled:cursor-default"
                  >
                    <span className="flex size-7 items-center justify-center">
                      {busy ? (
                        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                      ) : (
                        <X className="size-4" aria-hidden="true" />
                      )}
                    </span>
                  </button>
                </div>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-28"
                  onClick={() =>
                    userId && run(userId, () => grant({ projectId: pid, userId, level: "editor" }))
                  }
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
      <form
        onSubmit={submitGuest}
        className="mt-2 flex flex-col gap-3 rounded-lg border border-hairline bg-foreground/[0.025] p-4"
      >
        <div>
          <p className="flex items-center gap-2 font-medium text-sm">
            <Mail className="size-4 text-muted-foreground" aria-hidden="true" />
            Invite a guest
          </p>
          <p className="mt-1 text-muted-foreground text-xs leading-relaxed">
            They will only see this project. Guests cannot create projects, templates, shares, or
            manage organization settings.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <label className="min-w-0 flex-1">
            <span className="sr-only">Guest email</span>
            <input
              type="email"
              required
              autoComplete="email"
              value={guestEmail}
              onChange={(event) => setGuestEmail(event.target.value)}
              placeholder="client@example.com"
              className="h-11 w-full rounded-sm border border-hairline bg-background px-3 text-sm outline-none transition-colors focus:border-accent"
            />
          </label>
          <label>
            <span className="sr-only">Guest access level</span>
            <select
              value={guestLevel}
              onChange={(event) => setGuestLevel(event.target.value as GrantLevel)}
              className="h-11 w-full rounded-sm border border-hairline bg-background px-3 text-sm outline-none focus:border-accent sm:w-28"
            >
              <option value="viewer">Viewer</option>
              <option value="editor">Editor</option>
            </select>
          </label>
          <Button type="submit" className="h-11 sm:w-28" disabled={invitingGuest || !guestEmail}>
            {invitingGuest ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <UserPlus className="size-4" aria-hidden="true" />
            )}
            Invite
          </Button>
        </div>
      </form>
    </div>
  );
}
