"use client";

import { useQuery } from "convex/react";
import { FileCode, FileText, Loader2, NotebookPen, TableProperties } from "lucide-react";
import { useRef, useState } from "react";
import { mapDocError } from "@/app/dashboard/projects/[id]/editor/lib/editor-format";
import { Button } from "@/components/ui/button";
import { DataLoader, DataState } from "@/components/ui/data-state";
import { Dialog } from "@/components/ui/dialog";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { FileType } from "@/lib/document-types";
import { fieldClass } from "@/lib/ui";
import { cn } from "@/lib/utils";

const MAX_FILE_NAME_LENGTH = 80;

const FILE_TYPES = [
  {
    id: "md",
    name: "Markdown",
    description: "A Markdown document.",
    extension: ".md",
  },
  {
    id: "html",
    name: "HTML",
    description: "An HTML document.",
    extension: ".html",
  },
  {
    id: "sheet",
    name: "Spreadsheet",
    description: "A collaborative typed grid.",
    extension: ".sheet",
  },
] as const;

function explicitFileType(name: string): FileType | null {
  const lower = name.trim().toLowerCase();
  if (lower.endsWith(".md")) return "md";
  if (lower.endsWith(".html")) return "html";
  if (lower.endsWith(".sheet")) return "sheet";
  return null;
}

function hasUnsupportedExtension(name: string): boolean {
  const trimmed = name.replaceAll("/", "").replaceAll("\\", "").trim();
  return /\.[^./\\]+$/.test(trimmed) && explicitFileType(trimmed) === null;
}

function hasMissingBaseName(name: string): boolean {
  const trimmed = name.replaceAll("/", "").replaceAll("\\", "").trim();
  const fileType = explicitFileType(trimmed);
  return fileType !== null && !trimmed.slice(0, -`.${fileType}`.length).trim();
}

function fileNameWithExtension(name: string, fileType: FileType) {
  const extension = `.${fileType}`;
  const sanitized = name.replaceAll("/", "").replaceAll("\\", "").trim();
  if (!sanitized) return "";
  if (hasUnsupportedExtension(sanitized)) return sanitized;
  const withoutSupportedExtension = sanitized.replace(/\.(md|html|sheet)$/i, "");
  const stem = sanitized.toLowerCase().endsWith(extension)
    ? sanitized.slice(0, -extension.length)
    : withoutSupportedExtension;
  return `${stem.slice(0, MAX_FILE_NAME_LENGTH - extension.length).trim()}${extension}`;
}

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
  const [fileType, setFileType] = useState<FileType>("md");
  const [templateId, setTemplateId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setName("");
    setFileType("md");
    setTemplateId(undefined);
    setError(null);
    onClose();
  };
  const create = async () => {
    if (!name.trim()) return;
    if (hasUnsupportedExtension(name)) {
      setError("Only .md, .html, and .sheet file extensions are supported.");
      return;
    }
    if (hasMissingBaseName(name)) {
      setError("Enter a file name before the extension.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onCreate({
        parentId,
        name: name.trim(),
        fileType,
        templateId,
      });
      close();
    } catch (value) {
      setError(mapDocError(value, "Couldn’t create the document. Please try again."));
    } finally {
      setBusy(false);
    }
  };
  const Icon = fileType === "html" ? FileCode : fileType === "sheet" ? TableProperties : FileText;
  const finalName = fileNameWithExtension(name, fileType);
  const invalidExtension = hasUnsupportedExtension(name);
  const missingBaseName = hasMissingBaseName(name);
  return (
    <Dialog
      open={open}
      onClose={close}
      title="New document"
      icon={<NotebookPen className="size-4" />}
      description="Choose a file type or start from an organization template."
      initialFocusRef={inputRef}
      className="max-w-2xl"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void create()}
            disabled={busy || !name.trim() || invalidExtension || missingBaseName}
          >
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
            File name
          </label>
          <input
            ref={inputRef}
            id="new-document-name"
            value={name}
            onChange={(event) => {
              const nextName = event.target.value;
              setName(nextName);
              setError(null);
              const nextType = explicitFileType(nextName);
              if (nextType) {
                setFileType(nextType);
                setTemplateId(undefined);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void create();
              }
            }}
            placeholder="Enter a name"
            className={`mt-2 h-10 w-full ${fieldClass}`}
          />
          {invalidExtension ? (
            <p className="mt-1.5 text-destructive text-xs">
              Only .md, .html, and .sheet file extensions are supported.
            </p>
          ) : missingBaseName ? (
            <p className="mt-1.5 text-destructive text-xs">
              Enter a file name before the extension.
            </p>
          ) : finalName ? (
            <p className="mt-1.5 text-muted-foreground text-xs">
              This file will appear as{" "}
              <span className="font-mono text-foreground">{finalName}</span>.
            </p>
          ) : null}
        </div>
        <div>
          <p className="mb-2 font-mono text-muted-foreground text-xs uppercase tracking-widest">
            File type
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            {FILE_TYPES.map((item) => (
              <button
                type="button"
                key={item.id}
                aria-pressed={fileType === item.id && templateId === undefined}
                onClick={() => {
                  setName((current) =>
                    explicitFileType(current) ? fileNameWithExtension(current, item.id) : current,
                  );
                  setFileType(item.id);
                  setTemplateId(undefined);
                }}
                className={cn(
                  "cursor-pointer rounded-md border p-3 text-left transition-colors",
                  fileType === item.id && templateId === undefined
                    ? "border-accent/50 bg-accent/10"
                    : "border-hairline hover:bg-foreground/[0.04]",
                )}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="font-medium text-sm">{item.name}</span>
                  <span className="rounded-xs bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-[10px] uppercase">
                    {item.extension}
                  </span>
                </span>
                <span className="mt-1 block text-muted-foreground text-xs">{item.description}</span>
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="mb-2 font-mono text-muted-foreground text-xs uppercase tracking-widest">
            Organization templates
          </p>
          {templates === undefined ? (
            <DataLoader label="Loading organization templates" compact />
          ) : templates.length === 0 ? (
            <DataState
              title="No organization templates"
              description="Templates saved by your organization will appear here."
              compact
            />
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {templates.map((template) => (
                <button
                  type="button"
                  key={template.id}
                  aria-pressed={templateId === template.id}
                  onClick={() => {
                    setName((current) =>
                      explicitFileType(current)
                        ? fileNameWithExtension(current, template.fileType)
                        : current,
                    );
                    setFileType(template.fileType);
                    setTemplateId(template.id);
                  }}
                  className={cn(
                    "min-h-24 cursor-pointer rounded-md border p-3 text-left transition-colors",
                    templateId === template.id
                      ? "border-accent/50 bg-accent/10"
                      : "border-hairline hover:bg-foreground/[0.04]",
                  )}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-medium text-sm">{template.name}</span>
                    <span className="rounded-xs bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-[10px] uppercase">
                      .{template.fileType}
                    </span>
                  </span>
                  <span className="mt-1 block text-muted-foreground text-xs">
                    Organization template
                  </span>
                  {template.preview ? (
                    <span className="mt-2 line-clamp-2 block whitespace-pre-line text-[10px] text-muted-foreground/80">
                      {template.preview}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          )}
        </div>
        {error ? (
          <p role="alert" aria-live="assertive" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
