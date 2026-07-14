"use client";

import { useClerk } from "@clerk/nextjs";
import {
  Calendar,
  Check,
  Globe,
  ImagePlus,
  Mail,
  Pencil,
  Plus,
  RotateCcw,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  useRef,
  useState,
  useTransition,
} from "react";
import {
  deleteOrganization,
  resetOrganizationLogo,
  setOrganizationPublicSharing,
  updateOrganization,
  updateOrganizationLogo,
} from "@/app/dashboard/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { notify } from "@/components/ui/toast";
import { MAX_DESCRIPTION_LENGTH, MAX_IMAGE_BYTES, MAX_TAG_LENGTH, MAX_TAGS } from "@/lib/org";
import { cn } from "@/lib/utils";

const LOGO_ERRORS: Record<string, string> = {
  unauthenticated: "Your session expired. Sign in again.",
  forbidden: "Only organization admins can change the icon.",
  invalid: "Choose a valid image file.",
  "invalid-type": "Choose an image file (PNG, JPG, WEBP or SVG).",
  "too-large": "Maximum size is 2 MB.",
  failed: "Something went wrong. Please try again.",
};

type OrgCardProps = {
  name: string;
  createdAt: number;
  adminName: string;
  adminEmail: string;
  description: string;
  tags: string[];
  imageUrl: string | null;
  defaultIconUrl: string;
  isAdmin: boolean;
  canDelete: boolean;
  publicSharingEnabled: boolean;
};

const UPDATE_ERRORS: Record<string, string> = {
  unauthenticated: "Your session expired. Sign in again.",
  forbidden: "Only organization admins can edit these details.",
  "invalid-name": "Enter a name with at least 2 characters.",
  "duplicate-name": "You already have an organization with that name.",
  "too-many-tags": "You can add up to 8 tags.",
  failed: "Something went wrong. Please try again.",
};

const DELETE_ERRORS: Record<string, string> = {
  unauthenticated: "Your session expired. Sign in again.",
  forbidden: "Only organization admins can delete this organization.",
  "last-org": "This is your only organization — create another before deleting it.",
  "last-owned-org": "This is the only organization you own — create another before deleting it.",
  failed: "Something went wrong. Please try again.",
};

const INLINE_UPDATE_ERRORS = new Set(["invalid-name", "duplicate-name", "too-many-tags"]);

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeZone: "UTC",
});

const labelClass = "font-medium font-mono text-muted-foreground text-xs uppercase tracking-widest";
const fieldClass =
  "rounded-sm border border-hairline bg-surface/45 px-3 text-sm outline-none transition-colors focus-visible:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60";

export function OrgCard(props: OrgCardProps) {
  const {
    name,
    createdAt,
    adminName,
    adminEmail,
    description,
    tags,
    imageUrl,
    defaultIconUrl,
    isAdmin,
    canDelete,
    publicSharingEnabled,
  } = props;
  const router = useRouter();
  const { setActive } = useClerk();

  const [publicSharing, setPublicSharing] = useState(publicSharingEnabled);
  const [togglingShare, startShareToggle] = useTransition();

  const togglePublicSharing = () => {
    const next = !publicSharing;
    setPublicSharing(next);
    startShareToggle(async () => {
      const result = await setOrganizationPublicSharing(next);
      if ("error" in result) {
        setPublicSharing(!next);
        notify.error("Couldn’t update sharing", {
          description: UPDATE_ERRORS[result.error] ?? "Please try again.",
        });
        return;
      }
      notify.success(next ? "Public link sharing enabled" : "Public link sharing disabled");
      router.refresh();
    });
  };

  const [mode, setMode] = useState<"view" | "edit">("view");
  const [draftName, setDraftName] = useState(name);
  const [draftDescription, setDraftDescription] = useState(description);
  const [draftTags, setDraftTags] = useState<string[]>(tags);
  const [tagInput, setTagInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, startSave] = useTransition();
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [deleting, startDelete] = useTransition();

  const iconUrl = imageUrl ?? defaultIconUrl;

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
    const formData = new FormData();
    formData.append("file", file);
    const result = await updateOrganizationLogo(formData);
    setUploading(false);
    if ("error" in result) {
      notify.error("Couldn’t update icon", {
        description: LOGO_ERRORS[result.error] ?? "Please try again.",
      });
      return;
    }
    notify.success("Icon updated");
    router.refresh();
  };

  const handleResetIcon = async () => {
    setUploading(true);
    const result = await resetOrganizationLogo();
    setUploading(false);
    if ("error" in result) {
      notify.error("Couldn’t reset icon", {
        description: LOGO_ERRORS[result.error] ?? "Please try again.",
      });
      return;
    }
    notify.success("Icon reset to default");
    router.refresh();
  };

  const beginEdit = () => {
    setDraftName(name);
    setDraftDescription(description);
    setDraftTags(tags);
    setTagInput("");
    setError(null);
    setMode("edit");
  };

  const cancelEdit = () => {
    setError(null);
    setMode("view");
  };

  const addTag = () => {
    const tag = tagInput.trim();
    if (tag.length === 0 || tag.length > MAX_TAG_LENGTH) {
      return;
    }
    if (draftTags.length >= MAX_TAGS) {
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

  const removeTag = (index: number) => {
    setDraftTags(draftTags.filter((_, position) => position !== index));
  };

  const handleSave = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    startSave(async () => {
      const result = await updateOrganization({
        name: draftName,
        description: draftDescription,
        tags: draftTags,
      });
      if ("error" in result) {
        const message = UPDATE_ERRORS[result.error] ?? "Something went wrong. Please try again.";
        if (INLINE_UPDATE_ERRORS.has(result.error)) {
          setError(message);
        } else {
          notify.error("Couldn’t save changes", { description: message });
        }
        return;
      }
      setMode("view");
      notify.success("Changes saved");
      router.refresh();
    });
  };

  const confirmDelete = () => {
    startDelete(async () => {
      const result = await deleteOrganization();
      if ("error" in result) {
        const message = DELETE_ERRORS[result.error] ?? "Something went wrong. Please try again.";
        if (result.error === "last-org") {
          notify.warning("Can’t delete organization", { description: message });
        } else {
          notify.error("Couldn’t delete organization", { description: message });
        }
        return;
      }
      const deletedName = name;
      setDeleteOpen(false);
      setConfirmName("");
      await setActive({ organization: result.nextOrgId });
      notify.success("Organization deleted", {
        description: `${deletedName} was permanently deleted.`,
      });
      router.refresh();
    });
  };

  return (
    <section className="glass w-full max-w-7xl rounded-lg p-6 sm:p-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          {mode === "view" ? (
            <Image
              src={iconUrl}
              alt=""
              width={56}
              height={56}
              unoptimized
              className="size-14 shrink-0 rounded-lg border border-hairline bg-surface/60 object-cover"
            />
          ) : null}
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className={labelClass}>— Organization</span>
            <h1 className="break-words font-serif text-3xl tracking-display">
              {mode === "view" ? name : "Edit details"}
            </h1>
          </div>
        </div>

        {isAdmin && !deleteOpen ? (
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
            {mode === "view" ? (
              <>
                <Button variant="secondary" className="w-full sm:w-52" onClick={beginEdit}>
                  <Pencil className="size-4" aria-hidden="true" />
                  Edit details
                </Button>
                <Button
                  variant="destructive"
                  className="w-full sm:w-52"
                  onClick={() => setDeleteOpen(true)}
                  disabled={!canDelete}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                  Delete organization
                </Button>
              </>
            ) : (
              <>
                <Button
                  type="button"
                  variant="secondary"
                  className="w-full sm:w-52"
                  onClick={cancelEdit}
                  disabled={saving}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  form="org-edit-form"
                  className="w-full sm:w-52"
                  disabled={saving || draftName.trim().length < 2}
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
          <div className="grid gap-6 sm:grid-cols-3">
            <Meta icon={<Calendar className="size-3.5" aria-hidden="true" />} label="Created">
              {dateFormatter.format(new Date(createdAt))}
            </Meta>
            <Meta icon={<ShieldCheck className="size-3.5" aria-hidden="true" />} label="Admin">
              {adminName}
            </Meta>
            <Meta icon={<Mail className="size-3.5" aria-hidden="true" />} label="Admin email">
              {adminEmail}
            </Meta>
          </div>

          <div className="grid gap-8 border-hairline border-t pt-6 lg:grid-cols-3">
            <div className="flex flex-col gap-2 lg:col-span-2">
              <span className={labelClass}>Description</span>
              <p className="text-sm leading-relaxed">
                {description ? (
                  description
                ) : (
                  <span className="text-muted-foreground">No description yet.</span>
                )}
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <span className={labelClass}>Tags</span>
              {tags.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {tags.map((tag) => (
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
            <div className="flex flex-col gap-3 border-hairline border-t pt-6">
              <span className={labelClass}>Sharing</span>
              <div className="flex items-start justify-between gap-3 rounded-md border border-hairline bg-surface/45 p-4">
                <div className="flex items-start gap-3">
                  <Globe
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <div className="flex flex-col gap-1">
                    <p className="font-medium text-sm">Public link sharing</p>
                    <p className="max-w-prose text-muted-foreground text-xs leading-relaxed">
                      When on, members can create links that anyone with the URL can open. Turning
                      it off hides the public option and makes existing public links require org
                      sign-in.
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={publicSharing}
                  aria-label="Public link sharing"
                  onClick={togglePublicSharing}
                  disabled={togglingShare}
                  className={cn(
                    "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border border-hairline transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                    publicSharing ? "bg-accent" : "bg-foreground/15",
                  )}
                >
                  <span
                    className={cn(
                      "inline-block size-4 rounded-full bg-white shadow-sm transition-transform",
                      publicSharing ? "translate-x-6" : "translate-x-1",
                    )}
                  />
                </button>
              </div>
            </div>
          ) : null}

          {isAdmin && deleteOpen ? (
            <div className="flex max-w-md flex-col gap-3 rounded-md border border-destructive/30 bg-destructive/[0.04] p-4">
              <div className="flex flex-col gap-1">
                <p className="font-medium text-sm">Delete this organization?</p>
                <p className="text-muted-foreground text-sm leading-relaxed">
                  This permanently removes <span className="text-foreground">{name}</span> for
                  everyone. Type the name to confirm.
                </p>
              </div>
              <input
                type="text"
                aria-label={`Type ${name} to confirm deletion`}
                value={confirmName}
                onChange={(event) => setConfirmName(event.target.value)}
                disabled={deleting}
                autoComplete="off"
                placeholder={name}
                className={`h-10 ${fieldClass}`}
              />
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="destructive"
                  className="w-full bg-destructive text-background hover:bg-destructive/90 hover:text-background"
                  onClick={confirmDelete}
                  disabled={deleting || confirmName.trim() !== name.trim()}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                  {deleting ? "Deleting…" : "Permanently delete"}
                </Button>
                <Button
                  variant="secondary"
                  className="w-full"
                  onClick={() => {
                    setDeleteOpen(false);
                    setConfirmName("");
                  }}
                  disabled={deleting}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}

          {isAdmin && !canDelete && !deleteOpen ? (
            <p className="text-muted-foreground text-xs">
              You must always own at least one organization. Create another one before deleting
              this.
            </p>
          ) : null}
        </div>
      ) : (
        <form id="org-edit-form" onSubmit={handleSave} className="mt-8 flex flex-col gap-8">
          <div className="grid gap-6 sm:grid-cols-3">
            <div className="flex flex-col gap-2">
              <span className={labelClass}>Icon</span>
              <div className="flex items-center gap-3">
                <Image
                  src={iconUrl}
                  alt=""
                  width={40}
                  height={40}
                  unoptimized
                  className="size-10 shrink-0 rounded-md border border-hairline bg-surface/60 object-cover"
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
                {imageUrl ? (
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
              <label htmlFor="org-name" className={labelClass}>
                Name
              </label>
              <input
                id="org-name"
                type="text"
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                disabled={saving}
                autoComplete="off"
                className={`h-9 max-w-sm ${fieldClass}`}
              />
            </div>
          </div>

          <div className="grid gap-8 border-hairline border-t pt-6 lg:grid-cols-3 lg:items-stretch">
            <div className="flex flex-col gap-2 lg:col-span-2">
              <div className="flex items-center justify-between gap-3">
                <label htmlFor="org-description" className={labelClass}>
                  Description
                </label>
                <span className="font-mono text-muted-foreground text-xs tabular-nums">
                  {draftDescription.length}/{MAX_DESCRIPTION_LENGTH}
                </span>
              </div>
              <textarea
                id="org-description"
                value={draftDescription}
                onChange={(event) =>
                  setDraftDescription(event.target.value.slice(0, MAX_DESCRIPTION_LENGTH))
                }
                disabled={saving}
                placeholder="What is this organization for?"
                className={`min-h-32 flex-1 resize-none py-2 ${fieldClass}`}
              />
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <label htmlFor="org-tags" className={labelClass}>
                  Tags
                </label>
                <span className="font-mono text-muted-foreground text-xs tabular-nums">
                  {draftTags.length}/{MAX_TAGS}
                </span>
              </div>
              <div className="flex min-h-32 flex-1 flex-col justify-between gap-2">
                {draftTags.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {draftTags.map((tag, index) => (
                      <Badge key={tag} variant="surface" className="pr-1">
                        {tag}
                        <button
                          type="button"
                          onClick={() => removeTag(index)}
                          disabled={saving}
                          aria-label={`Remove ${tag}`}
                          className="ml-0.5 inline-flex size-4 cursor-pointer items-center justify-center rounded-xs text-muted-foreground transition-colors hover:text-destructive"
                        >
                          <X className="size-3" aria-hidden="true" />
                        </button>
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <span />
                )}
                <div className="flex items-center gap-2">
                  <input
                    id="org-tags"
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
          </div>

          {error ? (
            <p role="alert" aria-live="assertive" className="text-destructive text-sm">
              {error}
            </p>
          ) : null}
        </form>
      )}
    </section>
  );
}

function Meta({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex items-center gap-1.5 font-medium font-mono text-muted-foreground text-xs uppercase tracking-widest">
        {icon}
        {label}
      </span>
      <span className="text-sm">{children}</span>
    </div>
  );
}
