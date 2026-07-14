"use client";

import { useConvex } from "convex/react";
import { Download, FileText, Globe, Loader2, Package, Printer } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { referencedAssetIds } from "@/app/dashboard/projects/[id]/editor/lib/doc-html";
import {
  type BundleNode,
  exportHtml,
  exportMarkdown,
  exportPdf,
  exportProjectZip,
} from "@/app/dashboard/projects/[id]/editor/lib/export-doc";
import type { TreeNode } from "@/app/dashboard/projects/[id]/editor/tree-utils";
import { notify } from "@/components/ui/toast";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { cn } from "@/lib/utils";

type ExportMenuProps = {
  projectId: Id<"projects">;
  fileNode: TreeNode;
  content: string;
  nodes: TreeNode[];
};

type Action = "md" | "html" | "pdf" | "zip";

export function ExportMenu({ projectId, fileNode, content, nodes }: ExportMenuProps) {
  const convex = useConvex();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Action | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointer = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onPointer);
    return () => window.removeEventListener("mousedown", onPointer);
  }, [open]);

  const run = async (action: Action, task: () => Promise<void> | void) => {
    if (busy) {
      return;
    }
    setBusy(action);
    try {
      await task();
      if (action !== "pdf") {
        notify.success(action === "zip" ? "Project exported" : "Export ready");
      }
      setOpen(false);
    } catch (error) {
      const message = error instanceof Error && error.message === "empty-project";
      notify.error("Export failed", {
        description: message
          ? "This project has no files to export yet."
          : "Something went wrong preparing the download.",
      });
    } finally {
      setBusy(null);
    }
  };

  const exportZip = () =>
    run("zip", async () => {
      const bundle = await convex.query(api.documents.exportBundle, { projectId });
      if (!bundle) {
        throw new Error("empty-project");
      }
      await exportProjectZip(bundle.projectTitle, bundle.nodes as BundleNode[]);
    });

  const nodesWithRenderedAssets = async () => {
    const documentIds = referencedAssetIds(fileNode, content, nodes) as Id<"documents">[];
    if (documentIds.length === 0) {
      return nodes;
    }
    const assetUrls = await convex.query(api.documents.getAssetUrls, { documentIds });
    const urlById = new Map<string, string>(assetUrls.map((asset) => [asset.id, asset.url]));
    return nodes.map((node) => {
      const assetUrl = urlById.get(node.id);
      return assetUrl ? { ...node, assetUrl } : node;
    });
  };

  const isMd = fileNode.fileType === "md";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label="Export"
        aria-pressed={open}
        className={cn(
          "flex size-8 cursor-pointer items-center justify-center rounded-sm border border-hairline transition-colors",
          open
            ? "bg-foreground/[0.08] text-foreground"
            : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground",
        )}
      >
        {busy ? (
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        ) : (
          <Download className="size-4" aria-hidden="true" />
        )}
      </button>
      {open ? (
        <div className="absolute top-9 right-0 z-[80] w-60 overflow-hidden rounded-lg border border-hairline bg-surface p-1 shadow-xl">
          <p className="px-2 py-1.5 font-medium font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
            Export this file
          </p>
          {isMd ? (
            <ExportItem
              icon={<FileText className="size-4 text-accent" aria-hidden="true" />}
              label="Markdown"
              hint=".md"
              loading={busy === "md"}
              disabled={Boolean(busy)}
              onClick={() => run("md", () => exportMarkdown(fileNode, content))}
            />
          ) : null}
          <ExportItem
            icon={<Globe className="size-4 text-info" aria-hidden="true" />}
            label="Web page"
            hint=".html"
            loading={busy === "html"}
            disabled={Boolean(busy)}
            onClick={() =>
              run("html", async () =>
                exportHtml(fileNode, content, await nodesWithRenderedAssets()),
              )
            }
          />
          <ExportItem
            icon={<Printer className="size-4 text-warning" aria-hidden="true" />}
            label="Print / PDF"
            hint="print"
            loading={busy === "pdf"}
            disabled={Boolean(busy)}
            onClick={() =>
              run("pdf", async () => exportPdf(fileNode, content, await nodesWithRenderedAssets()))
            }
          />
          <div className="my-1 h-px bg-hairline" />
          <p className="px-2 py-1.5 font-medium font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
            Export project
          </p>
          <ExportItem
            icon={<Package className="size-4 text-muted-foreground" aria-hidden="true" />}
            label="Whole project"
            hint=".zip"
            loading={busy === "zip"}
            disabled={Boolean(busy)}
            onClick={exportZip}
          />
        </div>
      ) : null}
    </div>
  );
}

function ExportItem({
  icon,
  label,
  hint,
  loading,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  loading: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-foreground/[0.04] disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="flex size-5 shrink-0 items-center justify-center">
        {loading ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
        {hint}
      </span>
    </button>
  );
}
