import { strFromU8, unzipSync } from "fflate";

export type ImportSource = "notion" | "confluence" | "google";
export type ImportEntry = {
  path: string;
  kind: "markdown" | "html" | "csv" | "asset" | "unsupported";
  bytes: Uint8Array;
  warning?: string;
};
export type ImportPreview = {
  entries: ImportEntry[];
  totalUncompressedBytes: number;
  counts: Record<ImportEntry["kind"], number>;
  warnings: string[];
};

const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
const MAX_ENTRY_BYTES = 25 * 1024 * 1024;
const MAX_ENTRIES = 1_000;
const MAX_DEPTH = 20;

function centralDirectory(bytes: Uint8Array): Array<{ path: string; size: number }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let offset = Math.max(0, bytes.length - 65_557); offset <= bytes.length - 22; offset += 1) {
    if (view.getUint32(offset, true) === 0x06054b50) end = offset;
  }
  if (end < 0) throw new Error("invalid-archive");
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  let offset = view.getUint32(end + 16, true);
  if (count > MAX_ENTRIES || offset + directorySize > bytes.length)
    throw new Error("archive-too-large");
  const decoder = new TextDecoder();
  const entries = [];
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50)
      throw new Error("invalid-archive");
    const flags = view.getUint16(offset + 8, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const externalAttributes = view.getUint32(offset + 38, true);
    const nameEnd = offset + 46 + nameLength;
    if (nameEnd > bytes.length || flags & 1) throw new Error("invalid-archive");
    const path = decoder.decode(bytes.subarray(offset + 46, nameEnd));
    const unixType = (externalAttributes >>> 16) & 0xf000;
    if (unixType === 0xa000) throw new Error("archive-symlink");
    validatePath(path);
    if (size > MAX_ENTRY_BYTES) throw new Error("archive-entry-too-large");
    total += size;
    if (total > MAX_UNCOMPRESSED_BYTES) throw new Error("archive-too-large");
    entries.push({ path, size });
    offset = nameEnd + extraLength + commentLength;
  }
  return entries;
}

function validatePath(path: string): void {
  if (
    !path ||
    path.length > 500 ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[a-z]:/i.test(path)
  )
    throw new Error("invalid-archive-path");
  const parts = path.split("/").filter(Boolean);
  if (parts.length > MAX_DEPTH || parts.some((part) => part === "." || part === "..")) {
    throw new Error("invalid-archive-path");
  }
}

function kindFor(path: string): ImportEntry["kind"] {
  const extension = path.split(".").pop()?.toLowerCase();
  if (extension === "md" || extension === "markdown" || extension === "txt") return "markdown";
  if (extension === "html" || extension === "htm") return "html";
  if (extension === "csv" || extension === "tsv") return "csv";
  if (
    [
      "png",
      "jpg",
      "jpeg",
      "gif",
      "webp",
      "avif",
      "pdf",
      "zip",
      "mp3",
      "wav",
      "mp4",
      "webm",
    ].includes(extension ?? "")
  )
    return "asset";
  return "unsupported";
}

export async function previewImportArchive(file: File): Promise<ImportPreview> {
  if (file.size > MAX_ARCHIVE_BYTES) throw new Error("archive-too-large");
  const archive = new Uint8Array(await file.arrayBuffer());
  const declared = centralDirectory(archive);
  const unpacked = unzipSync(archive);
  const declaredByPath = new Map(declared.map((entry) => [entry.path, entry.size]));
  const entries: ImportEntry[] = [];
  const warnings: string[] = [];
  let actualTotal = 0;
  for (const [path, bytes] of Object.entries(unpacked)) {
    validatePath(path);
    if (path.endsWith("/")) continue;
    actualTotal += bytes.length;
    if (actualTotal > MAX_UNCOMPRESSED_BYTES || bytes.length > MAX_ENTRY_BYTES)
      throw new Error("archive-too-large");
    if (declaredByPath.get(path) !== bytes.length) throw new Error("archive-size-mismatch");
    const kind = kindFor(path);
    const warning =
      kind === "unsupported" ? "Unsupported entry will be listed in the report." : undefined;
    if (warning) warnings.push(`${path}: ${warning}`);
    entries.push({ path, kind, bytes, warning });
  }
  const counts = { markdown: 0, html: 0, csv: 0, asset: 0, unsupported: 0 };
  for (const entry of entries) counts[entry.kind] += 1;
  return { entries, totalUncompressedBytes: actualTotal, counts, warnings };
}

export function importText(entry: ImportEntry): string {
  if (entry.bytes[0] === 0xff && entry.bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(entry.bytes.subarray(2));
  }
  if (entry.bytes[0] === 0xfe && entry.bytes[1] === 0xff) {
    const body = entry.bytes.subarray(2);
    const swapped = new Uint8Array(body.length);
    for (let index = 0; index + 1 < body.length; index += 2) {
      swapped[index] = body[index + 1] ?? 0;
      swapped[index + 1] = body[index] ?? 0;
    }
    return new TextDecoder("utf-16le").decode(swapped);
  }
  return strFromU8(entry.bytes);
}

export function normalizedImportPath(path: string, source: ImportSource): string {
  const parts = path
    .split("/")
    .filter(Boolean)
    .map((part) => {
      const withoutUuid =
        source === "notion" ? part.replace(/\s+[0-9a-f]{32}(?=\.[^.]+$|$)/i, "") : part;
      return withoutUuid.slice(0, 120);
    });
  return parts.join("/");
}

export function htmlToMarkdown(html: string): string {
  const document = new DOMParser().parseFromString(html, "text/html");
  const render = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (!(node instanceof HTMLElement)) return "";
    const content = [...node.childNodes].map(render).join("");
    const tag = node.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return `${"#".repeat(Number(tag[1]))} ${content.trim()}\n\n`;
    if (tag === "p" || tag === "div") return `${content.trim()}\n\n`;
    if (tag === "strong" || tag === "b") return `**${content}**`;
    if (tag === "em" || tag === "i") return `*${content}*`;
    if (tag === "code") return `\`${content}\``;
    if (tag === "pre") return `\n\`\`\`\n${node.textContent ?? ""}\n\`\`\`\n`;
    if (tag === "a")
      return `[${content || node.getAttribute("href")}](${node.getAttribute("href") ?? ""})`;
    if (tag === "img")
      return `![${node.getAttribute("alt") ?? ""}](${node.getAttribute("src") ?? ""})`;
    if (tag === "li") return `- ${content.trim()}\n`;
    if (tag === "br") return "\n";
    if (tag === "blockquote")
      return `${content
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}\n\n`;
    if (["iframe", "script", "style", "object", "embed"].includes(tag))
      return `\n[Unsupported ${tag} block]\n`;
    return content;
  };
  return render(document.body)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function rewriteImportedLinks(markdown: string, source: ImportSource): string {
  return markdown.replace(
    /(!?\[[^\]]*]\()([^\s)]+)([^)]*\))/g,
    (match, prefix, rawTarget, suffix) => {
      if (/^(?:[a-z][a-z\d+.-]*:|#)/i.test(rawTarget)) return match;
      const [pathPart = "", fragment] = String(rawTarget).split("#", 2);
      let decoded = pathPart;
      try {
        decoded = decodeURIComponent(pathPart);
      } catch {}
      const normalized = normalizedImportPath(decoded, source)
        .replace(/\.(?:html?|markdown|txt)$/i, ".md")
        .replace(/\.(?:csv|tsv)$/i, ".sheet");
      const encoded = normalized
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");
      return `${prefix}${encoded}${fragment ? `#${fragment}` : ""}${suffix}`;
    },
  );
}
