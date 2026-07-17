"use client";

import { useQuery } from "convex/react";
import { FolderPlus, Plus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, type KeyboardEvent, useState, useTransition } from "react";
import { PersonalHome } from "@/app/dashboard/projects/personal-home";
import { ProjectCard } from "@/app/dashboard/projects/project-card";
import { createProject } from "@/app/dashboard/projects-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataLoader, DataState } from "@/components/ui/data-state";
import { notify } from "@/components/ui/toast";
import { api } from "@/convex/_generated/api";
import { MAX_TAG_LENGTH, MAX_TAGS } from "@/lib/org";
import { fieldClass, labelClass } from "@/lib/ui";

type ProjectsBoardProps = {
  clerkOrgId: string;
  isAdmin: boolean;
  maxProjects: number;
  orgName: string;
  orgIconUrl: string;
};

const CREATE_ERRORS: Record<string, string> = {
  unauthenticated: "Your session expired. Sign in again.",
  forbidden: "Only organization admins can create projects.",
  "invalid-title": "Enter a title with at least 2 characters.",
  "limit-reached": "You've reached your plan's project limit. Upgrade to add more.",
  failed: "Something went wrong. Please try again.",
};

export function ProjectsBoard({
  clerkOrgId,
  isAdmin,
  maxProjects,
  orgName,
  orgIconUrl,
}: ProjectsBoardProps) {
  const router = useRouter();
  const projects = useQuery(api.projects.listByOrg, { clerkOrgId });
  const favorites = useQuery(api.navigation.listFavorites, { clerkOrgId });
  const unread = useQuery(api.watches.listUnread, { documentIds: [] });

  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, startCreate] = useTransition();

  const used = projects?.length ?? 0;
  const atLimit = used >= maxProjects;

  const addTag = () => {
    const tag = tagInput.trim();
    if (tag.length === 0 || tag.length > MAX_TAG_LENGTH || tags.length >= MAX_TAGS) {
      return;
    }
    if (tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) {
      setTagInput("");
      return;
    }
    setTags([...tags, tag]);
    setTagInput("");
  };

  const handleTagKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      addTag();
    }
  };

  const handleCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    startCreate(async () => {
      const result = await createProject({ title, description, tags });
      if ("error" in result) {
        setError(CREATE_ERRORS[result.error] ?? "Something went wrong. Please try again.");
        return;
      }
      notify.success("Project created", { description: `${title.trim()} is ready.` });
      router.push(`/dashboard/projects/${result.id}`);
    });
  };

  return (
    <section className="glass w-full max-w-7xl rounded-lg p-6 sm:p-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <span className={labelClass}>— Projects</span>
          <h1 className="font-serif text-3xl tracking-display">Projects</h1>
        </div>
        {isAdmin ? (
          <div className="flex w-full flex-wrap items-center justify-between gap-3 sm:w-auto sm:justify-start">
            <span className="font-mono text-muted-foreground text-xs tabular-nums">
              {used} of {maxProjects}
            </span>
            <Button
              variant="secondary"
              className="w-full sm:w-44"
              onClick={() => {
                setCreateOpen((open) => !open);
                setError(null);
              }}
              disabled={atLimit && !createOpen}
            >
              <FolderPlus className="size-4" aria-hidden="true" />
              {createOpen ? "Close" : "New project"}
            </Button>
          </div>
        ) : null}
      </div>

      {isAdmin && atLimit && !createOpen ? (
        <p className="mt-3 text-muted-foreground text-xs">
          You’ve reached your plan’s project limit. Upgrade to add more.
        </p>
      ) : null}

      {isAdmin && createOpen ? (
        <form
          onSubmit={handleCreate}
          className="mt-6 flex flex-col gap-4 rounded-md border border-hairline bg-surface/30 p-4"
        >
          <div className="flex flex-col gap-2">
            <label htmlFor="project-title" className={labelClass}>
              Title
            </label>
            <input
              id="project-title"
              type="text"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              disabled={creating}
              autoComplete="off"
              placeholder="Marketing site"
              className={`h-10 ${fieldClass}`}
            />
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="project-description" className={labelClass}>
              Description
            </label>
            <textarea
              id="project-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              disabled={creating}
              placeholder="What is this project for?"
              className={`resize-none py-2 ${fieldClass}`}
            />
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <label htmlFor="project-tags" className={labelClass}>
                Tags
              </label>
              <span className="font-mono text-muted-foreground text-xs tabular-nums">
                {tags.length}/{MAX_TAGS}
              </span>
            </div>
            {tags.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {tags.map((tag, index) => (
                  <Badge key={tag} variant="surface" className="pr-1">
                    {tag}
                    <button
                      type="button"
                      onClick={() => setTags(tags.filter((_, i) => i !== index))}
                      disabled={creating}
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
                disabled={creating || tags.length >= MAX_TAGS}
                maxLength={MAX_TAG_LENGTH}
                autoComplete="off"
                placeholder={tags.length >= MAX_TAGS ? "Tag limit reached" : "Add a tag"}
                className={`h-10 flex-1 ${fieldClass}`}
              />
              <Button
                type="button"
                variant="secondary"
                size="icon"
                className="size-10 shrink-0"
                onClick={addTag}
                disabled={creating || tags.length >= MAX_TAGS || tagInput.trim().length === 0}
                aria-label="Add tag"
              >
                <Plus className="size-4" aria-hidden="true" />
              </Button>
            </div>
          </div>

          {error ? (
            <p role="alert" aria-live="assertive" className="text-destructive text-sm">
              {error}
            </p>
          ) : null}

          <div className="flex justify-end">
            <Button type="submit" className="w-40" disabled={creating || title.trim().length < 2}>
              {creating ? "Creating…" : "Create project"}
            </Button>
          </div>
        </form>
      ) : null}

      <div className="mt-6 border-hairline border-t pt-6">
        <PersonalHome clerkOrgId={clerkOrgId} />
        {projects === undefined ? (
          <DataLoader label="Loading projects" compact />
        ) : projects.length === 0 ? (
          <DataState
            title={isAdmin ? "No projects yet" : "No accessible projects"}
            description={
              isAdmin
                ? "Create your first project to start organizing documents."
                : "Ask an organization administrator to grant you project access."
            }
          />
        ) : (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((project) => (
              <ProjectCard
                key={project.id}
                id={project.id}
                title={project.title}
                description={project.description}
                tags={project.tags}
                imageUrl={project.imageUrl}
                ownerName={project.ownerName}
                ownerEmail={project.ownerEmail}
                ownerImageUrl={project.ownerImageUrl}
                accessCount={project.accessCount}
                isAdmin={isAdmin}
                orgName={orgName}
                orgIconUrl={orgIconUrl}
                cloneState={project.cloneState}
                cloneCopied={project.cloneCopied}
                cloneTotal={project.cloneTotal}
                favorite={
                  favorites?.some(
                    (item) => item.projectId === project.id && item.documentId === null,
                  ) ?? false
                }
                unread={unread?.projectIds.includes(project.id) ?? false}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
