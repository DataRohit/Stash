import { shapes } from "@dicebear/collection";
import { createAvatar } from "@dicebear/core";
import { Resvg } from "@resvg/resvg-js";

const AVATAR_SIZE = 256;
const AVATAR_RADIUS = 12;

export function fetchOrgAvatarFile(seed: string): Promise<File> {
  const svg = createAvatar(shapes, { seed, size: AVATAR_SIZE, radius: AVATAR_RADIUS }).toString();
  const png = new Resvg(svg, { fitTo: { mode: "width", value: AVATAR_SIZE } }).render().asPng();
  return Promise.resolve(
    new File([new Uint8Array(png)], "organization-icon.png", { type: "image/png" }),
  );
}
