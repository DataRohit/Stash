import { Crown, ShieldCheck, User } from "lucide-react";
import { Badge } from "@/components/ui/badge";

type RoleBadgeProps = {
  role: string;
  isOwner?: boolean;
  className?: string;
};

export function RoleBadge({ role, isOwner = false, className }: RoleBadgeProps) {
  if (isOwner) {
    return (
      <Badge
        variant="outline"
        className={`border-signal/40 bg-signal/10 text-foreground ${className ?? ""}`}
      >
        <Crown className="size-3 shrink-0" aria-hidden="true" />
        Owner
      </Badge>
    );
  }
  if (role === "org:admin") {
    return (
      <Badge
        variant="outline"
        className={`border-accent/40 bg-accent/10 text-foreground ${className ?? ""}`}
      >
        <ShieldCheck className="size-3 shrink-0" aria-hidden="true" />
        Admin
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className={className}>
      <User className="size-3 shrink-0" aria-hidden="true" />
      Member
    </Badge>
  );
}
