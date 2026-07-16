import type * as Y from "yjs";
import {
  injectMermaid,
  renderInner,
  renderMermaid,
  standaloneHtml,
} from "@/app/dashboard/projects/[id]/editor/lib/doc-html";
import { buildZip, type ZipEntry } from "@/app/dashboard/projects/[id]/editor/lib/zip";
import type { TreeNode } from "@/app/dashboard/projects/[id]/editor/tree-utils";
import type { ChartData } from "@/lib/chart-data";
import { renderChartSvg } from "@/lib/chart-svg";
import { boardRenderModel, sheetRenderModel } from "@/lib/doc-projection";
import type { FileType } from "@/lib/document-types";
import { serializeDelimited } from "@/lib/sheet-csv";
import type { ViewConfig } from "@/lib/view-model";

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
  return name.replace(/\.(md|html|sheet|board|view|chart)$/i, "");
}

export type ViewExportRecord = {
  id: string;
  name: string;
  fileType: string | null;
  updatedAt: number;
  properties: Array<{
    propertyId: string;
    displayValue: string;
    dateValue?: number;
    dateEndValue?: number;
  }>;
};

export type ViewExportModel = {
  config: ViewConfig;
  properties: Array<{ id: string; name: string; deleted?: boolean }>;
  records: ViewExportRecord[];
};

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
  const { inner, isMd, blocks } = renderInner(fileNode, content, nodes, EMPTY_LINKS, false);
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

function boardMarkdown(ydoc: Y.Doc): string {
  return boardRenderModel(ydoc)
    .columns.map((column) =>
      [
        `## ${column.name}`,
        ...column.cards.map((card) =>
          [
            `- **${card.title}**`,
            card.priority ? ` — ${card.priority} urgency` : "",
            card.description ? `\n  ${card.description.replaceAll("\n", "\n  ")}` : "",
          ].join(""),
        ),
      ].join("\n\n"),
    )
    .join("\n\n");
}

function boardHtml(fileNode: TreeNode, ydoc: Y.Doc): string {
  const model = boardRenderModel(ydoc);
  const columns = model.columns
    .map(
      (column) =>
        `<section><h2><i style="background:${escaped(column.color)}"></i>${escaped(column.name)} <small>${column.cards.length}</small></h2><div>${column.cards
          .map(
            (card) =>
              `<article style="border-left-color:${escaped(card.color)}">${card.priority ? `<b>${escaped(card.priority)}</b>` : ""}${card.labels.map((label) => `<span style="color:${escaped(label.color)}">${escaped(label.name)}</span>`).join(" ")}<h3>${escaped(card.title)}</h3>${card.description ? `<p>${escaped(card.description)}</p>` : ""}${card.due ? `<time>${escaped(new Date(card.due).toLocaleDateString())}</time>` : ""}</article>`,
          )
          .join("")}</div></section>`,
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escaped(stem(fileNode.name))}</title><style>body{font:14px system-ui;margin:24px;color:#111;display:flex;align-items:flex-start;gap:16px;overflow:auto}section{width:280px;flex:none;background:#f4f4f5;border:1px solid #ddd;border-radius:10px;padding:10px}h2{display:flex;align-items:center;gap:7px;font-size:14px;margin:2px 4px 10px}h2 i{display:inline-block;width:14px;height:14px;border-radius:4px}small{color:#666}article{background:#fff;border:1px solid #ddd;border-left:4px solid;border-radius:7px;padding:12px;margin:8px 0;break-inside:avoid}h3{font-size:14px;margin:4px 0}p{white-space:pre-wrap;color:#555;font-size:12px}b,span,time{font-size:10px;margin-right:5px;text-transform:capitalize}@media print{body{margin:0;gap:8px;flex-wrap:wrap}section{width:30%}}</style></head><body>${columns}</body></html>`;
}

export function exportBoardMarkdown(fileNode: TreeNode, ydoc: Y.Doc): void {
  download(`${stem(fileNode.name)}.md`, boardMarkdown(ydoc), "text/markdown;charset=utf-8");
}

export function exportBoardHtml(fileNode: TreeNode, ydoc: Y.Doc): void {
  download(`${stem(fileNode.name)}.html`, boardHtml(fileNode, ydoc), "text/html;charset=utf-8");
}

export async function exportBoardPdf(fileNode: TreeNode, ydoc: Y.Doc): Promise<void> {
  await printHtml(boardHtml(fileNode, ydoc));
}

function viewColumnName(model: ViewExportModel, propertyId: string): string {
  if (propertyId === "title") return "Document";
  if (propertyId === "fileType") return "Type";
  if (propertyId === "updatedAt") return "Updated";
  const property = model.properties.find((row) => row.id === propertyId);
  return property && !property.deleted ? property.name : "Removed field";
}

function viewValue(record: ViewExportRecord, propertyId: string): string {
  if (propertyId === "title") return record.name;
  if (propertyId === "fileType") return record.fileType ?? "Unknown";
  if (propertyId === "updatedAt") return new Date(record.updatedAt).toISOString();
  return record.properties.find((row) => row.propertyId === propertyId)?.displayValue ?? "";
}

function viewCsv(model: ViewExportModel): string {
  return serializeDelimited(
    [
      model.config.visibleColumns.map((propertyId) => viewColumnName(model, propertyId)),
      ...model.records.map((record) =>
        model.config.visibleColumns.map((propertyId) => viewValue(record, propertyId)),
      ),
    ],
    ",",
    "\r\n",
  );
}

function viewHtml(fileNode: TreeNode, model: ViewExportModel): string {
  const header = model.config.visibleColumns
    .map((propertyId) => `<th>${escaped(viewColumnName(model, propertyId))}</th>`)
    .join("");
  const body = model.records
    .map(
      (record) =>
        `<tr>${model.config.visibleColumns
          .map((propertyId) => `<td>${escaped(viewValue(record, propertyId))}</td>`)
          .join("")}</tr>`,
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escaped(stem(fileNode.name))}</title><style>body{font:14px system-ui;margin:24px;color:#111}h1{font-size:20px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #bbb;padding:7px 9px;text-align:left;vertical-align:top}th{background:#f3f3f3}@media print{body{margin:0}}</style></head><body><h1>${escaped(stem(fileNode.name))}</h1><table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></body></html>`;
}

export function exportViewCsv(fileNode: TreeNode, model: ViewExportModel): void {
  download(`${stem(fileNode.name)}.csv`, viewCsv(model), "text/csv;charset=utf-8");
}

export function exportViewHtml(fileNode: TreeNode, model: ViewExportModel): void {
  download(`${stem(fileNode.name)}.html`, viewHtml(fileNode, model), "text/html;charset=utf-8");
}

export async function exportViewPdf(fileNode: TreeNode, model: ViewExportModel): Promise<void> {
  await printHtml(viewHtml(fileNode, model));
}

function chartHtml(fileNode: TreeNode, model: ChartData): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escaped(stem(fileNode.name))}</title><style>body{margin:0;color:#111;background:#fff;font:14px system-ui}main{max-width:900px;margin:24px auto;padding:0 24px}svg{width:100%;height:auto}@media print{main{margin:0}}</style></head><body><main>${renderChartSvg(model)}</main></body></html>`;
}

export function exportChartSvg(fileNode: TreeNode, model: ChartData): void {
  download(`${stem(fileNode.name)}.svg`, renderChartSvg(model), "image/svg+xml;charset=utf-8");
}

export function exportChartHtml(fileNode: TreeNode, model: ChartData): void {
  download(`${stem(fileNode.name)}.html`, chartHtml(fileNode, model), "text/html;charset=utf-8");
}

export async function exportChartPdf(fileNode: TreeNode, model: ChartData): Promise<void> {
  await printHtml(chartHtml(fileNode, model));
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
        path:
          node.fileType === "sheet"
            ? path.replace(/\.sheet$/i, ".csv")
            : node.fileType === "board"
              ? path.replace(/\.board$/i, ".md")
              : node.fileType === "view"
                ? path.replace(/\.view$/i, ".json")
                : node.fileType === "chart"
                  ? path.replace(/\.chart$/i, ".svg")
                  : path,
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
