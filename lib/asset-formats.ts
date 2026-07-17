const MB = 1024 * 1024;

const ASSET_FORMATS = [
  { mime: "image/png", family: "image", maxBytes: 10 * MB },
  { mime: "image/jpeg", family: "image", maxBytes: 10 * MB },
  { mime: "image/gif", family: "image", maxBytes: 10 * MB },
  { mime: "image/webp", family: "image", maxBytes: 10 * MB },
  { mime: "image/avif", family: "image", maxBytes: 10 * MB },
  { mime: "application/pdf", family: "pdf", maxBytes: 25 * MB },
  { mime: "text/plain", family: "text", maxBytes: 5 * MB },
  { mime: "text/markdown", family: "text", maxBytes: 5 * MB },
  { mime: "text/csv", family: "csv", maxBytes: 10 * MB },
  { mime: "text/tab-separated-values", family: "csv", maxBytes: 10 * MB },
  { mime: "text/html", family: "unsafe", maxBytes: 5 * MB },
  { mime: "text/css", family: "text", maxBytes: 5 * MB },
  { mime: "text/javascript", family: "unsafe", maxBytes: 5 * MB },
  { mime: "application/javascript", family: "unsafe", maxBytes: 5 * MB },
  { mime: "application/json", family: "text", maxBytes: 5 * MB },
  { mime: "application/xml", family: "text", maxBytes: 5 * MB },
  { mime: "image/svg+xml", family: "unsafe", maxBytes: 5 * MB },
  { mime: "application/zip", family: "archive", maxBytes: 50 * MB },
  { mime: "application/x-zip-compressed", family: "archive", maxBytes: 50 * MB },
  { mime: "audio/mpeg", family: "audio", maxBytes: 100 * MB },
  { mime: "audio/wav", family: "audio", maxBytes: 100 * MB },
  { mime: "audio/ogg", family: "audio", maxBytes: 100 * MB },
  { mime: "audio/mp4", family: "audio", maxBytes: 100 * MB },
  { mime: "video/mp4", family: "video", maxBytes: 100 * MB },
  { mime: "video/webm", family: "video", maxBytes: 100 * MB },
] as const;

export type AssetFamily = (typeof ASSET_FORMATS)[number]["family"];

const byMime = new Map<string, (typeof ASSET_FORMATS)[number]>(
  ASSET_FORMATS.map((format) => [format.mime, format]),
);

const extensionMimes: Record<string, string> = {
  avif: "image/avif",
  css: "text/css",
  csv: "text/csv",
  gif: "image/gif",
  htm: "text/html",
  html: "text/html",
  java: "text/plain",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript",
  json: "application/json",
  log: "text/plain",
  m4a: "audio/mp4",
  md: "text/markdown",
  mov: "video/mp4",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  ogg: "audio/ogg",
  pdf: "application/pdf",
  png: "image/png",
  py: "text/plain",
  svg: "image/svg+xml",
  toml: "text/plain",
  ts: "text/plain",
  tsv: "text/tab-separated-values",
  txt: "text/plain",
  wav: "audio/wav",
  webm: "video/webm",
  webp: "image/webp",
  xml: "application/xml",
  yaml: "text/plain",
  yml: "text/plain",
  zip: "application/zip",
};

export const RASTER_ASSET_ACCEPT = ASSET_FORMATS.filter((format) => format.family === "image")
  .map((format) => format.mime)
  .join(",");
export const ASSET_ACCEPT = [
  ...ASSET_FORMATS.map((format) => format.mime),
  ...Object.keys(extensionMimes).map((extension) => `.${extension}`),
].join(",");
export const RASTER_ASSET_FORMATS = "PNG, JPEG, GIF, WebP, or AVIF";
export const ASSET_FORMAT_LABEL =
  "images, PDF, text, code, CSV/TSV, ZIP, MP3/WAV/OGG/M4A, MP4, or WebM";

export function assetMimeType(input: { name: string; type: string }): string {
  const supplied = input.type.toLowerCase();
  if (byMime.has(supplied)) return supplied;
  const extension = input.name.split(".").at(-1)?.toLowerCase() ?? "";
  return extensionMimes[extension] ?? supplied;
}

export function assetFamily(mimeType: string): AssetFamily | null {
  return byMime.get(mimeType.toLowerCase())?.family ?? null;
}

export function assetMaxBytes(mimeType: string): number | null {
  return byMime.get(mimeType.toLowerCase())?.maxBytes ?? null;
}

export function isAllowedAssetMimeType(mimeType: string): boolean {
  return byMime.has(mimeType.toLowerCase());
}

export function isRasterAssetMimeType(mimeType: string): boolean {
  return assetFamily(mimeType) === "image";
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

function validText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function matchesAssetSignature(mimeType: string, bytes: Uint8Array): boolean {
  const mime = mimeType.toLowerCase();
  if (mime === "image/png") return ascii(bytes, 1, 3) === "PNG";
  if (mime === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === "image/gif")
    return ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a";
  if (mime === "image/webp") return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP";
  if (mime === "image/avif")
    return ascii(bytes, 4, 4) === "ftyp" && ascii(bytes, 8, 8).includes("avif");
  if (mime === "application/pdf") return ascii(bytes, 0, 5) === "%PDF-";
  if (mime === "application/zip" || mime === "application/x-zip-compressed") {
    return ascii(bytes, 0, 2) === "PK" && [3, 5, 7].includes(bytes[2] ?? -1);
  }
  if (mime === "audio/mpeg") {
    return ascii(bytes, 0, 3) === "ID3" || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0);
  }
  if (mime === "audio/wav") return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE";
  if (mime === "audio/ogg") return ascii(bytes, 0, 4) === "OggS";
  if (mime === "audio/mp4" || mime === "video/mp4") return ascii(bytes, 4, 4) === "ftyp";
  if (mime === "video/webm") {
    return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  }
  return validText(bytes);
}
