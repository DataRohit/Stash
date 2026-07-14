"use client";

import { useQuery } from "convex/react";
import { Check, ChevronDown, Loader2, Send, Trash2, UserPlus, X } from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState, useTransition } from "react";
import {
  cancelInvitation,
  inviteMember,
  type MemberRole,
  removeMember,
} from "@/app/dashboard/members-actions";
import { RoleBadge } from "@/components/dashboard/role-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataLoader } from "@/components/ui/data-state";
import { notify } from "@/components/ui/toast";
import { api } from "@/convex/_generated/api";

type OrgMembersProps = {
  clerkOrgId: string;
  currentUserId: string;
  isAdmin: boolean;
  maxMembers: number;
};

const MEMBER_ERRORS: Record<string, string> = {
  unauthenticated: "Your session expired. Sign in again.",
  forbidden: "Only organization admins can manage members.",
  "invalid-email": "Enter a valid email address.",
  "limit-reached": "You've reached your plan's member limit. Upgrade to invite more.",
  "no-account": "No Stash account uses that email — they need to sign up first.",
  "already-member": "That person is already a member.",
  "already-invited": "That email already has a pending invite.",
  "cannot-remove-owner": "The organization owner can't be removed.",
  "cannot-remove-self": "You can't remove yourself.",
  failed: "Something went wrong. Please try again.",
};

const labelClass = "font-medium font-mono text-muted-foreground text-xs uppercase tracking-widest";
const fieldClass =
  "rounded-sm border border-hairline bg-surface/45 px-3 text-sm outline-none transition-colors focus-visible:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60";

function displayName(firstName: string | null, lastName: string | null, email: string): string {
  const full = [firstName, lastName].filter(Boolean).join(" ").trim();
  return full.length > 0 ? full : email;
}

function initials(firstName: string | null, lastName: string | null, email: string): string {
  const full = [firstName, lastName].filter(Boolean).join(" ").trim();
  const source = full.length > 0 ? full : email;
  return source.slice(0, 1).toUpperCase();
}

const ROLE_OPTIONS: { value: MemberRole; label: string }[] = [
  { value: "org:member", label: "Member" },
  { value: "org:admin", label: "Admin" },
];

function RoleSelect({
  value,
  onChange,
  disabled,
}: {
  value: MemberRole;
  onChange: (value: MemberRole) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const currentLabel = value === "org:admin" ? "Admin" : "Member";

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <div ref={ref} className="relative w-36">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`flex h-10 w-full cursor-pointer items-center justify-between gap-2 ${fieldClass}`}
      >
        <span>{currentLabel}</span>
        <ChevronDown
          className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <ul className="absolute top-full left-0 z-20 mt-1 w-full overflow-hidden rounded-sm border border-hairline bg-surface p-1 shadow-glass">
          {ROLE_OPTIONS.map((option) => {
            const selected = option.value === value;
            return (
              <li key={option.value}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  className={`flex w-full cursor-pointer items-center justify-between rounded-xs px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-foreground/[0.06] ${selected ? "text-foreground" : "text-muted-foreground"}`}
                >
                  {option.label}
                  {selected ? <Check className="size-3.5 shrink-0" aria-hidden="true" /> : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

export function OrgMembers({ clerkOrgId, currentUserId, isAdmin, maxMembers }: OrgMembersProps) {
  const router = useRouter();
  const people = useQuery(api.members.listByOrg, { clerkOrgId });

  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MemberRole>("org:member");
  const [error, setError] = useState<string | null>(null);
  const [inviting, startInvite] = useTransition();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [acting, startAction] = useTransition();

  const used = people?.length ?? 0;
  const atLimit = used >= maxMembers;

  const handleInvite = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    startInvite(async () => {
      const result = await inviteMember({ email, role });
      if ("error" in result) {
        const message = MEMBER_ERRORS[result.error] ?? "Something went wrong. Please try again.";
        if (
          result.error === "invalid-email" ||
          result.error === "limit-reached" ||
          result.error === "no-account"
        ) {
          setError(message);
        } else {
          notify.error("Couldn’t send invite", { description: message });
        }
        return;
      }
      setEmail("");
      setRole("org:member");
      setInviteOpen(false);
      notify.success("Invitation sent", { description: `${email.trim()} was invited.` });
      router.refresh();
    });
  };

  const handleCancel = (invitationId: string, key: string) => {
    setPendingId(key);
    startAction(async () => {
      const result = await cancelInvitation({ invitationId });
      if ("error" in result) {
        notify.error("Couldn’t cancel invite", {
          description: MEMBER_ERRORS[result.error] ?? "Something went wrong. Please try again.",
        });
        return;
      }
      notify.success("Invitation cancelled");
      router.refresh();
    });
  };

  const handleRemove = (memberUserId: string, key: string) => {
    setPendingId(key);
    startAction(async () => {
      const result = await removeMember({ memberUserId });
      if ("error" in result) {
        notify.error("Couldn’t remove member", {
          description: MEMBER_ERRORS[result.error] ?? "Something went wrong. Please try again.",
        });
        return;
      }
      notify.success("Member removed");
      router.refresh();
    });
  };

  return (
    <section className="glass w-full max-w-7xl rounded-lg p-6 sm:p-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <span className={labelClass}>— Members</span>
          <h2 className="font-serif text-2xl tracking-display">People</h2>
        </div>
        {isAdmin ? (
          <div className="flex w-full flex-wrap items-center justify-between gap-3 sm:w-auto sm:justify-start">
            <span className="font-mono text-muted-foreground text-xs tabular-nums">
              {used} of {maxMembers} seats
            </span>
            <Button
              variant="secondary"
              className="w-full sm:w-44"
              onClick={() => {
                setInviteOpen((open) => !open);
                setError(null);
              }}
              disabled={atLimit && !inviteOpen}
            >
              <UserPlus className="size-4" aria-hidden="true" />
              {inviteOpen ? "Close" : "Invite member"}
            </Button>
          </div>
        ) : null}
      </div>

      {isAdmin && inviteOpen ? (
        <form
          onSubmit={handleInvite}
          className="mt-6 flex flex-col gap-3 rounded-md border border-hairline bg-surface/30 p-4 sm:flex-row sm:items-end"
        >
          <div className="flex flex-1 flex-col gap-2">
            <label htmlFor="invite-email" className={labelClass}>
              Email
            </label>
            <input
              id="invite-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={inviting}
              autoComplete="off"
              placeholder="teammate@example.com"
              className={`h-10 ${fieldClass}`}
            />
          </div>
          <div className="flex flex-col gap-2">
            <span className={labelClass}>Role</span>
            <RoleSelect value={role} onChange={setRole} disabled={inviting} />
          </div>
          <Button type="submit" className="sm:w-40" disabled={inviting || atLimit}>
            <Send className="size-4" aria-hidden="true" />
            {inviting ? "Sending…" : "Send invite"}
          </Button>
        </form>
      ) : null}

      {error ? (
        <p role="alert" aria-live="assertive" className="mt-3 text-destructive text-sm">
          {error}
        </p>
      ) : null}

      <div className="mt-6 border-hairline border-t pt-6">
        {people === undefined ? (
          <DataLoader label="Loading organization members" compact />
        ) : (
          <ul className="flex flex-col divide-y divide-hairline">
            {people.map((person) => {
              const key = person.id;
              const name = displayName(person.firstName, person.lastName, person.email);
              const isPending = person.status === "pending";
              const isSelf = person.memberUserId === currentUserId;
              const busy = acting && pendingId === key;
              return (
                <li key={key} className="flex flex-wrap items-center gap-3 py-3 sm:flex-nowrap">
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
                      {initials(person.firstName, person.lastName, person.email)}
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-sm">{name}</p>
                    <p className="truncate text-muted-foreground text-xs">{person.email}</p>
                  </div>
                  <div className="flex w-full shrink-0 flex-wrap items-center justify-end gap-2 sm:w-auto sm:flex-nowrap">
                    <RoleBadge role={person.role} isOwner={person.isOwner} />
                    {isPending ? (
                      <Badge variant="surface" className="text-warning">
                        Pending
                      </Badge>
                    ) : null}
                    {isAdmin && isPending && person.clerkInvitationId ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => handleCancel(person.clerkInvitationId as string, key)}
                        disabled={busy}
                        aria-label={`Cancel invite for ${person.email}`}
                      >
                        {busy ? (
                          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                        ) : (
                          <X className="size-4" aria-hidden="true" />
                        )}
                      </Button>
                    ) : null}
                    {isAdmin && !isPending && !person.isOwner && !isSelf && person.memberUserId ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => handleRemove(person.memberUserId as string, key)}
                        disabled={busy}
                        aria-label={`Remove ${person.email}`}
                      >
                        {busy ? (
                          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                        ) : (
                          <Trash2 className="size-4" aria-hidden="true" />
                        )}
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
