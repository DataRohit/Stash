"use client";

import { useMutation, useQuery } from "convex/react";
import { Copy, Globe2, Loader2, RotateCw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { notify } from "@/components/ui/toast";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

export function ProjectShareControl({ projectId }: { projectId: string }) {
  const id = projectId as Id<"projects">;
  const [open, setOpen] = useState(false);
  const state = useQuery(api.projectSharing.getState, { projectId: id });
  const documents = useQuery(api.documents.listByProject, open ? { projectId: id } : "skip");
  const setShare = useMutation(api.projectSharing.set);
  const rotate = useMutation(api.projectSharing.rotate);
  const [busy, setBusy] = useState(false);
  const [exclusions, setExclusions] = useState<Set<string>>(new Set());
  const shareUrl = state?.token
    ? `${typeof window === "undefined" ? "" : window.location.origin}/share/project/${state.token}`
    : null;

  const setMode = async (
    mode: "private" | "org" | "public",
    expiresAt = state?.expiresAt ?? null,
  ) => {
    setBusy(true);
    try {
      await setShare({
        projectId: id,
        mode,
        expiresAt,
        excludedDocumentIds: [...exclusions].map((documentId) => documentId as Id<"documents">),
      });
      notify.success(mode === "private" ? "Project link revoked" : "Project sharing updated");
    } catch (error) {
      notify.error("Couldn’t update sharing", {
        description:
          error instanceof Error && error.message.includes("public-sharing-disabled")
            ? "Public sharing is disabled for this organization."
            : "Please try again.",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        variant="secondary"
        className="w-full sm:w-40"
        disabled={!state}
        onClick={() => {
          if (!state) return;
          setExclusions(new Set(state.excludedDocumentIds.map(String)));
          setOpen(true);
        }}
      >
        <Globe2 className="size-4" aria-hidden="true" />
        Share project
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Share project"
        description="Create one read-only link for the project. Visitors can browse every active document not excluded from the share."
        mobileSheet
      >
        <div className="flex flex-col gap-4 p-5">
          <fieldset className="grid gap-2">
            <legend className="mb-2 font-medium text-sm">Who can open this project?</legend>
            {(
              [
                ["private", "Private", "No link access"],
                ["org", "Organization", "Signed-in people with project access"],
                ["public", "Public read", "Anyone with the link"],
              ] as const
            ).map(([mode, label, description]) => (
              <button
                key={mode}
                type="button"
                disabled={busy || !state || (mode === "public" && !state.canPublish)}
                aria-pressed={state?.mode === mode}
                onClick={() => void setMode(mode)}
                className="flex min-h-14 cursor-pointer items-center justify-between rounded-sm border border-hairline px-3 text-left transition-colors hover:bg-foreground/[0.04] disabled:cursor-not-allowed disabled:opacity-50 aria-pressed:border-accent/50 aria-pressed:bg-accent/10"
              >
                <span>
                  <span className="block font-medium text-sm">{label}</span>
                  <span className="block text-muted-foreground text-xs">{description}</span>
                </span>
                {busy && state?.mode !== mode ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : null}
              </button>
            ))}
          </fieldset>
          <fieldset className="border-hairline border-t pt-4">
            <legend className="font-medium text-sm">Excluded documents</legend>
            <p className="mt-1 text-muted-foreground text-xs">
              Checked files stay private even when the project link is active.
            </p>
            <div className="thin-scrollbar mt-3 max-h-48 overflow-y-auto rounded-sm border border-hairline p-1">
              {(documents ?? [])
                .filter((document) => document.kind !== "folder")
                .map((document) => {
                  const checked = exclusions.has(document.id);
                  return (
                    <label
                      key={document.id}
                      className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xs px-2 text-sm hover:bg-foreground/[0.04]"
                    >
                      <input
                        type="checkbox"
                        checked={Boolean(checked)}
                        onChange={(event) => {
                          const next = new Set(exclusions);
                          if (event.target.checked) next.add(document.id);
                          else next.delete(document.id);
                          setExclusions(next);
                        }}
                      />
                      <span className="truncate">{document.name}</span>
                    </label>
                  );
                })}
            </div>
            <Button
              type="button"
              variant="secondary"
              className="mt-2"
              disabled={busy || !state}
              onClick={() => void setMode(state?.mode ?? "private")}
            >
              Save exclusions
            </Button>
          </fieldset>
          {shareUrl ? (
            <div className="flex gap-2 border-hairline border-t pt-4">
              <input
                readOnly
                value={shareUrl}
                aria-label="Project share link"
                className="h-11 min-w-0 flex-1 rounded-sm border border-hairline bg-background px-3 font-mono text-xs"
              />
              <Button
                variant="secondary"
                size="icon"
                aria-label="Copy project share link"
                onClick={() => void navigator.clipboard.writeText(shareUrl)}
              >
                <Copy className="size-4" aria-hidden="true" />
              </Button>
              <Button
                variant="secondary"
                size="icon"
                aria-label="Rotate project share link"
                onClick={async () => {
                  setBusy(true);
                  try {
                    await rotate({ projectId: id });
                    notify.success("Project link rotated");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <RotateCw className="size-4" aria-hidden="true" />
              </Button>
            </div>
          ) : null}
          {shareUrl ? (
            <fieldset className="border-hairline border-t pt-4">
              <legend className="font-medium text-sm">Link expiry</legend>
              <div className="mt-2 grid grid-cols-4 gap-2">
                {(
                  [
                    ["None", null],
                    ["1 day", 1],
                    ["7 days", 7],
                    ["30 days", 30],
                  ] as const
                ).map(([label, days]) => (
                  <button
                    key={label}
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void setMode(
                        state?.mode ?? "private",
                        days === null ? null : Date.now() + days * 24 * 60 * 60 * 1_000,
                      )
                    }
                    className="min-h-11 rounded-sm border border-hairline px-2 text-xs hover:bg-foreground/[0.04] disabled:opacity-50"
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-muted-foreground text-xs">
                {state?.expiresAt
                  ? `Expires ${new Date(state.expiresAt).toLocaleString()}`
                  : "This link does not expire automatically."}
              </p>
            </fieldset>
          ) : null}
          <p className="text-muted-foreground text-xs leading-relaxed">
            A project share explicitly includes active documents even when their individual link is
            private. Use exclusions before sharing sensitive files.
          </p>
          {state?.events.length ? (
            <div className="border-hairline border-t pt-4">
              <p className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
                Recent sharing activity
              </p>
              <ul className="mt-2 space-y-1">
                {state.events.map((event) => (
                  <li key={event.id} className="text-muted-foreground text-xs">
                    {event.actorName}{" "}
                    {event.previousMode === event.nextMode
                      ? "rotated the link"
                      : `changed ${event.previousMode} to ${event.nextMode}`}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </Dialog>
    </>
  );
}
