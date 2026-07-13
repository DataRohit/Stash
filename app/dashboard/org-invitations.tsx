"use client";

import { useOrganizationList } from "@clerk/nextjs";
import { useQuery } from "convex/react";
import { Check, Loader2, MailPlus, X } from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { declineInvitation } from "@/app/dashboard/members-actions";
import { RoleBadge } from "@/components/dashboard/role-badge";
import { Button } from "@/components/ui/button";
import { notify } from "@/components/ui/toast";
import { api } from "@/convex/_generated/api";

const labelClass = "font-medium font-mono text-muted-foreground text-xs uppercase tracking-widest";

type Busy = { id: string; action: "accept" | "reject" } | null;

export function OrgInvitations() {
  const router = useRouter();
  const orgList = useOrganizationList({ userInvitations: { infinite: true } });
  const inviteSignal = useQuery(api.members.pendingForMe);
  const [busy, setBusy] = useState<Busy>(null);
  const [pending, startAction] = useTransition();

  const revalidateInvitations = orgList.isLoaded ? orgList.userInvitations.revalidate : undefined;
  const signalCount = inviteSignal?.length;

  useEffect(() => {
    revalidateInvitations?.();
  }, [revalidateInvitations, signalCount]);

  if (!orgList.isLoaded) {
    return null;
  }

  const { userInvitations, setActive } = orgList;
  const invitations = userInvitations.data;
  if (invitations.length === 0) {
    return null;
  }

  const accept = (invitation: (typeof invitations)[number]) => {
    setBusy({ id: invitation.id, action: "accept" });
    startAction(async () => {
      try {
        await invitation.accept();
        await setActive({ organization: invitation.publicOrganizationData.id });
        await userInvitations.revalidate?.();
        notify.success("Invitation accepted", {
          description: `You joined ${invitation.publicOrganizationData.name}.`,
        });
        router.push("/dashboard");
        router.refresh();
      } catch {
        notify.error("Couldn’t accept invitation", { description: "Please try again." });
      } finally {
        setBusy(null);
      }
    });
  };

  const reject = (invitation: (typeof invitations)[number]) => {
    setBusy({ id: invitation.id, action: "reject" });
    startAction(async () => {
      const result = await declineInvitation({ invitationId: invitation.id });
      if ("error" in result) {
        notify.error("Couldn’t decline invitation", { description: "Please try again." });
        setBusy(null);
        return;
      }
      await userInvitations.revalidate?.();
      notify.success("Invitation declined");
      setBusy(null);
      router.refresh();
    });
  };

  return (
    <section className="glass w-full max-w-7xl rounded-lg border-signal/30 p-6 sm:p-8">
      <div className="flex items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-signal/40 bg-signal/10 text-foreground">
          <MailPlus className="size-4" aria-hidden="true" />
        </span>
        <div className="flex flex-col gap-0.5">
          <span className={labelClass}>— Invitations</span>
          <h2 className="font-serif text-2xl tracking-display">You’ve been invited</h2>
        </div>
      </div>

      <ul className="mt-6 flex flex-col divide-y divide-hairline border-hairline border-t pt-2">
        {invitations.map((invitation) => {
          const org = invitation.publicOrganizationData;
          const roleLabel = invitation.role === "org:admin" ? "Admin" : "Member";
          const acceptBusy = busy?.id === invitation.id && busy.action === "accept";
          const rejectBusy = busy?.id === invitation.id && busy.action === "reject";
          return (
            <li
              key={invitation.id}
              className="flex flex-wrap items-center gap-3 py-3 sm:flex-nowrap"
            >
              <Image
                src={org.imageUrl}
                alt=""
                width={40}
                height={40}
                unoptimized
                className="size-10 shrink-0 rounded-md border border-hairline object-cover"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-sm">{org.name}</p>
                <p className="truncate text-muted-foreground text-xs">Invited as {roleLabel}</p>
              </div>
              <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto">
                <RoleBadge role={invitation.role} className="hidden sm:inline-flex" />
                <Button
                  variant="success"
                  className="flex-1 sm:w-24 sm:flex-none"
                  onClick={() => accept(invitation)}
                  disabled={pending}
                >
                  {acceptBusy ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <>
                      <Check className="size-4" aria-hidden="true" />
                      Accept
                    </>
                  )}
                </Button>
                <Button
                  variant="destructive"
                  className="flex-1 sm:w-24 sm:flex-none"
                  onClick={() => reject(invitation)}
                  disabled={pending}
                >
                  {rejectBusy ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <>
                      <X className="size-4" aria-hidden="true" />
                      Reject
                    </>
                  )}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
