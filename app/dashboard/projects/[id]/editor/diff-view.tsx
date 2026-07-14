"use client";

import { syntaxHighlighting } from "@codemirror/language";
import { unifiedMergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { useEffect, useRef } from "react";
import {
  editorHighlightStyle,
  editorTheme,
  languageExtension,
} from "@/app/dashboard/projects/[id]/editor/lib/editor-theme";

type DiffViewProps = {
  original: string;
  modified: string;
  language: "md" | "html";
};

const diffTheme = EditorView.theme({
  ".cm-changedLine": {
    backgroundColor: "rgba(52, 211, 153, 0.12)",
  },
  ".cm-changedText": {
    backgroundColor: "rgba(52, 211, 153, 0.28)",
    borderRadius: "2px",
  },
  ".cm-changedLineGutter": {
    backgroundColor: "rgba(52, 211, 153, 0.22)",
    color: "#a7f3d0",
  },
  ".cm-deletedChunk": {
    backgroundColor: "rgba(248, 113, 113, 0.08)",
  },
  ".cm-deletedLine": {
    backgroundColor: "rgba(248, 113, 113, 0.14)",
  },
  ".cm-deletedText": {
    backgroundColor: "rgba(248, 113, 113, 0.32)",
    borderRadius: "2px",
    textDecoration: "line-through",
  },
  ".cm-deletedLineGutter": {
    backgroundColor: "rgba(248, 113, 113, 0.22)",
  },
  ".cm-changeGutter": {
    width: "3px",
  },
});

export function DiffView({ original, modified, language }: DiffViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const parent = hostRef.current;
    if (!parent) {
      return;
    }
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: modified,
        extensions: [
          lineNumbers(),
          syntaxHighlighting(editorHighlightStyle, { fallback: true }),
          languageExtension(language),
          editorTheme,
          diffTheme,
          EditorView.lineWrapping,
          EditorView.editable.of(false),
          EditorState.readOnly.of(true),
          unifiedMergeView({
            original,
            mergeControls: false,
            gutter: true,
            highlightChanges: true,
          }),
        ],
      }),
    });
    return () => view.destroy();
  }, [original, modified, language]);

  return <div ref={hostRef} className="size-full overflow-hidden" />;
}
