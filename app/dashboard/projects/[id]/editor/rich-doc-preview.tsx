"use client";

import Collaboration from "@tiptap/extension-collaboration";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useMemo } from "react";
import * as Y from "yjs";

type RichDocPreviewProps = {
  contentState: ArrayBuffer | null;
  fallbackContent: string;
};

function initialDocument(content: string): string {
  return content
    ? `<p>${content
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\n/g, "<br>")}</p>`
    : "<p></p>";
}

export function RichDocPreview({ contentState, fallbackContent }: RichDocPreviewProps) {
  const ydoc = useMemo(() => {
    if (!contentState) {
      return null;
    }
    const value = new Y.Doc();
    Y.applyUpdate(value, new Uint8Array(contentState));
    return value;
  }, [contentState]);
  const editor = useEditor(
    {
      editable: false,
      immediatelyRender: false,
      content: ydoc ? undefined : initialDocument(fallbackContent),
      editorProps: {
        attributes: {
          "aria-label": "Shared rich text document",
          class: "tiptap-doc-content",
          role: "document",
        },
      },
      extensions: ydoc
        ? [StarterKit.configure({ undoRedo: false }), Collaboration.configure({ document: ydoc })]
        : [StarterKit],
    },
    [fallbackContent, ydoc],
  );

  return (
    <div className="tiptap-doc h-full overflow-auto">
      <EditorContent editor={editor} />
    </div>
  );
}
