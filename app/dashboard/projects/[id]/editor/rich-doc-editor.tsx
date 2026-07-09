"use client";

import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect } from "react";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";

type RichDocEditorProps = {
  ydoc: Y.Doc;
  awareness: Awareness;
  editable: boolean;
  userName: string;
  userColor: string;
  userColorLight: string;
  sessionId: string;
};

export default function RichDocEditor({
  ydoc,
  awareness,
  editable,
  userName,
  userColor,
  userColorLight,
  sessionId,
}: RichDocEditorProps) {
  const editor = useEditor({
    editable,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        "aria-label": "Rich text document editor",
        "aria-multiline": "true",
        class: "tiptap-doc-content",
        role: "textbox",
        spellcheck: "true",
      },
    },
    extensions: [
      StarterKit.configure({ undoRedo: false }),
      Collaboration.configure({ fragment: ydoc.getXmlFragment("prosemirror") }),
      CollaborationCaret.configure({
        provider: { awareness },
        user: { name: userName, color: userColor, colorLight: userColorLight, sessionId },
      }),
    ],
  });

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  return (
    <div className="tiptap-doc min-h-0 flex-1 overflow-auto">
      <EditorContent editor={editor} />
    </div>
  );
}
