"use client";

import { type Editor, Extension } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from "@tiptap/y-tiptap";
import { useEffect } from "react";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

export type RichCommentRange = {
  id: string;
  startRel: ArrayBuffer;
  endRel: ArrayBuffer;
  status: "open" | "resolved";
};

export type RichDocSelection = {
  from: number;
  to: number;
  text: string;
  startRel: ArrayBuffer;
  endRel: ArrayBuffer;
};

type RichDocEditorProps = {
  ydoc: Y.Doc;
  awareness: Awareness;
  editable: boolean;
  userName: string;
  userColor: string;
  userColorLight: string;
  sessionId: string;
  commentRanges: RichCommentRange[];
  activeCommentId: string | null;
  onSelectionChange: (selection: RichDocSelection) => void;
  onCommentRangeClick: (commentId: string) => void;
};

const commentPluginKey = new PluginKey("stash-rich-comments");

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export default function RichDocEditor({
  ydoc,
  awareness,
  editable,
  userName,
  userColor,
  userColorLight,
  sessionId,
  commentRanges,
  activeCommentId,
  onSelectionChange,
  onCommentRangeClick,
}: RichDocEditorProps) {
  const reportSelection = (currentEditor: Editor) => {
    const syncState = ySyncPluginKey.getState(currentEditor.state);
    const mapping = syncState?.binding?.mapping;
    if (!mapping) {
      return;
    }
    const selection = currentEditor.state.selection;
    const fragment = ydoc.getXmlFragment("prosemirror");
    const startRel = absolutePositionToRelativePosition(selection.from, fragment, mapping);
    const endRel = absolutePositionToRelativePosition(selection.to, fragment, mapping);
    onSelectionChange({
      from: selection.from,
      to: selection.to,
      text: currentEditor.state.doc.textBetween(selection.from, selection.to, " "),
      startRel: toArrayBuffer(Y.encodeRelativePosition(startRel)),
      endRel: toArrayBuffer(Y.encodeRelativePosition(endRel)),
    });
  };

  const editor = useEditor(
    {
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
        Extension.create({
          name: "stashRichComments",
          addProseMirrorPlugins: () => [
            new Plugin({
              key: commentPluginKey,
              props: {
                decorations: (state) => {
                  const syncState = ySyncPluginKey.getState(state);
                  const mapping = syncState?.binding?.mapping;
                  if (!mapping) {
                    return DecorationSet.empty;
                  }
                  const fragment = ydoc.getXmlFragment("prosemirror");
                  const decorations = commentRanges.flatMap((range) => {
                    try {
                      const start = relativePositionToAbsolutePosition(
                        ydoc,
                        fragment,
                        Y.decodeRelativePosition(new Uint8Array(range.startRel)),
                        mapping,
                      );
                      const end = relativePositionToAbsolutePosition(
                        ydoc,
                        fragment,
                        Y.decodeRelativePosition(new Uint8Array(range.endRel)),
                        mapping,
                      );
                      if (start === null || end === null || start >= end) {
                        return [];
                      }
                      const classes = [
                        "stash-rich-comment",
                        range.status === "resolved" ? "stash-rich-comment-resolved" : "",
                        activeCommentId === range.id ? "stash-rich-comment-active" : "",
                      ]
                        .filter(Boolean)
                        .join(" ");
                      return [
                        Decoration.inline(start, end, {
                          class: classes,
                          "data-comment-id": range.id,
                        }),
                      ];
                    } catch {
                      return [];
                    }
                  });
                  return DecorationSet.create(state.doc, decorations);
                },
                handleClick: (_view, _position, event) => {
                  const target = event.target as HTMLElement | null;
                  const commentId =
                    target?.closest<HTMLElement>("[data-comment-id]")?.dataset.commentId;
                  if (commentId) {
                    onCommentRangeClick(commentId);
                  }
                  return false;
                },
              },
            }),
          ],
        }),
      ],
      onCreate: ({ editor: currentEditor }) => reportSelection(currentEditor),
      onSelectionUpdate: ({ editor: currentEditor }) => reportSelection(currentEditor),
    },
    [activeCommentId, awareness, commentRanges, ydoc],
  );

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  useEffect(() => {
    if (!editor || !activeCommentId) {
      return;
    }
    const syncState = ySyncPluginKey.getState(editor.state);
    const mapping = syncState?.binding?.mapping;
    const range = commentRanges.find((item) => item.id === activeCommentId);
    if (!mapping || !range) {
      return;
    }
    try {
      const fragment = ydoc.getXmlFragment("prosemirror");
      const start = relativePositionToAbsolutePosition(
        ydoc,
        fragment,
        Y.decodeRelativePosition(new Uint8Array(range.startRel)),
        mapping,
      );
      const end = relativePositionToAbsolutePosition(
        ydoc,
        fragment,
        Y.decodeRelativePosition(new Uint8Array(range.endRel)),
        mapping,
      );
      if (start !== null && end !== null && start < end) {
        editor.view.dispatch(
          editor.state.tr
            .setSelection(TextSelection.create(editor.state.doc, start, end))
            .scrollIntoView(),
        );
        editor.view.focus();
      }
    } catch {
      return;
    }
  }, [activeCommentId, commentRanges, editor, ydoc]);

  return (
    <div className="tiptap-doc min-h-0 flex-1 overflow-auto">
      <EditorContent editor={editor} />
    </div>
  );
}
