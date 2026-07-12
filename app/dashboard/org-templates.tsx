"use client";

import { useMutation, useQuery } from "convex/react";
import { Loader2, Pencil, Trash2 } from "lucide-react";
import { FileIcon } from "@/components/file-icon";
import { notify } from "@/components/ui/toast";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

export function OrgTemplates({ clerkOrgId, isAdmin }: { clerkOrgId: string; isAdmin: boolean }) {
  const templates = useQuery(api.templates.listForOrg, { clerkOrgId });
  const rename = useMutation(api.templates.rename);
  const remove = useMutation(api.templates.remove);
  return (
    <section className="glass w-full rounded-lg p-6 sm:p-8">
      <div>
        <span className="font-mono text-muted-foreground text-xs uppercase tracking-widest">
          — Reuse
        </span>
        <h2 className="mt-1 font-serif text-3xl tracking-display">Organization templates</h2>
        <p className="mt-2 text-muted-foreground text-sm">
          Templates saved from project documents are available to everyone in this organization.
        </p>
      </div>
      <div className="mt-6 border-hairline border-t pt-5">
        {templates === undefined ? (
          <p className="flex items-center gap-2 text-muted-foreground text-sm">
            <Loader2 className="size-4 animate-spin" />
            Loading templates…
          </p>
        ) : templates.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No organization templates yet. Admins can save one from an open document.
          </p>
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {templates.map((template) => {
              return (
                <li
                  key={template.id}
                  className="flex min-w-0 gap-3 rounded-md border border-hairline bg-surface/30 p-4"
                >
                  <FileIcon kind="file" fileType={template.fileType} className="mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate font-medium text-sm">{template.name}</p>
                      <span className="rounded-xs bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-[10px] uppercase">
                        {template.fileType}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-2 whitespace-pre-line text-muted-foreground text-xs">
                      {template.preview || "Empty template"}
                    </p>
                    <p className="mt-2 text-[10px] text-muted-foreground/70">
                      Saved by {template.creatorName} ·{" "}
                      {new Date(template.updatedAt).toLocaleDateString()}
                    </p>
                  </div>
                  {isAdmin ? (
                    <div className="flex shrink-0 gap-1">
                      <button
                        type="button"
                        aria-label={`Rename ${template.name}`}
                        onClick={() => {
                          const name = window.prompt("Rename template", template.name);
                          if (name?.trim())
                            void rename({
                              templateId: template.id as Id<"orgTemplates">,
                              name,
                            }).catch(() => notify.error("Couldn’t rename template"));
                        }}
                        className="flex size-8 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
                      >
                        <Pencil className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete ${template.name}`}
                        onClick={() => {
                          if (
                            window.confirm(
                              `Delete “${template.name}”? Existing documents will not change.`,
                            )
                          )
                            void remove({ templateId: template.id as Id<"orgTemplates"> })
                              .then(() => notify.success("Template deleted"))
                              .catch(() => notify.error("Couldn’t delete template"));
                        }}
                        className="flex size-8 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
