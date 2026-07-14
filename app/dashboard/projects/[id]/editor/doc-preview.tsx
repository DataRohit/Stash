"use client";

import { useQuery } from "convex/react";
import { type RefObject, useEffect, useId, useMemo, useState } from "react";
import {
  injectMermaid,
  previewSrcDoc,
  referencedAssetIds,
  renderInner,
  renderMermaid,
} from "@/app/dashboard/projects/[id]/editor/lib/doc-html";
import type { TreeNode } from "@/app/dashboard/projects/[id]/editor/tree-utils";
import { DataLoader } from "@/components/ui/data-state";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

type DocPreviewProps = {
  fileNode: TreeNode;
  content: string;
  nodes: TreeNode[];
  iframeRef?: RefObject<HTMLIFrameElement | null>;
  fileLinkById?: Record<string, string>;
};

const EMPTY_FILE_LINKS: Record<string, string> = {};

export function DocPreview({
  fileNode,
  content,
  nodes,
  iframeRef,
  fileLinkById = EMPTY_FILE_LINKS,
}: DocPreviewProps) {
  const noteId = useId();
  const [debounced, setDebounced] = useState(content);
  const [rendered, setRendered] = useState<{ key: string; doc: string } | null>(null);
  const [fileId, setFileId] = useState(fileNode.id);
  const [ready, setReady] = useState(false);

  if (fileId !== fileNode.id) {
    setFileId(fileNode.id);
    setDebounced(content);
    setRendered(null);
    setReady(false);
  }

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(content), 400);
    return () => clearTimeout(timer);
  }, [content]);

  const assetIds = useMemo(
    () => referencedAssetIds(fileNode, debounced, nodes),
    [debounced, fileNode, nodes],
  );
  const assetUrls = useQuery(
    api.documents.getAssetUrls,
    assetIds.length > 0 ? { documentIds: assetIds as Id<"documents">[] } : "skip",
  );
  const resolvedNodes = useMemo(() => {
    if (!assetUrls) {
      return nodes;
    }
    const urlById = new Map<string, string>(assetUrls.map((asset) => [asset.id, asset.url]));
    return nodes.map((node) => {
      const assetUrl = urlById.get(node.id);
      return assetUrl ? { ...node, assetUrl } : node;
    });
  }, [assetUrls, nodes]);

  const base = useMemo(() => {
    const { inner, isMd, blocks } = renderInner(fileNode, debounced, resolvedNodes, fileLinkById);
    return { inner, isMd, blocks, doc: previewSrcDoc(inner, isMd) };
  }, [debounced, fileLinkById, fileNode, resolvedNodes]);

  useEffect(() => {
    if (base.blocks.length === 0) {
      return;
    }
    const controller = new AbortController();
    void renderMermaid(base.blocks, "dark", controller.signal).then((svgs) => {
      if (controller.signal.aborted || svgs.size === 0) {
        return;
      }
      const inner = injectMermaid(base.inner, svgs);
      setRendered({ key: base.inner, doc: previewSrcDoc(inner, base.isMd) });
    });
    return () => controller.abort();
  }, [base]);

  const srcDoc = rendered?.key === base.inner ? rendered.doc : base.doc;

  return (
    <div className="flex size-full flex-col">
      <p
        id={noteId}
        className="shrink-0 border-hairline border-b bg-foreground/[0.025] px-3 py-2 text-muted-foreground text-xs"
      >
        Read-only preview. Use the file tree or editor controls to navigate.
      </p>
      <div className="relative min-h-0 w-full flex-1">
        <iframe
          key={fileNode.id}
          ref={iframeRef}
          title="Document preview"
          aria-describedby={noteId}
          tabIndex={-1}
          srcDoc={srcDoc}
          onLoad={() => setReady(true)}
          sandbox="allow-scripts allow-popups allow-top-navigation-by-user-activation"
          className="editor-panel size-full border-0"
        />
        {ready ? null : (
          <DataLoader label="Rendering preview" className="editor-panel absolute inset-0" />
        )}
      </div>
    </div>
  );
}
