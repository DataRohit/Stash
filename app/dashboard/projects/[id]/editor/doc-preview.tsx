"use client";

import { type RefObject, useEffect, useMemo, useState } from "react";
import {
  injectMermaid,
  previewSrcDoc,
  renderInner,
  renderMermaid,
} from "@/app/dashboard/projects/[id]/editor/lib/doc-html";
import type { TreeNode } from "@/app/dashboard/projects/[id]/editor/tree-utils";

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
  const [debounced, setDebounced] = useState(content);
  const [rendered, setRendered] = useState<{ key: string; doc: string } | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(content), 400);
    return () => clearTimeout(timer);
  }, [content]);

  const base = useMemo(() => {
    const { inner, isMd, blocks } = renderInner(fileNode, debounced, nodes, fileLinkById);
    return { inner, isMd, blocks, doc: previewSrcDoc(inner, isMd) };
  }, [debounced, fileLinkById, fileNode, nodes]);

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
    <iframe
      ref={iframeRef}
      title="Document preview"
      srcDoc={srcDoc}
      sandbox="allow-scripts allow-popups allow-top-navigation-by-user-activation"
      className="size-full border-0 bg-white"
    />
  );
}
