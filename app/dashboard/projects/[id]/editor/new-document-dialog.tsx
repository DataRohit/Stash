"use client";

import { useQuery } from "convex/react";
import { FileCode, FileText, Loader2, NotebookPen } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { fieldClass } from "@/lib/ui";
import { cn } from "@/lib/utils";

type FileType = "md" | "html" | "doc";

export function NewDocumentDialog({
  open,
  projectId,
  parentId,
  onClose,
  onCreate,
}: {
  open: boolean;
  projectId: Id<"projects">;
  parentId: string | null;
  onClose: () => void;
  onCreate: (value: {
    parentId: string | null;
    name: string;
    fileType: FileType;
    templateId?: string;
  }) => Promise<void>;
}) {
  const templates = useQuery(api.templates.listForProject, open ? { projectId } : "skip");
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState("blank:md");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setName("");
    setSelected("blank:md");
    setError(null);
    onClose();
  };
  const choices = useMemo(
    () => [
      {
        id: "blank:md",
        name: "Blank Markdown",
        description: "A collaborative Markdown file.",
        fileType: "md" as const,
        preview: "",
      },
      {
        id: "blank:html",
        name: "Blank HTML",
        description: "A full HTML document with live preview.",
        fileType: "html" as const,
        preview: "",
      },
      {
        id: "blank:doc",
        name: "Blank Rich Text",
        description: "A visual rich-text document.",
        fileType: "doc" as const,
        preview: "",
      },
      ...(templates ?? []),
    ],
    [templates],
  );
  const choice = choices.find((item) => item.id === selected) ?? choices[0];
  const create = async () => {
    if (!choice || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate({
        parentId,
        name: name.trim(),
        fileType: choice.fileType,
        templateId: choice.id.startsWith("blank:") ? undefined : choice.id,
      });
      close();
    } catch (value) {
      const message = value instanceof Error ? value.message : "";
      setError(
        message.includes("name-taken")
          ? "A document with this name already exists here."
          : message.includes("project-full")
            ? "This project has reached its storage limit."
            : "Couldn’t create the document. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  const Icon =
    choice?.fileType === "html" ? FileCode : choice?.fileType === "doc" ? NotebookPen : FileText;
  return (
    <Dialog
      open={open}
      onClose={close}
      title="New document"
      icon={<NotebookPen className="size-4" />}
      description="Choose a format or reusable template."
      initialFocusRef={inputRef}
      className="max-w-2xl"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void create()} disabled={busy || !name.trim()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Icon className="size-4" />}Create
            document
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5 p-4">
        <div>
          <label
            htmlFor="new-document-name"
            className="font-mono text-muted-foreground text-xs uppercase tracking-widest"
          >
            Name
          </label>
          <input
            ref={inputRef}
            id="new-document-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void create();
              }
            }}
            placeholder={
              choice?.fileType === "doc"
                ? "Project brief"
                : choice?.fileType === "html"
                  ? "landing.html"
                  : "notes.md"
            }
            className={`mt-2 h-10 w-full ${fieldClass}`}
          />
        </div>
        <div>
          <p className="mb-2 font-mono text-muted-foreground text-xs uppercase tracking-widest">
            Template
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {choices.map((item) => (
              <button
                type="button"
                key={item.id}
                onClick={() => setSelected(item.id)}
                className={cn(
                  "min-h-24 cursor-pointer rounded-md border p-3 text-left transition-colors",
                  selected === item.id
                    ? "border-accent/50 bg-accent/10"
                    : "border-hairline hover:bg-foreground/[0.04]",
                )}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="font-medium text-sm">{item.name}</span>
                  <span className="rounded-xs bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-[10px] uppercase">
                    {item.fileType}
                  </span>
                </span>
                <span className="mt-1 block text-muted-foreground text-xs">{item.description}</span>
                {item.preview ? (
                  <span className="mt-2 line-clamp-2 block whitespace-pre-line text-[10px] text-muted-foreground/80">
                    {item.preview}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          {templates === undefined ? (
            <p className="mt-2 flex items-center gap-2 text-muted-foreground text-xs">
              <Loader2 className="size-3.5 animate-spin" />
              Loading organization templates…
            </p>
          ) : null}
        </div>
        {error ? <p className="text-destructive text-sm">{error}</p> : null}
      </div>
    </Dialog>
  );
}
