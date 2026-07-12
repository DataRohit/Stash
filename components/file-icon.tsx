import { FileCode, FileText, FileType, Folder, Image as ImageIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type FileIconProps = {
  kind: "folder" | "file" | "asset";
  fileType?: "md" | "html" | "doc" | null;
  className?: string;
};

export function FileIcon({ kind, fileType, className }: FileIconProps) {
  const base = cn("size-4 shrink-0", className);
  if (kind === "folder") {
    return <Folder className={cn(base, "text-muted-foreground")} aria-hidden="true" />;
  }
  if (kind === "asset") {
    return <ImageIcon className={cn(base, "text-info")} aria-hidden="true" />;
  }
  if (fileType === "html") {
    return <FileCode className={cn(base, "text-warning")} aria-hidden="true" />;
  }
  if (fileType === "doc") {
    return <FileType className={cn(base, "text-success")} aria-hidden="true" />;
  }
  return <FileText className={cn(base, "text-accent")} aria-hidden="true" />;
}
