import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

export const editorHighlightStyle = HighlightStyle.define([
  { tag: tags.content, color: "#e8edf7" },
  { tag: tags.heading, color: "#f8fafc", fontWeight: "700" },
  { tag: tags.heading1, color: "#f8fafc", fontWeight: "800" },
  { tag: tags.heading2, color: "#e5edff", fontWeight: "750" },
  { tag: tags.heading3, color: "#dbeafe", fontWeight: "700" },
  { tag: tags.strong, color: "#f8fafc", fontWeight: "800" },
  { tag: tags.emphasis, color: "#f5e8ff", fontStyle: "italic" },
  { tag: tags.strikethrough, color: "#a6b0c3", textDecoration: "line-through" },
  { tag: tags.monospace, color: "#c4f1ff", backgroundColor: "#111827" },
  { tag: [tags.link, tags.url], color: "#8ab4ff", textDecoration: "underline" },
  { tag: tags.list, color: "#f4c67a" },
  { tag: tags.quote, color: "#bdd6ff" },
  { tag: tags.tagName, color: "#7dd3fc" },
  { tag: tags.attributeName, color: "#fbbf77" },
  { tag: tags.attributeValue, color: "#b7f7c2" },
  { tag: tags.string, color: "#b7f7c2" },
  { tag: [tags.number, tags.integer, tags.float, tags.bool, tags.null], color: "#f9d37a" },
  { tag: tags.keyword, color: "#c4b5fd", fontWeight: "650" },
  { tag: [tags.operator, tags.punctuation, tags.separator], color: "#aeb8cb" },
  {
    tag: [tags.bracket, tags.squareBracket, tags.angleBracket, tags.paren, tags.brace],
    color: "#d5dded",
  },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    color: "#7f8aa3",
    fontStyle: "italic",
  },
  { tag: tags.invalid, color: "#fecaca", backgroundColor: "#7f1d1d" },
]);

export const editorTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      backgroundColor: "var(--editor-workspace)",
      color: "#e8edf7",
      fontSize: "13px",
    },
    ".cm-editor": {
      backgroundColor: "var(--editor-workspace)",
    },
    ".cm-scroller": {
      fontFamily: "var(--font-mono), monospace",
      lineHeight: "1.6",
      padding: "0.5rem 0",
      scrollbarColor:
        "color-mix(in oklab, var(--foreground) 42%, transparent) var(--editor-workspace)",
      scrollbarWidth: "thin",
    },
    ".cm-scroller::-webkit-scrollbar": {
      width: "12px",
      height: "12px",
    },
    ".cm-scroller::-webkit-scrollbar-track": {
      backgroundColor: "var(--editor-workspace)",
      borderLeft: "1px solid var(--hairline)",
    },
    ".cm-scroller::-webkit-scrollbar-thumb": {
      minHeight: "3rem",
      backgroundColor: "color-mix(in oklab, var(--foreground) 32%, transparent)",
      border: "3px solid transparent",
      borderRadius: "999px",
      backgroundClip: "content-box",
    },
    ".cm-scroller::-webkit-scrollbar-thumb:hover": {
      backgroundColor: "color-mix(in oklab, var(--accent) 72%, var(--foreground) 18%)",
    },
    ".cm-scroller::-webkit-scrollbar-corner": {
      backgroundColor: "transparent",
    },
    ".cm-content": {
      caretColor: "#f8fafc",
      color: "#e8edf7",
      fontWeight: "520",
    },
    ".cm-line": {
      color: "#e8edf7",
    },
    ".cm-gutters": {
      backgroundColor: "var(--editor-workspace)",
      color: "#7f8aa3",
      border: "none",
    },
    ".cm-activeLine": {
      backgroundColor: "rgba(148, 163, 184, 0.11)",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "rgba(148, 163, 184, 0.08)",
      color: "#c5cedd",
    },
    ".cm-cursor": { borderLeftColor: "#f8fafc" },
    "&.cm-focused": { outline: "none" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
      backgroundColor: "rgba(96, 165, 250, 0.32)",
    },
    ".cm-panels": {
      backgroundColor: "var(--editor-panel)",
      color: "var(--foreground)",
      fontFamily: "var(--font-mono), monospace",
    },
    ".cm-panels.cm-panels-top": {
      borderBottom: "1px solid var(--hairline)",
    },
    ".cm-panels.cm-panels-bottom": {
      borderTop: "1px solid var(--hairline)",
    },
    ".cm-searchMatch": {
      backgroundColor: "rgba(250, 204, 21, 0.34)",
      borderRadius: "2px",
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: "rgba(96, 165, 250, 0.48)",
    },
    ".cm-selectionMatch": {
      backgroundColor: "rgba(96, 165, 250, 0.2)",
    },
    ".cm-tooltip": {
      backgroundColor: "var(--editor-panel)",
      color: "var(--foreground)",
      border: "1px solid var(--hairline)",
      borderRadius: "8px",
      overflow: "hidden",
      boxShadow: "0 12px 32px color-mix(in oklab, #000 34%, transparent)",
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul": {
      fontFamily: "var(--font-mono), monospace",
      fontSize: "12px",
      maxHeight: "15rem",
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
      padding: "3px 8px",
    },
    ".cm-tooltip-autocomplete ul li[aria-selected]": {
      backgroundColor: "color-mix(in oklab, var(--accent) 88%, transparent)",
      color: "var(--accent-foreground)",
    },
    ".cm-completionIcon": {
      color: "var(--muted-foreground)",
      opacity: "0.8",
    },
    ".cm-tooltip.cm-completionInfo": {
      backgroundColor: "var(--editor-panel)",
      border: "1px solid var(--hairline)",
    },
    ".cm-foldPlaceholder": {
      backgroundColor: "rgba(148, 163, 184, 0.16)",
      color: "#c5cedd",
      border: "1px solid var(--hairline)",
      borderRadius: "4px",
      padding: "0 6px",
    },
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
      backgroundColor: "rgba(125, 211, 252, 0.2)",
      outline: "1px solid rgba(125, 211, 252, 0.55)",
    },
  },
  { dark: true },
);

export function languageExtension(language: "md" | "html") {
  return language === "html" ? html() : markdown();
}
