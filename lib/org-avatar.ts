const DICEBEAR_PNG_ENDPOINT = "https://api.dicebear.com/9.x/shapes/png";

export function orgAvatarUrl(seed: string): string {
  const params = new URLSearchParams({ seed, size: "256", radius: "12" });
  return `${DICEBEAR_PNG_ENDPOINT}?${params.toString()}`;
}

export async function fetchOrgAvatarFile(seed: string): Promise<File> {
  const response = await fetch(orgAvatarUrl(seed));
  if (!response.ok) {
    throw new Error("Failed to generate organization avatar");
  }
  const blob = await response.blob();
  return new File([blob], "organization-icon.png", { type: "image/png" });
}
