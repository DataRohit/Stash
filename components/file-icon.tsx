import {
  BarChart3,
  Columns3,
  FileArchive,
  FileAudio,
  FileCode,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  Image as ImageIcon,
  LayoutList,
  TableProperties,
} from "lucide-react";
import { assetFamily } from "@/lib/asset-formats";
import type { FileType } from "@/lib/document-types";
import { cn } from "@/lib/utils";

type FileIconProps = {
  kind: "folder" | "file" | "asset";
  fileType?: FileType | null;
  mimeType?: string | null;
  className?: string;
};

export function FileIcon({ kind, fileType, mimeType, className }: FileIconProps) {
  const base = cn("size-4 shrink-0", className);
  if (kind === "folder") {
    return <Folder className={cn(base, "text-muted-foreground")} aria-hidden="true" />;
  }
  if (kind === "asset") {
    const family = assetFamily(mimeType ?? "");
    if (family === "archive") {
      return <FileArchive className={cn(base, "text-warning")} aria-hidden="true" />;
    }
    if (family === "audio") {
      return <FileAudio className={cn(base, "text-accent")} aria-hidden="true" />;
    }
    if (family === "video") {
      return <FileVideo className={cn(base, "text-accent")} aria-hidden="true" />;
    }
    if (family === "csv") {
      return <FileSpreadsheet className={cn(base, "text-info")} aria-hidden="true" />;
    }
    if (family === "pdf" || family === "text" || family === "unsafe") {
      return <FileText className={cn(base, "text-info")} aria-hidden="true" />;
    }
    return <ImageIcon className={cn(base, "text-info")} aria-hidden="true" />;
  }
  if (fileType === "html") {
    return <FileCode className={cn(base, "text-warning")} aria-hidden="true" />;
  }
  if (fileType === "sheet") {
    return <TableProperties className={cn(base, "text-info")} aria-hidden="true" />;
  }
  if (fileType === "board") {
    return <Columns3 className={cn(base, "text-accent")} aria-hidden="true" />;
  }
  if (fileType === "view") {
    return <LayoutList className={cn(base, "text-info")} aria-hidden="true" />;
  }
  if (fileType === "chart") {
    return <BarChart3 className={cn(base, "text-warning")} aria-hidden="true" />;
  }
  return <FileText className={cn(base, "text-accent")} aria-hidden="true" />;
}
