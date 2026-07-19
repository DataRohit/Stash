import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Stash — Collaborative Workspace",
    short_name: "Stash",
    description: "Collaborative documents, spreadsheets, boards, structured views, and charts.",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    background_color: "#f7f6f2",
    theme_color: "#171717",
    orientation: "any",
    icons: [
      {
        src: "/stash-icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: "/stash-icon-maskable.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "maskable",
      },
    ],
  };
}
