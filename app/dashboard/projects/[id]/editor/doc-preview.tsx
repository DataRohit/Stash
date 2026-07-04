"use client";

import { Marked } from "marked";
import { useEffect, useMemo, useState } from "react";
import { resolveRef, type TreeNode } from "@/app/dashboard/projects/[id]/editor/tree-utils";

type DocPreviewProps = {
  fileNode: TreeNode;
  content: string;
  nodes: TreeNode[];
};

const BASE_CSS = `
html,body{margin:0}
body{background:#0b0d12;color:#e6e8ee;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif}
.doc{max-width:880px;margin:0 auto;padding:2rem;line-height:1.7}
.doc h1,.doc h2,.doc h3,.doc h4{font-weight:600;line-height:1.25;margin:1.4em 0 .5em}
.doc h1{font-size:1.9rem}.doc h2{font-size:1.5rem}.doc h3{font-size:1.2rem}
.doc p{margin:.75em 0}
.doc a{color:#7aa2ff;text-decoration:underline}
.doc pre.code{background:#12151c;padding:1rem;border-radius:8px;overflow:auto}
.doc code{font-family:ui-monospace,SFMono-Regular,monospace;font-size:.9em}
.doc img{max-width:100%;border-radius:8px}
.doc table{border-collapse:collapse;width:100%}
.doc th,.doc td{border:1px solid #2a2f3a;padding:.4rem .6rem;text-align:left}
.doc ul,.doc ol{padding-left:1.4rem}
.doc blockquote{border-left:3px solid #2a2f3a;margin:1em 0;padding-left:1rem;color:#9aa3b2}
.doc hr{border:none;border-top:1px solid #2a2f3a;margin:1.5em 0}
.mermaid{margin:1em 0}
`;

const HTML_BASE_CSS = `
html,body{margin:0}
body{background:#ffffff;color:#0f172a;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif}
img{max-width:100%}
`;

const MISSING_ASSET_SRC =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='640' height='180' viewBox='0 0 640 180'%3E%3Crect width='640' height='180' rx='12' fill='%2312151c'/%3E%3Ctext x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' fill='%239aa3b2' font-family='monospace' font-size='16'%3EMissing asset%3C/text%3E%3C/svg%3E";

function isExternalRef(value: string): boolean {
  return /^(?:[a-z][a-z\d+.-]*:|#|\/)/i.test(value);
}

function previewScript(theme: string): string {
  return `
import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
mermaid.initialize({ startOnLoad: false, theme: ${JSON.stringify(theme)}, securityLevel: "strict" });
mermaid.run({ querySelector: ".mermaid" }).catch(() => {});
document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-doc-id]");
  if (link) {
    event.preventDefault();
    parent.postMessage({ type: "stash-open-doc", id: link.getAttribute("data-doc-id") }, "*");
  }
});
`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const markedInstance = new Marked({ gfm: true });
markedInstance.use({
  renderer: {
    code({ text, lang }) {
      if ((lang ?? "").trim().toLowerCase() === "mermaid") {
        return `<pre class="mermaid">${escapeHtml(text)}</pre>`;
      }
      return `<pre class="code"><code>${escapeHtml(text)}</code></pre>`;
    },
  },
});

function rewriteRefs(rawHtml: string, fromNode: TreeNode, nodes: TreeNode[]): string {
  const doc = new DOMParser().parseFromString(rawHtml, "text/html");
  for (const img of doc.querySelectorAll("img[src], source[src]")) {
    const src = img.getAttribute("src") ?? "";
    const target = resolveRef(fromNode, src, nodes);
    if (target?.kind === "asset" && target.assetUrl) {
      img.setAttribute("src", target.assetUrl);
    } else if (src && !isExternalRef(src)) {
      img.setAttribute("src", MISSING_ASSET_SRC);
      img.setAttribute("title", `Missing asset: ${src}`);
    }
  }
  for (const anchor of doc.querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href") ?? "";
    const target = resolveRef(fromNode, href, nodes);
    if (target?.kind === "file") {
      anchor.setAttribute("href", "#");
      anchor.setAttribute("data-doc-id", target.id);
    } else if (target?.kind === "asset" && target.assetUrl) {
      anchor.setAttribute("href", target.assetUrl);
      anchor.setAttribute("target", "_blank");
    }
  }
  return doc.body.innerHTML;
}

export function DocPreview({ fileNode, content, nodes }: DocPreviewProps) {
  const [debounced, setDebounced] = useState(content);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(content), 400);
    return () => clearTimeout(timer);
  }, [content]);

  const srcDoc = useMemo(() => {
    const isMd = fileNode.fileType === "md";
    const rendered = isMd ? (markedInstance.parse(debounced) as string) : debounced;
    const body = rewriteRefs(rendered, fileNode, nodes);
    const css = isMd ? BASE_CSS : HTML_BASE_CSS;
    const inner = isMd ? `<div class="doc">${body}</div>` : body;
    const script = previewScript(isMd ? "dark" : "default");
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><script src="https://cdn.tailwindcss.com"></script><style>${css}</style></head><body>${inner}<script type="module">${script}</script></body></html>`;
  }, [debounced, fileNode, nodes]);

  return (
    <iframe
      title="Document preview"
      srcDoc={srcDoc}
      sandbox="allow-scripts"
      className="size-full border-0 bg-white"
    />
  );
}
