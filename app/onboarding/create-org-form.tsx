"use client";

import { useClerk } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { createOrganization } from "@/app/onboarding/actions";
import { Button } from "@/components/ui/button";
import { notify } from "@/components/ui/toast";

const ERROR_MESSAGES: Record<string, string> = {
  unauthenticated: "Your session expired. Sign in again.",
  invalid: "Enter a name with at least 2 characters.",
  duplicate: "You already have an organization with that name.",
  limit: "You've reached your plan's organization limit. Upgrade to add more.",
  failed: "Something went wrong. Please try again.",
};

const INLINE_CREATE_ERRORS = new Set(["invalid", "duplicate", "limit"]);

type CreateOrgFormProps = {
  used: number;
  max: number;
};

export function CreateOrgForm({ used, max }: CreateOrgFormProps) {
  const router = useRouter();
  const { setActive } = useClerk();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const remaining = Math.max(max - used, 0);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createOrganization(name);
      if ("error" in result) {
        const message = ERROR_MESSAGES[result.error] ?? "Something went wrong. Please try again.";
        if (INLINE_CREATE_ERRORS.has(result.error)) {
          setError(message);
        } else {
          notify.error("Couldn’t create organization", { description: message });
        }
        return;
      }
      await setActive({ organization: result.id });
      notify.success("Organization created", {
        description: `${name.trim()} is ready to use.`,
      });
      router.push("/dashboard");
      router.refresh();
    });
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <label
            htmlFor="organization-name"
            className="font-medium font-mono text-muted-foreground text-xs uppercase tracking-widest"
          >
            Organization name
          </label>
          <span className="font-mono text-muted-foreground text-xs tabular-nums">
            {remaining} of {max} left
          </span>
        </div>
        <input
          id="organization-name"
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Your organization"
          autoComplete="off"
          disabled={pending}
          className="h-10 rounded-sm border border-hairline bg-surface/45 px-3 text-sm outline-none transition-colors focus-visible:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
        />
      </div>

      {error ? (
        <p role="alert" aria-live="assertive" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}

      <Button type="submit" disabled={pending || name.trim().length < 2}>
        {pending ? "Creating…" : "Create organization"}
      </Button>
    </form>
  );
}
