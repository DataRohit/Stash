import { Loader2, TriangleAlert, Users } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { orgAvatarUrl } from "@/lib/org-avatar";

type ProjectCardProps = {
  id: string;
  title: string;
  description: string;
  tags: string[];
  imageUrl: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  ownerImageUrl: string | null;
  accessCount: number;
  isAdmin: boolean;
  orgName: string;
  orgIconUrl: string;
  cloneState: "copying" | "ready" | "failed";
  cloneCopied: number;
  cloneTotal: number;
};

export function ProjectCard({
  id,
  title,
  description,
  tags,
  imageUrl,
  ownerName,
  ownerEmail,
  ownerImageUrl,
  accessCount,
  isAdmin,
  orgName,
  orgIconUrl,
  cloneState,
  cloneCopied,
  cloneTotal,
}: ProjectCardProps) {
  return (
    <Link
      href={`/dashboard/projects/${id}`}
      aria-disabled={cloneState !== "ready"}
      className={`glass flex flex-col gap-4 rounded-lg p-6 transition-colors hover:border-foreground/20 ${cloneState !== "ready" ? "pointer-events-none opacity-75" : ""}`}
    >
      <div className="flex items-start gap-4">
        <Image
          src={imageUrl ?? orgAvatarUrl(id)}
          alt=""
          width={56}
          height={56}
          unoptimized
          className="size-14 shrink-0 rounded-lg border border-hairline object-cover"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="truncate font-serif text-xl tracking-display">{title}</p>
          <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
            <Image
              src={orgIconUrl}
              alt=""
              width={16}
              height={16}
              unoptimized
              className="size-4 shrink-0 rounded-xs border border-hairline object-cover"
            />
            <span className="truncate">{orgName}</span>
          </div>
        </div>
      </div>

      <p className="line-clamp-3 min-h-16 text-muted-foreground text-sm leading-relaxed">
        {description || "No description yet."}
      </p>
      {cloneState !== "ready" ? (
        <div className="flex items-center gap-2 rounded-md bg-foreground/[0.04] px-3 py-2 text-muted-foreground text-xs">
          {cloneState === "copying" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <TriangleAlert className="size-4 text-warning" />
          )}
          {cloneState === "copying"
            ? `Copying ${cloneCopied} of ${cloneTotal}`
            : "Copy failed. This project will be removed automatically."}
        </div>
      ) : null}

      {tags.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {tags.slice(0, 5).map((tag) => (
            <Badge key={tag} variant="surface">
              {tag}
            </Badge>
          ))}
          {tags.length > 5 ? <Badge variant="outline">+{tags.length - 5}</Badge> : null}
        </div>
      ) : null}

      <div className="mt-auto flex items-center justify-between gap-3 border-hairline border-t pt-4">
        <div className="flex min-w-0 items-center gap-2">
          {ownerImageUrl ? (
            <Image
              src={ownerImageUrl}
              alt=""
              width={24}
              height={24}
              unoptimized
              className="size-6 shrink-0 rounded-full border border-hairline object-cover"
            />
          ) : (
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-hairline bg-surface/60 font-medium font-mono text-[0.625rem] text-muted-foreground">
              {(ownerName ?? "?").slice(0, 1).toUpperCase()}
            </span>
          )}
          <span className="min-w-0 flex-1 text-muted-foreground text-xs">
            <span className="block truncate">
              {ownerName ? `Owned by ${ownerName}` : "Owner unknown"}
            </span>
            {ownerEmail ? (
              <span className="block truncate text-[11px] text-muted-foreground/80">
                {ownerEmail}
              </span>
            ) : null}
          </span>
        </div>
        {isAdmin ? (
          <div
            className="flex shrink-0 items-center gap-1.5 text-muted-foreground text-xs"
            title={`${accessCount} ${accessCount === 1 ? "member has" : "members have"} access`}
          >
            <Users className="size-3.5" aria-hidden="true" />
            {accessCount}
          </div>
        ) : null}
      </div>
    </Link>
  );
}
