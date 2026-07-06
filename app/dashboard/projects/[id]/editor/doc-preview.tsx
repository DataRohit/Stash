"use client";

import { Marked } from "marked";
import { type RefObject, useEffect, useMemo, useState } from "react";
import { resolveRef, type TreeNode } from "@/app/dashboard/projects/[id]/editor/tree-utils";

type DocPreviewProps = {
  fileNode: TreeNode;
  content: string;
  nodes: TreeNode[];
  iframeRef?: RefObject<HTMLIFrameElement | null>;
};

const BASE_CSS = `
html,body{margin:0}
body{background:#0b0d12;color:#e6e8ee;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif}
body{scrollbar-color:#6b7280 #0f1219;scrollbar-width:thin}
::-webkit-scrollbar{width:12px;height:12px}
::-webkit-scrollbar-track{background:#0f1219}
::-webkit-scrollbar-thumb{min-height:3rem;background:#6b7280;border:3px solid #0f1219;border-radius:999px;background-clip:content-box}
::-webkit-scrollbar-thumb:hover{background:#9ca3af}
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
.doc a.missing-ref{color:#f87171;text-decoration-style:wavy}
.mermaid{background:#12151c;border:1px solid #2a2f3a;border-radius:8px;color:#cbd5e1;margin:1em 0;overflow:auto;padding:1rem;white-space:pre}
.mermaid-diagram{display:flex;justify-content:center;background:#12151c;border:1px solid #2a2f3a;border-radius:8px;margin:1em 0;overflow:auto;padding:1rem}
.mermaid-diagram svg{max-width:100%;height:auto}
.mermaid-diagram pre.mermaid{background:none;border:none;margin:0;padding:0}
`;

const HTML_BASE_CSS = `
html,body{margin:0}
body{background:#ffffff;color:#0f172a;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif}
body{scrollbar-color:#94a3b8 #f8fafc;scrollbar-width:thin}
::-webkit-scrollbar{width:12px;height:12px}
::-webkit-scrollbar-track{background:#f8fafc}
::-webkit-scrollbar-thumb{min-height:3rem;background:#94a3b8;border:3px solid #f8fafc;border-radius:999px;background-clip:content-box}
::-webkit-scrollbar-thumb:hover{background:#64748b}
img{max-width:100%}
a.missing-ref{color:#dc2626;text-decoration-style:wavy}
`;

function iframeCsp(nonce: string): string {
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "connect-src 'none'",
    "worker-src 'none'",
    "img-src https: data: blob:",
    "media-src https: data: blob:",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
}

function isExternalRef(value: string): boolean {
  return /^(?:[a-z][a-z\d+.-]*:|#)/i.test(value);
}

function missingAssetSrc(ref: string): string {
  const label = ref.length > 48 ? `${ref.slice(0, 45)}...` : ref;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="180" viewBox="0 0 640 180"><rect width="640" height="180" rx="12" fill="#12151c"/><rect x="14" y="14" width="612" height="152" rx="10" fill="none" stroke="#ef4444" stroke-dasharray="8 8"/><text x="50%" y="78" text-anchor="middle" fill="#f87171" font-family="monospace" font-size="16" font-weight="600">Missing asset</text><text x="50%" y="108" text-anchor="middle" fill="#9aa3b2" font-family="monospace" font-size="13">${escapeHtml(label)}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function previewScript(): string {
  return `
document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) {
    return;
  }
  const link = event.target.closest("a[data-doc-id]");
  if (link) {
    event.preventDefault();
    parent.postMessage({ type: "stash-open-doc", id: link.getAttribute("data-doc-id") }, "*");
  }
});
`;
}

function previewNonce(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().replaceAll("-", "");
  }
  return `${Date.now()}${Math.random()}`.replace(/\D/g, "");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

type MermaidBlock = { id: string; code: string };

let mermaidSeq = 0;

function nextMermaidId(): string {
  mermaidSeq += 1;
  return `mmd-${mermaidSeq}`;
}

function createMarked(onMermaid: (source: string) => string): Marked {
  const instance = new Marked({ gfm: true });
  instance.use({
    renderer: {
      code({ text, lang }) {
        if ((lang ?? "").trim().toLowerCase() === "mermaid") {
          return onMermaid(text);
        }
        return `<pre class="code"><code>${escapeHtml(text)}</code></pre>`;
      },
      html({ text }) {
        return `<pre class="code"><code>${escapeHtml(text)}</code></pre>`;
      },
    },
  });
  return instance;
}

let mermaidReady = false;

async function renderMermaid(blocks: MermaidBlock[]): Promise<Map<string, string>> {
  const mod = await import("mermaid");
  const mermaid = mod.default;
  if (!mermaidReady) {
    mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" });
    mermaidReady = true;
  }
  const results = new Map<string, string>();
  for (const block of blocks) {
    try {
      const { svg } = await mermaid.render(`${block.id}-svg`, block.code);
      results.set(block.id, svg);
    } catch {}
  }
  return results;
}

function assembleSrcDoc(inner: string, isMd: boolean): string {
  const css = isMd ? BASE_CSS : HTML_BASE_CSS;
  const body = isMd ? `<div class="doc">${inner}</div>` : inner;
  const nonce = previewNonce();
  const script = previewScript();
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${iframeCsp(nonce)}"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body>${body}<script nonce="${nonce}">${script}</script></body></html>`;
}

function rewriteRefs(rawHtml: string, fromNode: TreeNode, nodes: TreeNode[]): string {
  const doc = new DOMParser().parseFromString(rawHtml, "text/html");
  for (const img of doc.querySelectorAll("img[src], source[src]")) {
    const src = img.getAttribute("src") ?? "";
    const target = resolveRef(fromNode, src, nodes);
    if (target?.kind === "asset" && target.assetUrl) {
      img.setAttribute("src", target.assetUrl);
    } else if (src && !isExternalRef(src)) {
      img.setAttribute("src", missingAssetSrc(src));
      img.setAttribute("alt", `Missing asset: ${src}`);
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
      anchor.setAttribute("rel", "noopener noreferrer");
    } else if (href && !isExternalRef(href)) {
      anchor.setAttribute("href", "#");
      anchor.setAttribute("class", `${anchor.getAttribute("class") ?? ""} missing-ref`.trim());
      anchor.setAttribute("title", `Missing file or asset: ${href}`);
    }
  }
  return doc.body.innerHTML;
}

export function DocPreview({ fileNode, content, nodes, iframeRef }: DocPreviewProps) {
  const [debounced, setDebounced] = useState(content);
  const [rendered, setRendered] = useState<{ key: string; doc: string } | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(content), 400);
    return () => clearTimeout(timer);
  }, [content]);

  const base = useMemo(() => {
    const isMd = fileNode.fileType === "md";
    const blocks: MermaidBlock[] = [];
    const parsed = isMd
      ? (createMarked((source) => {
          const id = nextMermaidId();
          blocks.push({ id, code: source });
          return `<div class="mermaid-diagram" data-mmd="${id}"><pre class="mermaid">${escapeHtml(source)}</pre></div>`;
        }).parse(debounced) as string)
      : debounced;
    const inner = rewriteRefs(parsed, fileNode, nodes);
    return { inner, isMd, blocks, doc: assembleSrcDoc(inner, isMd) };
  }, [debounced, fileNode, nodes]);

  useEffect(() => {
    if (base.blocks.length === 0) {
      return;
    }
    let cancelled = false;
    void renderMermaid(base.blocks).then((svgs) => {
      if (cancelled || svgs.size === 0) {
        return;
      }
      const dom = new DOMParser().parseFromString(base.inner, "text/html");
      for (const [id, svg] of svgs) {
        const slot = dom.querySelector(`[data-mmd="${id}"]`);
        if (slot) {
          slot.innerHTML = svg;
        }
      }
      setRendered({ key: base.inner, doc: assembleSrcDoc(dom.body.innerHTML, base.isMd) });
    });
    return () => {
      cancelled = true;
    };
  }, [base]);

  const srcDoc = rendered?.key === base.inner ? rendered.doc : base.doc;

  return (
    <iframe
      ref={iframeRef}
      title="Document preview"
      srcDoc={srcDoc}
      sandbox="allow-scripts"
      className="size-full border-0 bg-white"
    />
  );
}
