"use client";

import { useMutation, useQuery } from "convex/react";
import { Download, Loader2, PackageOpen } from "lucide-react";
import { useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { notify } from "@/components/ui/toast";
import { api } from "@/convex/_generated/api";
import { formatBytes, formatDateTime, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export function OrganizationExport({ clerkOrgId }: { clerkOrgId: string }) {
  const jobs = useQuery(api.organizationExports.list, { clerkOrgId });
  const requestExport = useMutation(api.organizationExports.request);
  const [busy, setBusy] = useState(false);
  const current = jobs?.find((job) => job.state === "queued" || job.state === "running");
  return (
    <div className="border-hairline border-t pt-6">
      <div className="flex items-start gap-3">
        <PackageOpen className="mt-0.5 size-5 text-accent" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 className="font-serif text-xl">Organization export</h2>
          <p className="mt-1 text-muted-foreground text-sm">
            Capture every active project as an independent ZIP plus a timestamped manifest.
            Downloads expire after 24 hours.
          </p>
          <Button
            className="mt-4 h-11"
            disabled={busy || Boolean(current)}
            onClick={async () => {
              setBusy(true);
              try {
                await requestExport({ clerkOrgId });
                notify.success("Organization export queued");
              } catch {
                notify.error("Couldn’t start export", {
                  description: "An export may already be running.",
                });
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy || current ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : null}
            {current
              ? `${current.completedCount} of ${current.projectCount} projects`
              : "Create organization export"}
          </Button>
          <ul className="mt-4 space-y-3">
            {(jobs ?? []).map((job) => (
              <li key={job.id} className="rounded-sm border border-hairline p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-medium text-sm capitalize">{job.state}</p>
                    <p className="text-muted-foreground text-xs">
                      {job.completedCount} of {job.projectCount} projects ·{" "}
                      <time
                        dateTime={new Date(job.createdAt).toISOString()}
                        title={formatDateTime(job.createdAt)}
                        suppressHydrationWarning
                      >
                        {formatRelativeTime(job.createdAt)}
                      </time>
                    </p>
                  </div>
                  {job.error ? <span className="text-destructive text-xs">{job.error}</span> : null}
                </div>
                {job.state === "completed" ? (
                  <div className="mt-3 flex flex-wrap gap-2 border-hairline border-t pt-3">
                    {job.files.map((file) => (
                      <a
                        key={`${file.projectId}-${file.name}`}
                        href={`/api/organization-exports/${job.id}/${encodeURIComponent(file.name)}`}
                        className={cn(buttonVariants({ variant: "secondary", size: "sm" }))}
                      >
                        <Download className="size-3.5" aria-hidden="true" />
                        {file.name} · {formatBytes(file.size)}
                      </a>
                    ))}
                    {job.hasManifest ? (
                      <a
                        href={`/api/organization-exports/${job.id}/manifest.json`}
                        className={cn(buttonVariants({ variant: "secondary", size: "sm" }))}
                      >
                        <Download className="size-3.5" aria-hidden="true" />
                        Manifest
                      </a>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
