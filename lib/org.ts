export const MAX_TAGS = 8;
export const MAX_TAG_LENGTH = 24;
export const MAX_DESCRIPTION_LENGTH = 280;
export const MIN_ORG_NAME_LENGTH = 2;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export function sanitizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    if (tag.length === 0 || tag.length > MAX_TAG_LENGTH) {
      continue;
    }
    const key = tag.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(tag);
    if (result.length >= MAX_TAGS) {
      break;
    }
  }
  return result;
}
