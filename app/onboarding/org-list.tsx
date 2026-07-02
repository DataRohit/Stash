"use client";

import { useClerk } from "@clerk/nextjs";
import { ChevronRight, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

type OrgListItem = {
  id: string;
  name: string;
  iconUrl: string;
};

export function OrgList({ organizations }: { organizations: OrgListItem[] }) {
  const { setActive } = useClerk();
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const select = (id: string) => {
    setPendingId(id);
    startTransition(async () => {
      await setActive({ organization: id });
      router.push("/dashboard");
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <span className="font-medium font-mono text-muted-foreground text-xs uppercase tracking-widest">
        Your organizations
      </span>
      <div className="divide-y divide-hairline overflow-hidden rounded-[8px] border border-hairline">
        {organizations.map((org) => (
          <button
            key={org.id}
            type="button"
            onClick={() => select(org.id)}
            disabled={pending}
            className="flex w-full cursor-pointer items-center gap-3 bg-surface/20 px-4 py-3 text-left transition-colors hover:bg-foreground/[0.04] disabled:cursor-not-allowed disabled:opacity-60"
          >
            <img
              src={org.iconUrl}
              alt=""
              className="size-8 shrink-0 rounded-[7px] border border-hairline bg-surface/60 object-cover"
            />
            <span className="flex-1 truncate font-medium text-sm">{org.name}</span>
            {pendingId === org.id ? (
              <Loader2
                className="size-4 shrink-0 animate-spin text-muted-foreground"
                aria-hidden="true"
              />
            ) : (
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
