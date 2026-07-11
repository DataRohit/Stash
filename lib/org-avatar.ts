import { shapes } from "@dicebear/collection";
import { createAvatar } from "@dicebear/core";

const AVATAR_SIZE = 256;
const AVATAR_RADIUS = 12;

export function orgAvatarUrl(seed: string): string {
  return createAvatar(shapes, { seed, size: AVATAR_SIZE, radius: AVATAR_RADIUS }).toDataUri();
}
