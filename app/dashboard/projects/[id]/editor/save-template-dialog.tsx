"use client";

import { BookmarkPlus, Loader2 } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { fieldClass } from "@/lib/ui";

export function SaveTemplateDialog({
  open,
  documentName,
  fileType,
  onClose,
  onSave,
}: {
  open: boolean;
  documentName: string;
  fileType: string;
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setName("");
    setError(null);
    onClose();
  };
  const save = async () => {
    if (name.trim().length < 2) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(name.trim());
      close();
    } catch (value) {
      const message = value instanceof Error ? value.message : "";
      setError(
        message.includes("template-name-taken")
          ? "A template with this name already exists."
          : message.includes("template-limit")
            ? "This organization already has 50 templates."
            : "Couldn’t save this template. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Save as template"
      icon={<BookmarkPlus className="size-4" />}
      description={`Save ${documentName} as a reusable ${fileType.toUpperCase()} organization template.`}
      initialFocusRef={inputRef}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={busy || name.trim().length < 2}>
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <BookmarkPlus className="size-4" />
            )}
            Save template
          </Button>
        </div>
      }
    >
      <div className="p-4">
        <label
          htmlFor="template-name"
          className="font-mono text-muted-foreground text-xs uppercase tracking-widest"
        >
          Template name
        </label>
        <input
          ref={inputRef}
          id="template-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void save();
            }
          }}
          placeholder="Team project brief"
          className={`mt-2 h-10 w-full ${fieldClass}`}
        />
        {error ? <p className="mt-2 text-destructive text-sm">{error}</p> : null}
      </div>
    </Dialog>
  );
}
