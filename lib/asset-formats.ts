const RASTER_ASSET_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
] as const;

export const RASTER_ASSET_ACCEPT = RASTER_ASSET_MIME_TYPES.join(",");
export const RASTER_ASSET_FORMATS = "PNG, JPEG, GIF, WebP, or AVIF";

const rasterAssetMimeTypes = new Set<string>(RASTER_ASSET_MIME_TYPES);

export function isRasterAssetMimeType(mimeType: string): boolean {
  return rasterAssetMimeTypes.has(mimeType.toLowerCase());
}
