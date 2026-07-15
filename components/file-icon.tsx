import { FileCode, FileText, Folder, Image as ImageIcon, TableProperties } from "lucide-react";
import type { FileType } from "@/lib/document-types";
import { cn } from "@/lib/utils";

type FileIconProps = {
  kind: "folder" | "file" | "asset";
  fileType?: FileType | null;
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
  if (fileType === "sheet") {
    return <TableProperties className={cn(base, "text-info")} aria-hidden="true" />;
  }
  return <FileText className={cn(base, "text-accent")} aria-hidden="true" />;
}
