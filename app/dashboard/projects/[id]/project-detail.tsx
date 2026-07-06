"use client";

import { useAuth } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import {
  ArrowLeft,
  Calendar,
  Check,
  Clock,
  HardDrive,
  ImagePlus,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { ProjectAccessManager } from "@/app/dashboard/projects/[id]/project-access-manager";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { notify } from "@/components/ui/toast";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { MAX_DESCRIPTION_LENGTH, MAX_IMAGE_BYTES, MAX_TAG_LENGTH, MAX_TAGS } from "@/lib/org";
import { orgAvatarUrl } from "@/lib/org-avatar";
import { fieldClass, labelClass } from "@/lib/ui";
import { cn } from "@/lib/utils";

type ProjectDetailProps = {
  projectId: string;
  clerkOrgId: string;
};

const dateFormatter = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });
const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

const DEFAULT_MAX_PROJECT_BYTES = 8 * 1024 * 1024;

function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function AccessLostState({ reason }: { reason: "org" | "access" }) {
  return (
    <section className="glass rounded-lg p-6 text-center sm:p-8">
      <div className="mx-auto flex max-w-md flex-col items-center gap-3">
        <p className="font-serif text-2xl tracking-display">Project access changed</p>
        <p className="text-muted-foreground text-sm leading-relaxed">
          {reason === "org"
            ? "Your active organization changed in another tab. This project view is no longer tied to your current organization."
            : "You no longer have access to this project, or it was removed while this tab was open."}
        </p>
        <Link
          href="/dashboard/projects"
          className={cn(buttonVariants({ variant: "primary" }), "mt-1 w-40")}
        >
          Back to projects
        </Link>
      </div>
    </section>
  );
}

export function ProjectDetail({ projectId, clerkOrgId }: ProjectDetailProps) {
  const router = useRouter();
  const { orgId, isLoaded: authLoaded } = useAuth();
  const orgChanged = authLoaded && orgId !== clerkOrgId;
  const pid = projectId as Id<"projects">;
  const project = useQuery(api.projects.get, orgChanged ? "skip" : { projectId: pid });
  const accessLost = orgChanged ? "org" : project === null ? "access" : null;
  const usage = useQuery(api.documents.usage, accessLost ? "skip" : { projectId: pid });

  const updateProject = useMutation(api.projects.update);
  const removeProject = useMutation(api.projects.remove);
  const generateUploadUrl = useMutation(api.projects.generateUploadUrl);
  const setImage = useMutation(api.projects.setImage);
  const removeImage = useMutation(api.projects.removeImage);

  const [mode, setMode] = useState<"view" | "edit">("view");
  const [draftTitle, setDraftTitle] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftTags, setDraftTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmTitle, setConfirmTitle] = useState("");
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (orgChanged) {
      router.refresh();
    }
  }, [orgChanged, router]);

  if (accessLost) {
    return <AccessLostState reason={accessLost} />;
  }

  if (project === undefined) {
    return (
      <section className="glass flex items-center gap-2 rounded-lg p-6 text-muted-foreground text-sm sm:p-8">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        Loading project…
      </section>
    );
  }
  if (project === null) {
    return <AccessLostState reason="access" />;
  }
  const isAdmin = project.isAdmin;
  const iconUrl = project.imageUrl ?? orgAvatarUrl(project.id);

  const beginEdit = () => {
    setDraftTitle(project.title);
    setDraftDescription(project.description);
    setDraftTags(project.tags);
    setTagInput("");
    setError(null);
    setMode("edit");
  };

  const addTag = () => {
    const tag = tagInput.trim();
    if (tag.length === 0 || tag.length > MAX_TAG_LENGTH || draftTags.length >= MAX_TAGS) {
      return;
    }
    if (draftTags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) {
      setTagInput("");
      return;
    }
    setDraftTags([...draftTags, tag]);
    setTagInput("");
  };

  const handleTagKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      addTag();
    }
  };

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await updateProject({
        projectId: pid,
        title: draftTitle,
        description: draftDescription,
        tags: draftTags,
      });
      setMode("view");
      notify.success("Changes saved");
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    if (!file.type.startsWith("image/")) {
      notify.error("Unsupported file", { description: "Choose an image file (PNG, JPG or SVG)." });
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      notify.error("Image too large", { description: "Maximum size is 2 MB." });
      return;
    }
    setUploading(true);
    try {
      const uploadUrl = await generateUploadUrl({ clerkOrgId });
      const response = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!response.ok) {
        throw new Error("upload failed");
      }
      const { storageId } = (await response.json()) as { storageId: Id<"_storage"> };
      await setImage({ projectId: pid, storageId });
      notify.success("Icon updated");
    } catch {
      notify.error("Couldn’t update icon", { description: "Please try again." });
    } finally {
      setUploading(false);
    }
  };

  const handleResetIcon = async () => {
    setUploading(true);
    try {
      await removeImage({ projectId: pid });
      notify.success("Icon reset to default");
    } catch {
      notify.error("Couldn’t reset icon", { description: "Please try again." });
    } finally {
      setUploading(false);
    }
  };

  const confirmDelete = async () => {
    setDeleting(true);
    try {
      await removeProject({ projectId: pid });
      notify.success("Project deleted");
      router.push("/dashboard/projects");
      router.refresh();
    } catch {
      notify.error("Couldn’t delete project", { description: "Please try again." });
      setDeleting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Link
        href="/dashboard/projects"
        className="flex w-fit items-center gap-1.5 font-medium font-mono text-muted-foreground text-xs uppercase tracking-widest transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        Projects
      </Link>

      <section className="glass w-full rounded-lg p-6 sm:p-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            {mode === "view" ? (
              <img
                src={iconUrl}
                alt=""
                className="size-14 shrink-0 rounded-lg border border-hairline object-cover"
              />
            ) : null}
            <div className="flex flex-col gap-1">
              <span className={labelClass}>— Project</span>
              <h1 className="font-serif text-3xl tracking-display">
                {mode === "view" ? project.title : "Edit project"}
              </h1>
            </div>
          </div>

          {!deleteOpen ? (
            <div className="flex items-center gap-2">
              {mode === "view" ? (
                <>
                  <Link
                    href={`/dashboard/projects/${project.id}/editor`}
                    className={cn(buttonVariants({ variant: "primary" }), "w-40")}
                  >
                    <SquarePen className="size-4" aria-hidden="true" />
                    Open editor
                  </Link>
                  {isAdmin ? (
                    <>
                      <Button variant="secondary" className="w-40" onClick={beginEdit}>
                        <Pencil className="size-4" aria-hidden="true" />
                        Edit details
                      </Button>
                      <Button
                        variant="destructive"
                        className="w-40"
                        onClick={() => setDeleteOpen(true)}
                      >
                        <Trash2 className="size-4" aria-hidden="true" />
                        Delete
                      </Button>
                    </>
                  ) : null}
                </>
              ) : (
                <>
                  <Button
                    type="button"
                    variant="secondary"
                    className="w-40"
                    onClick={() => setMode("view")}
                    disabled={saving}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    form="project-edit-form"
                    className="w-40"
                    disabled={saving || draftTitle.trim().length < 2}
                  >
                    <Check className="size-4" aria-hidden="true" />
                    {saving ? "Saving…" : "Save changes"}
                  </Button>
                </>
              )}
            </div>
          ) : null}
        </div>

        {mode === "view" ? (
          <div className="mt-8 flex flex-col gap-8">
            <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex flex-wrap gap-x-12 gap-y-6">
                <div className="flex flex-col gap-1.5">
                  <span className="flex items-center gap-1.5 font-medium font-mono text-muted-foreground text-xs uppercase tracking-widest">
                    <Calendar className="size-3.5" aria-hidden="true" />
                    Created
                  </span>
                  <span className="text-sm">
                    {dateFormatter.format(new Date(project.createdAt))}
                  </span>
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="flex items-center gap-1.5 font-medium font-mono text-muted-foreground text-xs uppercase tracking-widest">
                    <Clock className="size-3.5" aria-hidden="true" />
                    Updated
                  </span>
                  <span className="text-sm">
                    {project.lastSavedAt === null ? (
                      <span className="text-muted-foreground">No saves yet</span>
                    ) : (
                      dateTimeFormatter.format(new Date(project.lastSavedAt))
                    )}
                  </span>
                </div>
              </div>
              <div className="flex flex-col gap-1.5 sm:items-end">
                <span className="flex items-center gap-1.5 font-medium font-mono text-muted-foreground text-xs uppercase tracking-widest">
                  <HardDrive className="size-3.5" aria-hidden="true" />
                  Storage
                </span>
                {(() => {
                  const usedBytes = usage?.usedBytes ?? 0;
                  const maxBytes = usage?.maxSizeBytes ?? DEFAULT_MAX_PROJECT_BYTES;
                  const usedPercent =
                    maxBytes > 0 ? Math.min(100, Math.round((usedBytes / maxBytes) * 100)) : 100;
                  return (
                    <div className="flex w-full max-w-sm flex-col gap-1.5">
                      <div className="flex items-center gap-3">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-foreground/10">
                          <div
                            className={cn(
                              "h-full rounded-full",
                              usedPercent >= 90 ? "bg-destructive" : "bg-accent",
                            )}
                            style={{ width: `${usedPercent}%` }}
                          />
                        </div>
                        <span className="shrink-0 font-mono text-muted-foreground text-xs tabular-nums">
                          {formatMb(usedBytes)}/{formatMb(maxBytes)} MB
                        </span>
                      </div>
                      <span className="text-muted-foreground text-xs sm:text-right">
                        {usedPercent}% of your plan’s project storage used.
                      </span>
                    </div>
                  );
                })()}
              </div>
            </div>

            <div className="grid gap-8 border-hairline border-t pt-6 lg:grid-cols-3">
              <div className="flex flex-col gap-2 lg:col-span-2">
                <span className={labelClass}>Description</span>
                <p className="text-sm leading-relaxed">
                  {project.description || (
                    <span className="text-muted-foreground">No description yet.</span>
                  )}
                </p>
              </div>
              <div className="flex flex-col gap-2">
                <span className={labelClass}>Tags</span>
                {project.tags.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {project.tags.map((tag) => (
                      <Badge key={tag} variant="surface">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <p className="text-muted-foreground text-sm">No tags yet.</p>
                )}
              </div>
            </div>

            {isAdmin ? (
              <ProjectAccessManager
                projectId={project.id}
                clerkOrgId={clerkOrgId}
                accessUserIds={project.accessUserIds}
                maxCollaborators={project.maxCollaborators}
              />
            ) : null}

            {isAdmin && deleteOpen ? (
              <div className="flex max-w-md flex-col gap-3 rounded-md border border-destructive/30 bg-destructive/[0.04] p-4">
                <div className="flex flex-col gap-1">
                  <p className="font-medium text-sm">Delete this project?</p>
                  <p className="text-muted-foreground text-sm leading-relaxed">
                    This permanently removes{" "}
                    <span className="text-foreground">{project.title}</span> and all its access.
                    Type the title to confirm.
                  </p>
                </div>
                <input
                  type="text"
                  value={confirmTitle}
                  onChange={(event) => setConfirmTitle(event.target.value)}
                  disabled={deleting}
                  autoComplete="off"
                  placeholder={project.title}
                  className={`h-10 ${fieldClass}`}
                />
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="destructive"
                    className="w-full bg-destructive text-background hover:bg-destructive/90 hover:text-background"
                    onClick={confirmDelete}
                    disabled={deleting || confirmTitle.trim() !== project.title.trim()}
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                    {deleting ? "Deleting…" : "Permanently delete"}
                  </Button>
                  <Button
                    variant="secondary"
                    className="w-full"
                    onClick={() => {
                      setDeleteOpen(false);
                      setConfirmTitle("");
                    }}
                    disabled={deleting}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <form id="project-edit-form" onSubmit={handleSave} className="mt-8 flex flex-col gap-8">
            <div className="grid gap-6 sm:grid-cols-3">
              <div className="flex flex-col gap-2">
                <span className={labelClass}>Icon</span>
                <div className="flex items-center gap-3">
                  <img
                    src={iconUrl}
                    alt=""
                    className="size-10 shrink-0 rounded-md border border-hairline object-cover"
                  />
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/svg+xml"
                    onChange={handleFile}
                    className="hidden"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading || saving}
                  >
                    <ImagePlus className="size-3.5" aria-hidden="true" />
                    {uploading ? "Uploading…" : "Upload"}
                  </Button>
                  {project.imageUrl ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={handleResetIcon}
                      disabled={uploading || saving}
                      aria-label="Reset icon"
                    >
                      <RotateCcw className="size-3.5" aria-hidden="true" />
                    </Button>
                  ) : null}
                </div>
                <p className="text-muted-foreground text-xs">PNG, JPG, WEBP or SVG. Max 2 MB.</p>
              </div>

              <div className="flex flex-col gap-2 sm:col-span-2">
                <label htmlFor="project-title" className={labelClass}>
                  Title
                </label>
                <input
                  id="project-title"
                  type="text"
                  value={draftTitle}
                  onChange={(event) => setDraftTitle(event.target.value)}
                  disabled={saving}
                  autoComplete="off"
                  className={`h-9 max-w-sm ${fieldClass}`}
                />
              </div>
            </div>

            <div className="grid gap-8 border-hairline border-t pt-6 lg:grid-cols-3">
              <div className="flex flex-col gap-2 lg:col-span-2">
                <div className="flex items-center justify-between gap-3">
                  <label htmlFor="project-description" className={labelClass}>
                    Description
                  </label>
                  <span className="font-mono text-muted-foreground text-xs tabular-nums">
                    {draftDescription.length}/{MAX_DESCRIPTION_LENGTH}
                  </span>
                </div>
                <textarea
                  id="project-description"
                  value={draftDescription}
                  onChange={(event) =>
                    setDraftDescription(event.target.value.slice(0, MAX_DESCRIPTION_LENGTH))
                  }
                  disabled={saving}
                  placeholder="What is this project for?"
                  className={`min-h-32 resize-none py-2 ${fieldClass}`}
                />
              </div>

              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3">
                  <label htmlFor="project-tags" className={labelClass}>
                    Tags
                  </label>
                  <span className="font-mono text-muted-foreground text-xs tabular-nums">
                    {draftTags.length}/{MAX_TAGS}
                  </span>
                </div>
                {draftTags.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {draftTags.map((tag, index) => (
                      <Badge key={tag} variant="surface" className="pr-1">
                        {tag}
                        <button
                          type="button"
                          onClick={() => setDraftTags(draftTags.filter((_, i) => i !== index))}
                          disabled={saving}
                          aria-label={`Remove ${tag}`}
                          className="ml-0.5 inline-flex size-4 cursor-pointer items-center justify-center rounded-xs text-muted-foreground transition-colors hover:text-destructive"
                        >
                          <X className="size-3" aria-hidden="true" />
                        </button>
                      </Badge>
                    ))}
                  </div>
                ) : null}
                <div className="flex items-center gap-2">
                  <input
                    id="project-tags"
                    type="text"
                    value={tagInput}
                    onChange={(event) => setTagInput(event.target.value)}
                    onKeyDown={handleTagKeyDown}
                    disabled={saving || draftTags.length >= MAX_TAGS}
                    maxLength={MAX_TAG_LENGTH}
                    autoComplete="off"
                    placeholder={draftTags.length >= MAX_TAGS ? "Tag limit reached" : "Add a tag"}
                    className={`h-10 flex-1 ${fieldClass}`}
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon"
                    className="size-10 shrink-0"
                    onClick={addTag}
                    disabled={
                      saving || draftTags.length >= MAX_TAGS || tagInput.trim().length === 0
                    }
                    aria-label="Add tag"
                  >
                    <Plus className="size-4" aria-hidden="true" />
                  </Button>
                </div>
              </div>
            </div>

            {error ? <p className="text-destructive text-sm">{error}</p> : null}
          </form>
        )}
      </section>
    </div>
  );
}
