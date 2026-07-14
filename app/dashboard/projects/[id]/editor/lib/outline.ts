export type OutlineItem = {
  level: number;
  text: string;
  offset: number;
  index: number;
  target: string;
};

function outlineItem(level: number, text: string, offset: number, index: number): OutlineItem {
  return { level, text: text || "Untitled", offset, index, target: `stash-heading-${index}` };
}

function markdownOutline(content: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  let offset = 0;
  let inFence = false;
  let fenceMarker = "";
  let index = 0;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    const fence = /^(```|~~~)/.exec(trimmed);
    if (fence?.[1]) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1];
      } else if (trimmed.startsWith(fenceMarker)) {
        inFence = false;
      }
    } else if (!inFence) {
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading?.[1] && heading[2] !== undefined) {
        const text = heading[2].replace(/\s+#+\s*$/, "").trim();
        items.push(outlineItem(heading[1].length, text, offset, index));
        index += 1;
      }
    }
    offset += line.length + 1;
  }
  const lines = content.split("\n");
  let lineOffset = 0;
  let fenced = false;
  let marker = "";
  const existingOffsets = new Set(items.map((item) => item.offset));
  for (let lineIndex = 0; lineIndex < lines.length - 1; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    const trimmed = line.trim();
    const fence = /^(```|~~~)/.exec(trimmed);
    if (fence?.[1]) {
      if (!fenced) {
        fenced = true;
        marker = fence[1];
      } else if (trimmed.startsWith(marker)) {
        fenced = false;
      }
    }
    const underline = /^\s*(=+|-+)\s*$/.exec(lines[lineIndex + 1] ?? "");
    if (!fenced && trimmed && underline && !existingOffsets.has(lineOffset)) {
      items.push(outlineItem(underline[1]?.startsWith("=") ? 1 : 2, trimmed, lineOffset, -1));
    }
    lineOffset += line.length + 1;
  }
  items.sort((a, b) => a.offset - b.offset);
  items.forEach((item, itemIndex) => {
    item.index = itemIndex;
    item.target = `stash-heading-${itemIndex}`;
  });
  return items;
}

function htmlOutline(content: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  const searchable = content
    .replace(/<!--[\s\S]*?-->/g, (value) => " ".repeat(value.length))
    .replace(/<(pre|code|script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, (value) =>
      " ".repeat(value.length),
    );
  const pattern = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let match = pattern.exec(searchable);
  let index = 0;
  while (match !== null) {
    const level = Number(match[1]);
    const text = (match[2] ?? "")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    items.push(outlineItem(level, text, match.index, index));
    index += 1;
    match = pattern.exec(searchable);
  }
  return items;
}

export function extractTextOutline(content: string, isHtml: boolean): OutlineItem[] {
  return isHtml ? htmlOutline(content) : markdownOutline(content);
}
