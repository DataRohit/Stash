import { Marked } from "marked";
import { resolveRef, type TreeNode } from "@/app/dashboard/projects/[id]/editor/tree-utils";

export type MermaidBlock = { id: string; code: string };

export const PREVIEW_MD_CSS = `
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

export const PREVIEW_HTML_CSS = `
html,body{margin:0}
body{background:#ffffff;color:#0f172a;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif}
html{scrollbar-color:#6b7280 #0f1219;scrollbar-width:thin}
::-webkit-scrollbar{width:12px;height:12px}
::-webkit-scrollbar-track{background:#0f1219}
::-webkit-scrollbar-thumb{min-height:3rem;background:#6b7280;border:3px solid #0f1219;border-radius:999px;background-clip:content-box}
::-webkit-scrollbar-thumb:hover{background:#9ca3af}
::-webkit-scrollbar-corner{background:#0f1219}
img{max-width:100%}
a.missing-ref{color:#dc2626;text-decoration-style:wavy}
`;

const EXPORT_MD_CSS = `
html,body{margin:0}
body{background:#ffffff;color:#1a1d24;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.doc{max-width:820px;margin:0 auto;padding:2.5rem 2rem;line-height:1.7}
.doc h1,.doc h2,.doc h3,.doc h4{font-weight:600;line-height:1.25;margin:1.4em 0 .5em}
.doc h1{font-size:1.9rem}.doc h2{font-size:1.5rem}.doc h3{font-size:1.2rem}
.doc p{margin:.75em 0}
.doc a{color:#2563eb;text-decoration:underline}
.doc pre.code{background:#f4f5f7;padding:1rem;border-radius:8px;overflow:auto;border:1px solid #e2e4e9}
.doc code{font-family:ui-monospace,SFMono-Regular,monospace;font-size:.9em}
.doc img{max-width:100%;border-radius:8px}
.doc table{border-collapse:collapse;width:100%}
.doc th,.doc td{border:1px solid #e2e4e9;padding:.4rem .6rem;text-align:left}
.doc ul,.doc ol{padding-left:1.4rem}
.doc blockquote{border-left:3px solid #cbd0d8;margin:1em 0;padding-left:1rem;color:#5b626e}
.doc hr{border:none;border-top:1px solid #e2e4e9;margin:1.5em 0}
.doc a.missing-ref{color:#dc2626;text-decoration-style:wavy}
.mermaid-diagram{display:flex;justify-content:center;background:#f4f5f7;border:1px solid #e2e4e9;border-radius:8px;margin:1em 0;overflow:auto;padding:1rem}
.mermaid-diagram svg{max-width:100%;height:auto}
.mermaid-diagram pre.mermaid{background:none;border:none;margin:0;padding:0}
@page{margin:1.6cm}
@media print{.doc{padding:0}.doc pre.code,.mermaid-diagram,.doc table,.doc blockquote{page-break-inside:avoid}}
`;

const EXPORT_HTML_CSS = `
html,body{margin:0}
body{background:#ffffff;color:#0f172a;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
img{max-width:100%}
a.missing-ref{color:#dc2626;text-decoration-style:wavy}
@page{margin:1.6cm}
`;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isExternalRef(value: string): boolean {
  return /^(?:[a-z][a-z\d+.-]*:|#)/i.test(value);
}

function missingAssetSrc(ref: string): string {
  const label = ref.length > 48 ? `${ref.slice(0, 45)}...` : ref;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="180" viewBox="0 0 640 180"><rect width="640" height="180" rx="12" fill="#12151c"/><rect x="14" y="14" width="612" height="152" rx="10" fill="none" stroke="#ef4444" stroke-dasharray="8 8"/><text x="50%" y="78" text-anchor="middle" fill="#f87171" font-family="monospace" font-size="16" font-weight="600">Missing asset</text><text x="50%" y="108" text-anchor="middle" fill="#9aa3b2" font-family="monospace" font-size="13">${escapeHtml(label)}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function iframeCspMd(nonce: string): string {
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

function iframeCspHtml(): string {
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "img-src https: data: blob:",
    "media-src https: data: blob:",
    "font-src https: data:",
    "connect-src https:",
    "style-src 'unsafe-inline' https:",
    "script-src 'unsafe-inline' https:",
  ].join("; ");
}

function stripActiveContent(doc: Document): void {
  for (const element of doc.querySelectorAll(
    "script, iframe, object, embed, form, input, button, textarea, select, base, link, meta[http-equiv]",
  )) {
    element.remove();
  }
  for (const element of doc.querySelectorAll("*")) {
    for (const attribute of Array.from(element.attributes)) {
      if (
        attribute.name.toLowerCase().startsWith("on") ||
        ["srcdoc", "action", "formaction"].includes(attribute.name.toLowerCase())
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  }
}

function previewScript(): string {
  return `
document.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((heading, index) => {
  heading.id = "stash-heading-" + index;
});
window.addEventListener("message", (event) => {
  if (event.data && event.data.type === "stash-scroll-heading") {
    const target = document.getElementById(event.data.target);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }
});
document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) {
    return;
  }
  const missing = event.target.closest("a[data-missing-ref]");
  if (missing) {
    event.preventDefault();
    parent.postMessage({ type: "stash-missing-ref", ref: missing.getAttribute("data-missing-ref") }, "*");
    return;
  }
  const link = event.target.closest("a[data-doc-id]");
  if (link) {
    event.preventDefault();
    parent.postMessage({ type: "stash-open-doc", id: link.getAttribute("data-doc-id") }, "*");
    return;
  }
  const sharedLink = event.target.closest("a[data-shared-doc-id]");
  if (sharedLink) {
    event.preventDefault();
    parent.postMessage({ type: "stash-open-shared-doc", id: sharedLink.getAttribute("data-shared-doc-id") }, "*");
  }
});
`;
}

export function missingRefToast(ref: unknown): { title: string; description: string } {
  const raw = typeof ref === "string" ? ref.trim() : "";
  const label = raw.length > 80 ? `${raw.slice(0, 77)}...` : raw;
  return {
    title: "Link target not found",
    description: label
      ? `"${label}" does not match any file or asset in this project. Check the path and file name.`
      : "This link does not match any file or asset in this project.",
  };
}

function previewNonce(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().replaceAll("-", "");
  }
  return `${Date.now()}${Math.random()}`.replace(/\D/g, "");
}

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

export function referencedAssetIds(
  fileNode: TreeNode,
  content: string,
  nodes: TreeNode[],
): string[] {
  const rawHtml =
    fileNode.fileType === "md" ? (createMarked(() => "").parse(content) as string) : content;
  const doc = new DOMParser().parseFromString(rawHtml, "text/html");
  const ids = new Set<string>();
  for (const element of doc.querySelectorAll("img[src], source[src], a[href]")) {
    const ref = element.getAttribute(element.tagName === "A" ? "href" : "src") ?? "";
    const target = resolveRef(fileNode, ref, nodes);
    if (target?.kind === "asset" && target.hasAsset !== false && !target.assetUrl) {
      ids.add(target.id);
    }
  }
  return [...ids].slice(0, 100);
}

function rewriteRefs(
  rawHtml: string,
  fromNode: TreeNode,
  nodes: TreeNode[],
  fileLinkById: Record<string, string>,
  markMissing: boolean,
  allowActiveContent: boolean,
): string {
  const doc = new DOMParser().parseFromString(rawHtml, "text/html");
  if (!allowActiveContent) {
    stripActiveContent(doc);
  }
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
      const fileLink = fileLinkById[target.id];
      if (fileLink) {
        if (allowActiveContent) {
          anchor.setAttribute("href", fileLink);
          anchor.setAttribute("target", "_top");
        } else {
          anchor.setAttribute("href", "#");
          anchor.removeAttribute("target");
          anchor.setAttribute("data-shared-doc-id", target.id);
        }
      } else {
        anchor.setAttribute("href", "#");
        anchor.setAttribute("data-doc-id", target.id);
      }
    } else if (target?.kind === "asset" && target.assetUrl) {
      anchor.setAttribute("href", target.assetUrl);
      anchor.setAttribute("target", "_blank");
      anchor.setAttribute("rel", "noopener noreferrer");
    } else if (href && !isExternalRef(href)) {
      anchor.setAttribute("href", "#");
      anchor.setAttribute("title", `Missing file or asset: ${href}`);
      anchor.setAttribute("data-missing-ref", href);
      if (markMissing) {
        anchor.setAttribute("class", `${anchor.getAttribute("class") ?? ""} missing-ref`.trim());
      }
    } else if (/^https?:/i.test(href)) {
      anchor.setAttribute("target", "_blank");
      anchor.setAttribute("rel", "noopener noreferrer");
    }
  }
  const headAssets = Array.from(doc.head.querySelectorAll("style, link, script"))
    .map((element) => element.outerHTML)
    .join("");
  return headAssets + doc.body.innerHTML;
}

export type RenderedInner = { inner: string; isMd: boolean; blocks: MermaidBlock[] };

export function renderInner(
  fileNode: TreeNode,
  content: string,
  nodes: TreeNode[],
  fileLinkById: Record<string, string>,
  allowActiveContent = true,
): RenderedInner {
  const isMd = fileNode.fileType === "md";
  const blocks: MermaidBlock[] = [];
  const parsed = isMd
    ? (createMarked((source) => {
        const id = nextMermaidId();
        blocks.push({ id, code: source });
        return `<div class="mermaid-diagram" data-mmd="${id}"><pre class="mermaid">${escapeHtml(source)}</pre></div>`;
      }).parse(content) as string)
    : content;
  return {
    inner: rewriteRefs(parsed, fileNode, nodes, fileLinkById, isMd, allowActiveContent),
    isMd,
    blocks,
  };
}

let mermaidModule: typeof import("mermaid")["default"] | null = null;
let mermaidTheme: "dark" | "default" | null = null;

async function loadMermaid(theme: "dark" | "default") {
  if (!mermaidModule) {
    const mod = await import("mermaid");
    mermaidModule = mod.default;
  }
  if (mermaidTheme !== theme) {
    mermaidModule.initialize({ startOnLoad: false, theme, securityLevel: "strict" });
    mermaidTheme = theme;
  }
  return mermaidModule;
}

export async function renderMermaid(
  blocks: MermaidBlock[],
  theme: "dark" | "default" = "dark",
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  if (signal?.aborted) {
    return results;
  }
  const mermaid = await loadMermaid(theme);
  if (signal?.aborted) {
    return results;
  }
  for (const block of blocks) {
    if (signal?.aborted) {
      break;
    }
    try {
      const { svg } = await mermaid.render(`${block.id}-svg`, block.code);
      results.set(block.id, svg);
    } catch {}
  }
  return results;
}

export function injectMermaid(inner: string, svgs: Map<string, string>): string {
  if (svgs.size === 0) {
    return inner;
  }
  const dom = new DOMParser().parseFromString(inner, "text/html");
  for (const [id, svg] of svgs) {
    const slot = dom.querySelector(`[data-mmd="${id}"]`);
    if (slot) {
      slot.innerHTML = svg;
    }
  }
  return dom.body.innerHTML;
}

export function previewSrcDoc(inner: string, isMd: boolean, allowActiveContent = true): string {
  const meta = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`;
  const script = previewScript();
  if (isMd || !allowActiveContent) {
    const nonce = previewNonce();
    const css = isMd ? PREVIEW_MD_CSS : PREVIEW_HTML_CSS;
    const body = isMd ? `<div class="doc">${inner}</div>` : inner;
    return `<!doctype html><html><head>${meta}<meta http-equiv="Content-Security-Policy" content="${iframeCspMd(nonce)}"><style>${css}</style></head><body>${body}<script nonce="${nonce}">${script}</script></body></html>`;
  }
  return `<!doctype html><html><head>${meta}<meta http-equiv="Content-Security-Policy" content="${iframeCspHtml()}"><style>${PREVIEW_HTML_CSS}</style></head><body>${inner}<script>${script}</script></body></html>`;
}

export function standaloneHtml(inner: string, isMd: boolean, title: string): string {
  const css = isMd ? EXPORT_MD_CSS : EXPORT_HTML_CSS;
  const body = isMd ? `<div class="doc">${inner}</div>` : inner;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${css}</style></head><body>${body}</body></html>`;
}
