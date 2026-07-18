import type { Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  WidgetType,
} from "@codemirror/view";

class TextWidget extends WidgetType {
  constructor(
    private readonly text: string,
    private readonly className: string,
    private readonly label?: string,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = this.className;
    span.textContent = this.text;
    if (this.label) span.setAttribute("aria-label", this.label);
    return span;
  }

  override eq(other: TextWidget): boolean {
    return (
      this.text === other.text && this.className === other.className && this.label === other.label
    );
  }
}

class ImageWidget extends WidgetType {
  constructor(
    private readonly src: string,
    private readonly alt: string,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const image = document.createElement("img");
    image.src = this.src;
    image.alt = this.alt;
    image.loading = "lazy";
    image.className = "cm-visualImage";
    return image;
  }

  override eq(other: ImageWidget): boolean {
    return this.src === other.src && this.alt === other.alt;
  }
}

type Candidate = { from: number; to: number; decoration: Decoration };

function activeLines(view: EditorView): Set<number> {
  const lines = new Set<number>();
  for (const range of view.state.selection.ranges) {
    const first = view.state.doc.lineAt(range.from).number;
    const last = view.state.doc.lineAt(range.to).number;
    for (let line = first; line <= last; line += 1) lines.add(line);
  }
  return lines;
}

function marker(candidates: Candidate[], from: number, to: number): void {
  if (from < to) candidates.push({ from, to, decoration: Decoration.replace({}) });
}

function visualDecorations(
  view: EditorView,
  assetUrls: ReadonlyMap<string, string>,
): DecorationSet {
  const active = activeLines(view);
  const candidates: Candidate[] = [];
  for (const viewport of view.visibleRanges) {
    let position = view.state.doc.lineAt(viewport.from).from;
    while (position <= viewport.to && position <= view.state.doc.length) {
      const line = view.state.doc.lineAt(position);
      position = line.to + 1;
      if (active.has(line.number) || line.length > 20_000) continue;
      const text = line.text;
      if (/^\s*</.test(text) || /^\s*\|/.test(text)) continue;
      const heading = /^(\s*)(#{1,6})\s+/.exec(text);
      if (heading) {
        const level = heading[2]?.length ?? 1;
        marker(candidates, line.from + (heading[1]?.length ?? 0), line.from + heading[0].length);
        candidates.push({
          from: line.from,
          to: line.from,
          decoration: Decoration.line({ class: `cm-visualHeading cm-visualHeading${level}` }),
        });
      }
      const quote = /^(\s*)>\s?/.exec(text);
      if (quote) {
        marker(candidates, line.from + (quote[1]?.length ?? 0), line.from + quote[0].length);
        candidates.push({
          from: line.from,
          to: line.from,
          decoration: Decoration.line({ class: "cm-visualQuote" }),
        });
      }
      const checklist = /^(\s*)[-*+]\s+\[([ xX])\]\s+/.exec(text);
      if (checklist) {
        const checked = checklist[2]?.toLowerCase() === "x";
        candidates.push({
          from: line.from + (checklist[1]?.length ?? 0),
          to: line.from + checklist[0].length,
          decoration: Decoration.replace({
            widget: new TextWidget(
              checked ? "☑" : "☐",
              "cm-visualCheckbox",
              checked ? "Checked" : "Unchecked",
            ),
          }),
        });
      } else {
        const bullet = /^(\s*)[-*+]\s+/.exec(text);
        if (bullet) {
          candidates.push({
            from: line.from + (bullet[1]?.length ?? 0),
            to: line.from + bullet[0].length,
            decoration: Decoration.replace({ widget: new TextWidget("•", "cm-visualBullet") }),
          });
        }
      }
      const patterns = [
        /\*\*([^*\n]+)\*\*/g,
        /__([^_\n]+)__/g,
        /(?<!\*)\*([^*\n]+)\*(?!\*)/g,
        /(?<!_)_([^_\n]+)_(?!_)/g,
        /`([^`\n]+)`/g,
      ];
      for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) {
          const start = line.from + (match.index ?? 0);
          const opening = match[0].startsWith("**") || match[0].startsWith("__") ? 2 : 1;
          marker(candidates, start, start + opening);
          marker(candidates, start + match[0].length - opening, start + match[0].length);
        }
      }
      for (const match of text.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)) {
        const path = match[2] ?? "";
        const url = assetUrls.get(path);
        if (!url) continue;
        const start = line.from + (match.index ?? 0);
        candidates.push({
          from: start,
          to: start + match[0].length,
          decoration: Decoration.replace({ widget: new ImageWidget(url, match[1] || "Image") }),
        });
      }
      for (const match of text.matchAll(/(?<!!)\[([^\]]+)\]\(([^)]+)\)/g)) {
        const start = line.from + (match.index ?? 0);
        marker(candidates, start, start + 1);
        const labelEnd = start + 1 + (match[1]?.length ?? 0);
        marker(candidates, labelEnd, start + match[0].length);
      }
      for (const match of text.matchAll(/@\[([^\]]+)\]\(user:[^)]+\)/g)) {
        const start = line.from + (match.index ?? 0);
        candidates.push({
          from: start,
          to: start + match[0].length,
          decoration: Decoration.replace({
            widget: new TextWidget(`@${match[1]}`, "cm-visualMention"),
          }),
        });
      }
    }
  }
  candidates.sort((left, right) => left.from - right.from || left.to - right.to);
  const accepted: Candidate[] = [];
  let end = -1;
  for (const candidate of candidates) {
    if (candidate.from < end || (candidate.from === candidate.to && candidate.from < end)) continue;
    accepted.push(candidate);
    end = Math.max(end, candidate.to);
  }
  return Decoration.set(
    accepted.map((candidate) => candidate.decoration.range(candidate.from, candidate.to)),
    true,
  );
}

const visualTheme = EditorView.theme({
  ".cm-visualHeading": { fontWeight: "700", lineHeight: "1.35" },
  ".cm-visualHeading1": { fontSize: "1.8em" },
  ".cm-visualHeading2": { fontSize: "1.5em" },
  ".cm-visualHeading3": { fontSize: "1.28em" },
  ".cm-visualHeading4": { fontSize: "1.12em" },
  ".cm-visualQuote": {
    borderLeft: "3px solid var(--color-border)",
    paddingLeft: "0.75rem",
    opacity: "0.86",
  },
  ".cm-visualBullet": { display: "inline-block", width: "1.25rem", color: "var(--color-accent)" },
  ".cm-visualCheckbox": {
    display: "inline-block",
    width: "1.5rem",
    color: "var(--color-accent)",
    fontSize: "1.05em",
  },
  ".cm-visualMention": {
    borderRadius: "999px",
    background: "color-mix(in oklab, var(--color-accent) 14%, transparent)",
    color: "var(--color-accent)",
    padding: "0.08rem 0.4rem",
    fontWeight: "600",
  },
  ".cm-visualImage": {
    display: "block",
    maxWidth: "min(100%, 42rem)",
    maxHeight: "28rem",
    margin: "0.5rem 0",
    borderRadius: "0.5rem",
    objectFit: "contain",
  },
});

export function markdownVisualExtension(assetUrls: ReadonlyMap<string, string>): Extension {
  return [
    visualTheme,
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;

        constructor(view: EditorView) {
          this.decorations = visualDecorations(view, assetUrls);
        }

        update(update: {
          view: EditorView;
          docChanged: boolean;
          viewportChanged: boolean;
          selectionSet: boolean;
        }) {
          if (update.docChanged || update.viewportChanged || update.selectionSet) {
            this.decorations = visualDecorations(update.view, assetUrls);
          }
        }
      },
      { decorations: (plugin) => plugin.decorations },
    ),
  ];
}
