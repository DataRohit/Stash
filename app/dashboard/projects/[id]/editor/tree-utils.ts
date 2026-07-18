import type { FileType } from "@/lib/document-types";

export type TreeNode = {
  id: string;
  parentId: string | null;
  kind: "folder" | "file" | "asset";
  name: string;
  fileType: FileType | null;
  size: number;
  mimeType: string | null;
  hasAsset?: boolean;
  assetUrl: string | null;
};

export function pathOf(node: TreeNode, byId: Map<string, TreeNode>): string {
  const parts: string[] = [];
  let current: TreeNode | undefined = node;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    parts.unshift(current.name);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return `/${parts.join("/")}`;
}

export function resolveRef(fromNode: TreeNode, ref: string, nodes: TreeNode[]): TreeNode | null {
  const queryMatch = /(?:^|[?&])file=([A-Za-z0-9_-]+)/.exec(ref);
  if (queryMatch?.[1]) {
    return nodes.find((node) => node.id === queryMatch[1]) ?? null;
  }
  const clean = ref.split("#")[0]?.split("?")[0]?.trim() ?? "";
  if (clean.length === 0 || /^[a-z]+:/i.test(clean)) {
    return null;
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const fromPath = pathOf(fromNode, byId);
  const fromDir = fromPath.slice(0, fromPath.lastIndexOf("/"));
  const base = clean.startsWith("/") ? clean : `${fromDir}/${clean}`;
  const segments: string[] = [];
  for (const segment of base.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const absolute = `/${segments.join("/")}`;
  const target = nodes.find((node) => pathOf(node, byId) === absolute);
  if (target) {
    return target;
  }
  const basename = segments.at(-1);
  if (basename) {
    const matches = nodes.filter((node) => node.kind !== "folder" && node.name === basename);
    if (matches.length === 1) {
      return matches[0] ?? null;
    }
  }
  return null;
}

export function sortNodes(nodes: TreeNode[]): TreeNode[] {
  return [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) {
      const rank = (kind: TreeNode["kind"]) => (kind === "folder" ? 0 : kind === "file" ? 1 : 2);
      return rank(a.kind) - rank(b.kind);
    }
    return a.name.localeCompare(b.name);
  });
}
