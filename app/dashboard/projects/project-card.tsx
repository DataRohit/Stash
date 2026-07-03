import { Users } from "lucide-react";
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
  ownerImageUrl: string | null;
  accessCount: number;
  isAdmin: boolean;
  orgName: string;
  orgIconUrl: string;
};

export function ProjectCard({
  id,
  title,
  description,
  tags,
  imageUrl,
  ownerName,
  ownerImageUrl,
  accessCount,
  isAdmin,
  orgName,
  orgIconUrl,
}: ProjectCardProps) {
  return (
    <Link
      href={`/dashboard/projects/${id}`}
      className="glass flex flex-col gap-4 rounded-[12px] p-6 transition-colors hover:border-foreground/20"
    >
      <div className="flex items-start gap-4">
        <img
          src={imageUrl ?? orgAvatarUrl(id)}
          alt=""
          className="size-14 shrink-0 rounded-[12px] border border-hairline object-cover"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="truncate font-serif text-xl tracking-display">{title}</p>
          <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
            <img
              src={orgIconUrl}
              alt=""
              className="size-4 shrink-0 rounded-[4px] border border-hairline object-cover"
            />
            <span className="truncate">{orgName}</span>
          </div>
        </div>
      </div>

      <p className="line-clamp-3 min-h-16 text-muted-foreground text-sm leading-relaxed">
        {description || "No description yet."}
      </p>

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
            <img
              src={ownerImageUrl}
              alt=""
              className="size-6 shrink-0 rounded-full border border-hairline object-cover"
            />
          ) : (
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-hairline bg-surface/60 font-medium font-mono text-[0.625rem] text-muted-foreground">
              {(ownerName ?? "?").slice(0, 1).toUpperCase()}
            </span>
          )}
          <span className="truncate text-muted-foreground text-xs">
            {ownerName ? `Owned by ${ownerName}` : "Owner unknown"}
          </span>
        </div>
        {isAdmin ? (
          <div className="flex shrink-0 items-center gap-1.5 text-muted-foreground text-xs">
            <Users className="size-3.5" aria-hidden="true" />
            {accessCount}
          </div>
        ) : null}
      </div>
    </Link>
  );
}
