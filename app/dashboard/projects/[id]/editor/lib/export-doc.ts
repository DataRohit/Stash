import type * as Y from "yjs";
import {
  injectMermaid,
  renderInner,
  renderMermaid,
  standaloneHtml,
} from "@/app/dashboard/projects/[id]/editor/lib/doc-html";
import { buildZip, type ZipEntry } from "@/app/dashboard/projects/[id]/editor/lib/zip";
import type { TreeNode } from "@/app/dashboard/projects/[id]/editor/tree-utils";
import { sheetRenderModel } from "@/lib/doc-projection";
import type { FileType } from "@/lib/document-types";
import { serializeDelimited } from "@/lib/sheet-csv";

export type BundleNode = {
  id: string;
  parentId: string | null;
  kind: "folder" | "file" | "asset";
  name: string;
  fileType: FileType | null;
  content: string;
  mimeType: string | null;
  assetUrl: string | null;
};

const EMPTY_LINKS: Record<string, string> = {};

function stem(name: string): string {
  return name.replace(/\.(md|html|sheet)$/i, "");
}

function safeFileName(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned.length > 0 ? cleaned : "project";
}

function download(filename: string, data: Uint8Array | string, type: string): void {
  const part: BlobPart = typeof data === "string" ? data : (data as unknown as BlobPart);
  const blob = new Blob([part], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

async function fetchDataUri(url: string): Promise<string | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const type = response.headers.get("content-type") ?? "application/octet-stream";
    return `data:${type};base64,${toBase64(bytes)}`;
  } catch {
    return null;
  }
}

async function inlineAssets(html: string, nodes: TreeNode[]): Promise<string> {
  const resolved = new Map<string, string>();
  for (const node of nodes) {
    if (node.kind === "asset" && node.assetUrl) {
      resolved.set(node.assetUrl, node.assetUrl);
    }
  }
  if (resolved.size === 0) {
    return html;
  }
  const dom = new DOMParser().parseFromString(html, "text/html");
  const attrOf = (element: Element) => (element.tagName === "A" ? "href" : "src");
  const selector = "img[src], source[src], a[href]";
  const used = new Set<string>();
  for (const element of dom.querySelectorAll(selector)) {
    const value = element.getAttribute(attrOf(element)) ?? "";
    if (resolved.has(value)) {
      used.add(value);
    }
  }
  await Promise.all(
    [...used].map(async (url) => {
      const uri = await fetchDataUri(url);
      if (uri) {
        resolved.set(url, uri);
      }
    }),
  );
  for (const element of dom.querySelectorAll(selector)) {
    const attr = attrOf(element);
    const value = element.getAttribute(attr) ?? "";
    const uri = resolved.get(value);
    if (uri && uri !== value) {
      element.setAttribute(attr, uri);
    }
  }
  return dom.body.innerHTML;
}

async function buildExportHtml(
  fileNode: TreeNode,
  content: string,
  nodes: TreeNode[],
): Promise<string> {
  const { inner, isMd, blocks } = renderInner(fileNode, content, nodes, EMPTY_LINKS);
  const svgs = await renderMermaid(blocks, "default");
  const withMermaid = injectMermaid(inner, svgs);
  const inlined = await inlineAssets(withMermaid, nodes);
  return standaloneHtml(inlined, isMd, stem(fileNode.name));
}

export function exportMarkdown(fileNode: TreeNode, content: string): void {
  download(`${stem(fileNode.name)}.md`, content, "text/markdown;charset=utf-8");
}

function escaped(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function sheetHtml(fileNode: TreeNode, ydoc: Y.Doc): string {
  const model = sheetRenderModel(ydoc);
  const header = model.columns.map((column) => `<th>${escaped(column.name)}</th>`).join("");
  const body = model.rows
    .map((row) => `<tr>${row.values.map((value) => `<td>${escaped(value)}</td>`).join("")}</tr>`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escaped(stem(fileNode.name))}</title><style>body{font:14px system-ui;margin:24px;color:#111}table{border-collapse:collapse}th,td{border:1px solid #bbb;padding:6px 9px;white-space:pre-wrap;vertical-align:top}th{background:#f3f3f3}@media print{body{margin:0}}</style></head><body><table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></body></html>`;
}

export function exportSheetCsv(fileNode: TreeNode, ydoc: Y.Doc): void {
  const model = sheetRenderModel(ydoc);
  download(
    `${stem(fileNode.name)}.csv`,
    serializeDelimited(
      model.rows.map((row) => row.values),
      ",",
      "\r\n",
    ),
    "text/csv;charset=utf-8",
  );
}

export function exportSheetHtml(fileNode: TreeNode, ydoc: Y.Doc): void {
  download(`${stem(fileNode.name)}.html`, sheetHtml(fileNode, ydoc), "text/html;charset=utf-8");
}

export async function exportSheetPdf(fileNode: TreeNode, ydoc: Y.Doc): Promise<void> {
  await printHtml(sheetHtml(fileNode, ydoc));
}

export async function exportHtml(
  fileNode: TreeNode,
  content: string,
  nodes: TreeNode[],
): Promise<void> {
  const html = await buildExportHtml(fileNode, content, nodes);
  download(`${stem(fileNode.name)}.html`, html, "text/html;charset=utf-8");
}

function waitForImages(doc: Document): Promise<void> {
  const pending = [...doc.images].filter((image) => !image.complete);
  if (pending.length === 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let remaining = pending.length;
    const settle = () => {
      remaining -= 1;
      if (remaining <= 0) {
        resolve();
      }
    };
    for (const image of pending) {
      image.addEventListener("load", settle, { once: true });
      image.addEventListener("error", settle, { once: true });
    }
    setTimeout(resolve, 4000);
  });
}

function printHtml(html: string): Promise<void> {
  return new Promise((resolve) => {
    const iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    iframe.setAttribute("sandbox", "allow-same-origin allow-modals");
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "0";
    iframe.style.visibility = "hidden";
    let settled = false;
    const cleanup = () => {
      if (settled) {
        return;
      }
      settled = true;
      setTimeout(() => iframe.remove(), 500);
      resolve();
    };
    iframe.onload = async () => {
      const win = iframe.contentWindow;
      const doc = iframe.contentDocument;
      if (!win || !doc) {
        cleanup();
        return;
      }
      await waitForImages(doc);
      win.addEventListener("afterprint", cleanup, { once: true });
      win.focus();
      win.print();
      setTimeout(cleanup, 60000);
    };
    document.body.appendChild(iframe);
    iframe.srcdoc = html;
  });
}

export async function exportPdf(
  fileNode: TreeNode,
  content: string,
  nodes: TreeNode[],
): Promise<void> {
  const html = await buildExportHtml(fileNode, content, nodes);
  await printHtml(html);
}

function nodePath(node: BundleNode, byId: Map<string, BundleNode>): string {
  const parts: string[] = [];
  let current: BundleNode | undefined = node;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    parts.unshift(current.name);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return parts.join("/");
}

export async function exportProjectZip(projectTitle: string, nodes: BundleNode[]): Promise<void> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const encoder = new TextEncoder();
  const entries: ZipEntry[] = [];
  for (const node of nodes) {
    const path = nodePath(node, byId);
    if (path.length === 0) {
      continue;
    }
    if (node.kind === "folder") {
      entries.push({ path: `${path}/`, data: new Uint8Array(0) });
    } else if (node.kind === "file") {
      entries.push({
        path: node.fileType === "sheet" ? path.replace(/\.sheet$/i, ".csv") : path,
        data: encoder.encode(node.content),
      });
    } else if (node.kind === "asset" && node.assetUrl) {
      try {
        const response = await fetch(node.assetUrl);
        if (response.ok) {
          entries.push({ path, data: new Uint8Array(await response.arrayBuffer()) });
        }
      } catch {}
    }
  }
  if (entries.length === 0) {
    throw new Error("empty-project");
  }
  download(`${safeFileName(projectTitle)}.zip`, buildZip(entries), "application/zip");
}
