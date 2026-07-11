"use client";

import type { CompletionContext } from "@codemirror/autocomplete";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  highlightSelectionMatches,
  openSearchPanel,
  replaceAll,
  replaceNext,
  SearchQuery,
  search,
  searchKeymap,
  selectMatches,
  setSearchQuery,
} from "@codemirror/search";
import { EditorState, Prec } from "@codemirror/state";
import {
  crosshairCursor,
  Decoration,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  type Panel,
  rectangularSelection,
  ViewPlugin,
} from "@codemirror/view";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import { UndoManager } from "yjs";
import {
  editorHighlightStyle,
  editorTheme,
  languageExtension,
} from "@/app/dashboard/projects/[id]/editor/lib/editor-theme";
import { pathOf, type TreeNode } from "@/app/dashboard/projects/[id]/editor/tree-utils";

type DocEditorProps = {
  initialContent: string;
  language: "md" | "html";
  readOnly: boolean;
  onChange: (value: string) => void;
  maxContentBytes?: number;
  onLimit?: () => void;
  ytext?: Y.Text;
  awareness?: Awareness;
  commentRanges?: CommentRange[];
  activeCommentId?: string | null;
  focusRequest?: CommentFocusRequest | null;
  onSelectionChange?: (selection: EditorSelectionState) => void;
  onCommentRangeClick?: (commentId: string) => void;
  onInsertImage?: (file: File) => Promise<string | null>;
  fileNode?: TreeNode;
  nodes?: TreeNode[];
};

export type DocEditorHandle = {
  focusRange: (from: number, to: number) => void;
};

export type EditorSelectionState = {
  from: number;
  to: number;
  text: string;
};

export type CommentRange = {
  id: string;
  from: number;
  to: number;
  status: "open" | "resolved";
};

export type CommentFocusRequest = {
  id: string;
  from: number;
  to: number;
  nonce: number;
};

const remoteCursorTheme = EditorView.theme({
  ".cm-ySelectionInfo": {
    fontFamily: "var(--font-mono), monospace",
    fontSize: "0.68rem",
    fontStyle: "normal",
    fontWeight: "500",
    padding: "1px 5px",
    borderRadius: "5px",
    top: "-1.55em",
    maxWidth: "20rem",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    letterSpacing: "0.01em",
    zIndex: "20",
    boxShadow: "0 8px 24px color-mix(in oklab, #000 28%, transparent)",
  },
  ".cm-ySelectionCaret": {
    borderLeftWidth: "1.5px",
    borderRightWidth: "1.5px",
  },
  ".cm-ySelectionCaretDot": {
    display: "none",
  },
  ".cm-ySelectionInfo.cm-ySelectionInfo-below": {
    top: "calc(100% + 2px)",
  },
  ".cm-ySelectionInfo.cm-ySelectionInfo-flip-x": {
    left: "auto",
    right: "-1px",
  },
});

const CARET_INFO_MARGIN = 4;

function placeRemoteCaretInfo(view: EditorView, caret: HTMLElement): void {
  const info = caret.querySelector<HTMLElement>(".cm-ySelectionInfo");
  if (!info) {
    return;
  }
  info.classList.remove("cm-ySelectionInfo-below", "cm-ySelectionInfo-flip-x");
  const scroller = view.scrollDOM.getBoundingClientRect();
  const caretRect = caret.getBoundingClientRect();
  const infoRect = info.getBoundingClientRect();
  if (caretRect.top - scroller.top < infoRect.height + CARET_INFO_MARGIN) {
    info.classList.add("cm-ySelectionInfo-below");
  }
  if (caretRect.left + infoRect.width + CARET_INFO_MARGIN > scroller.right) {
    info.classList.add("cm-ySelectionInfo-flip-x");
  }
}

const remoteCursorInfoPlacement = ViewPlugin.fromClass(
  class {
    constructor(private readonly view: EditorView) {
      view.scrollDOM.addEventListener("pointerover", this.onPointerOver);
    }

    onPointerOver = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      const caret = target?.closest<HTMLElement>(".cm-ySelectionCaret");
      if (caret) {
        placeRemoteCaretInfo(this.view, caret);
      }
    };

    destroy() {
      this.view.scrollDOM.removeEventListener("pointerover", this.onPointerOver);
    }
  },
);

const commentTheme = EditorView.theme({
  ".cm-commentRange": {
    borderBottom: "1px solid color-mix(in oklab, var(--accent) 70%, transparent)",
    backgroundColor: "color-mix(in oklab, var(--accent) 12%, transparent)",
    cursor: "pointer",
  },
  ".cm-commentRangeResolved": {
    borderBottomColor: "color-mix(in oklab, var(--muted-foreground) 45%, transparent)",
    backgroundColor: "color-mix(in oklab, var(--muted-foreground) 10%, transparent)",
  },
  ".cm-commentRangeActive": {
    backgroundColor: "color-mix(in oklab, var(--accent) 22%, transparent)",
    borderBottomColor: "var(--accent)",
  },
});

const SEARCH_INPUT =
  "h-8 min-w-0 flex-1 rounded-md border border-hairline bg-[var(--editor-control)] px-2.5 font-mono text-foreground text-xs outline-none transition-colors placeholder:text-muted-foreground/45 focus:border-accent/50 focus:ring-1 focus:ring-ring sm:h-7 sm:w-48 sm:flex-none";
const SEARCH_ACTION_GROUP = "grid min-w-0 flex-1 grid-cols-3 gap-1.5 sm:w-[246px] sm:grid-cols-6";
const SEARCH_REPLACE_GROUP = "grid min-w-0 flex-1 grid-cols-2 gap-1.5 sm:w-[246px]";
const SEARCH_ACTION_BTN =
  "flex h-8 min-w-9 shrink-0 cursor-pointer items-center justify-center rounded-md border border-hairline bg-[var(--editor-control)] font-medium font-mono text-[10px] text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground sm:h-7";
const SEARCH_REPLACE_BTN =
  "flex h-8 w-full shrink-0 cursor-pointer items-center justify-center rounded-md border border-hairline bg-[var(--editor-control)] px-2 font-medium font-mono text-[10px] text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground sm:h-7";
const SEARCH_TOGGLE_ON =
  "flex h-8 min-w-9 shrink-0 cursor-pointer items-center justify-center rounded-md border border-accent/40 bg-accent/15 font-medium font-mono text-[10px] text-foreground sm:h-7";
const SEARCH_TOGGLE_OFF =
  "flex h-8 min-w-9 shrink-0 cursor-pointer items-center justify-center rounded-md border border-hairline bg-[var(--editor-control)] font-medium font-mono text-[10px] text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground sm:h-7";
const SEARCH_CLOSE =
  "ml-auto flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-sm text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive sm:size-7";

function createStashSearchPanel(view: EditorView): Panel {
  const initial = getSearchQuery(view.state);
  const flags = {
    caseSensitive: initial.caseSensitive,
    regexp: initial.regexp,
    wholeWord: initial.wholeWord,
  };

  const selection = view.state.sliceDoc(
    view.state.selection.main.from,
    view.state.selection.main.to,
  );
  const initialSearch = initial.search || (selection && !selection.includes("\n") ? selection : "");

  const findInput = document.createElement("input");
  findInput.className = SEARCH_INPUT;
  findInput.placeholder = "Find";
  findInput.value = initialSearch;
  findInput.setAttribute("aria-label", "Find");

  const replaceInput = document.createElement("input");
  replaceInput.className = SEARCH_INPUT;
  replaceInput.placeholder = "Replace";
  replaceInput.value = initial.replace;
  replaceInput.setAttribute("aria-label", "Replace");

  const commit = () => {
    view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({
          search: findInput.value,
          replace: replaceInput.value,
          caseSensitive: flags.caseSensitive,
          regexp: flags.regexp,
          wholeWord: flags.wholeWord,
        }),
      ),
    });
  };

  const actionButton = (label: string, title: string, run: (v: EditorView) => boolean) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = SEARCH_ACTION_BTN;
    button.textContent = label;
    button.title = title;
    button.ariaLabel = title;
    button.onclick = () => {
      run(view);
      view.focus();
    };
    return button;
  };

  const replaceButton = (label: string, title: string, run: (v: EditorView) => boolean) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = SEARCH_REPLACE_BTN;
    button.textContent = label;
    button.title = title;
    button.ariaLabel = title;
    button.onclick = () => {
      run(view);
      view.focus();
    };
    return button;
  };

  const toggleButton = (label: string, title: string, key: keyof typeof flags) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.title = title;
    button.ariaLabel = title;
    const paint = () => {
      button.className = flags[key] ? SEARCH_TOGGLE_ON : SEARCH_TOGGLE_OFF;
      button.setAttribute("aria-pressed", String(flags[key]));
    };
    paint();
    button.onclick = () => {
      flags[key] = !flags[key];
      paint();
      commit();
      findInput.focus();
    };
    return button;
  };

  const onFindKey = (event: KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
      (event.shiftKey ? findPrevious : findNext)(view);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeSearchPanel(view);
      view.focus();
    }
  };
  const onReplaceKey = (event: KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
      replaceNext(view);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeSearchPanel(view);
      view.focus();
    }
  };

  findInput.addEventListener("input", commit);
  replaceInput.addEventListener("input", commit);
  findInput.addEventListener("keydown", onFindKey);
  replaceInput.addEventListener("keydown", onReplaceKey);

  const row1 = document.createElement("div");
  row1.className = "flex flex-wrap items-center gap-1.5";
  const searchActions = document.createElement("div");
  searchActions.className = SEARCH_ACTION_GROUP;
  searchActions.append(
    actionButton("↑", "Previous match (Shift+Enter)", findPrevious),
    actionButton("↓", "Next match (Enter)", findNext),
    actionButton("All", "Select all matches", selectMatches),
    toggleButton("Aa", "Match case", "caseSensitive"),
    toggleButton(".*", "Regular expression", "regexp"),
    toggleButton("W", "Whole word", "wholeWord"),
  );
  row1.append(
    findInput,
    searchActions,
    actionButton("×", "Close (Esc)", (v) => {
      closeSearchPanel(v);
      return true;
    }),
  );
  const closeButton = row1.lastElementChild as HTMLButtonElement;
  closeButton.className = SEARCH_CLOSE;
  closeButton.ariaLabel = "Close find and replace";

  const row2 = document.createElement("div");
  row2.className = "flex flex-wrap items-center gap-1.5";
  const replaceActions = document.createElement("div");
  replaceActions.className = SEARCH_REPLACE_GROUP;
  replaceActions.append(
    replaceButton("Replace", "Replace next match", replaceNext),
    replaceButton("Replace all", "Replace all matches", replaceAll),
  );
  row2.append(replaceInput, replaceActions);

  const dom = document.createElement("div");
  dom.className = "flex flex-col gap-2 px-3 py-2.5";
  dom.setAttribute("role", "search");
  dom.setAttribute("aria-label", "Find and replace");
  dom.onkeydown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSearchPanel(view);
      view.focus();
    }
  };
  dom.append(row1, row2);

  return {
    dom,
    top: true,
    mount() {
      if (findInput.value) {
        commit();
      }
      findInput.focus();
      findInput.select();
    },
  };
}

function relativePath(from: TreeNode, to: TreeNode, nodes: TreeNode[]): string {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const fromParts = pathOf(from, byId).split("/").filter(Boolean).slice(0, -1);
  const toParts = pathOf(to, byId).split("/").filter(Boolean);
  while (fromParts[0] && fromParts[0] === toParts[0]) {
    fromParts.shift();
    toParts.shift();
  }
  return [...fromParts.map(() => ".."), ...toParts].join("/") || to.name;
}

function fileCompletions(language: "md" | "html", fileNode?: TreeNode, nodes: TreeNode[] = []) {
  return (context: CompletionContext) => {
    if (!fileNode) {
      return null;
    }
    const before = context.state.sliceDoc(0, context.pos);
    const match =
      language === "md" ? /\]\(([^)\s]*)$/.exec(before) : /(?:href|src)="([^"]*)$/.exec(before);
    if (!match) {
      return null;
    }
    const from = context.pos - (match[1]?.length ?? 0);
    const options = nodes
      .filter((node) => node.kind !== "folder" && node.id !== fileNode.id)
      .sort((a, b) => {
        const sameParent =
          Number(b.parentId === fileNode.parentId) - Number(a.parentId === fileNode.parentId);
        return sameParent || a.name.localeCompare(b.name);
      })
      .map((node) => ({
        label: relativePath(fileNode, node, nodes),
        detail:
          node.parentId === fileNode.parentId
            ? "Same folder"
            : pathOf(node, new Map(nodes.map((item) => [item.id, item]))),
        type: node.kind === "asset" ? "image" : "file",
      }));
    return { from, options, validFor: /[^)"\s]*/ };
  };
}

function editorExtensions(
  language: "md" | "html",
  collab: boolean,
  fileNode?: TreeNode,
  nodes?: TreeNode[],
) {
  const editorKeymap = [
    closeBracketsKeymap,
    defaultKeymap,
    searchKeymap,
    foldKeymap,
    completionKeymap,
    [indentWithTab],
    collab ? [] : historyKeymap,
    [
      { key: "Mod-h", run: openSearchPanel },
      { key: "Mod-Shift-h", run: openSearchPanel },
      { key: "Mod-Shift-f", run: openSearchPanel },
    ],
  ].flat();

  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(editorHighlightStyle, { fallback: true }),
    bracketMatching(),
    closeBrackets(),
    autocompletion({ override: [fileCompletions(language, fileNode, nodes)] }),
    rectangularSelection(),
    crosshairCursor(),
    search({ top: true, createPanel: createStashSearchPanel }),
    highlightActiveLine(),
    highlightSelectionMatches(),
    languageExtension(language),
    editorTheme,
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({
      "aria-label": language === "html" ? "HTML source editor" : "Markdown source editor",
      "aria-multiline": "true",
      role: "textbox",
    }),
    keymap.of(editorKeymap),
    ...(collab ? [] : [history()]),
  ];
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function imageFilesFrom(data: DataTransfer | null): File[] {
  if (!data) {
    return [];
  }
  return [...data.files].filter((file) => file.type.startsWith("image/"));
}

function imageAlt(name: string): string {
  const base = name.replace(/\.[^.]+$/, "").trim();
  return base.length > 0 ? base : "image";
}

function imageSnippet(language: "md" | "html", path: string, alt: string): string {
  if (language === "html") {
    return `<img src="${path}" alt="${alt}">`;
  }
  const dest = /[\s()]/.test(path) ? `<${path}>` : path;
  return `![${alt}](${dest})`;
}

const UNDO_BOUNDARY = /[\s.,;:!?)\]}>"']/;

function wordBoundaryUndo(undoManager: UndoManager) {
  return EditorView.updateListener.of((update) => {
    for (const tr of update.transactions) {
      if (!tr.docChanged || !tr.isUserEvent("input")) {
        continue;
      }
      let boundary = false;
      tr.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
        if (UNDO_BOUNDARY.test(inserted.toString())) {
          boundary = true;
        }
      });
      if (boundary) {
        undoManager.stopCapturing();
      }
    }
  });
}

export const DocEditor = forwardRef<DocEditorHandle, DocEditorProps>(function DocEditor(
  {
    initialContent,
    language,
    readOnly,
    onChange,
    maxContentBytes,
    onLimit,
    ytext,
    awareness,
    commentRanges = [],
    activeCommentId = null,
    focusRequest = null,
    onSelectionChange,
    onCommentRangeClick,
    onInsertImage,
    fileNode,
    nodes,
  },
  ref,
) {
  const parentRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onLimitRef = useRef(onLimit);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onCommentRangeClickRef = useRef(onCommentRangeClick);
  const onInsertImageRef = useRef(onInsertImage);
  const commentRangesRef = useRef(commentRanges);
  const activeCommentIdRef = useRef(activeCommentId);
  const initialContentRef = useRef(initialContent);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onLimitRef.current = onLimit;
  }, [onLimit]);

  useEffect(() => {
    onSelectionChangeRef.current = onSelectionChange;
  }, [onSelectionChange]);

  useEffect(() => {
    onCommentRangeClickRef.current = onCommentRangeClick;
  }, [onCommentRangeClick]);

  useEffect(() => {
    onInsertImageRef.current = onInsertImage;
  }, [onInsertImage]);

  useEffect(() => {
    commentRangesRef.current = commentRanges;
    viewRef.current?.dispatch({});
  }, [commentRanges]);

  useEffect(() => {
    activeCommentIdRef.current = activeCommentId;
    viewRef.current?.dispatch({});
  }, [activeCommentId]);

  useEffect(() => {
    initialContentRef.current = initialContent;
  }, [initialContent]);

  useImperativeHandle(
    ref,
    () => ({
      focusRange(from, to) {
        const view = viewRef.current;
        if (!view) {
          return;
        }
        const start = Math.max(0, Math.min(from, view.state.doc.length));
        const end = Math.max(start, Math.min(to, view.state.doc.length));
        view.dispatch({
          selection: { anchor: start, head: end },
          effects: EditorView.scrollIntoView(start, { y: "center" }),
        });
        view.focus();
      },
    }),
    [],
  );

  useEffect(() => {
    if (!parentRef.current) {
      return;
    }
    const collab = Boolean(ytext && awareness);
    let undoManager: UndoManager | null = null;
    const collabExtensions = [];
    if (ytext && awareness) {
      undoManager = new UndoManager(ytext, { captureTimeout: 400 });
      collabExtensions.push(
        yCollab(ytext, awareness, { undoManager }),
        remoteCursorTheme,
        remoteCursorInfoPlacement,
        Prec.high(keymap.of(yUndoManagerKeymap)),
        wordBoundaryUndo(undoManager),
      );
    }
    const commentExtensions = [
      commentTheme,
      EditorView.decorations.of((view) => {
        const ranges = commentRangesRef.current
          .filter((range) => range.from < range.to && range.to <= view.state.doc.length)
          .sort((a, b) => a.from - b.from || a.to - b.to)
          .map((range) => {
            const active = activeCommentIdRef.current === range.id;
            const classes = [
              "cm-commentRange",
              range.status === "resolved" ? "cm-commentRangeResolved" : "",
              active ? "cm-commentRangeActive" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return Decoration.mark({
              class: classes,
              attributes: { "data-comment-id": range.id },
            }).range(range.from, range.to);
          });
        return Decoration.set(ranges, true);
      }),
      EditorView.domEventHandlers({
        mousedown(event) {
          const target = event.target as HTMLElement | null;
          const marker = target?.closest<HTMLElement>("[data-comment-id]");
          const commentId = marker?.dataset.commentId;
          if (commentId) {
            onCommentRangeClickRef.current?.(commentId);
          }
          return false;
        },
      }),
    ];
    const insertImagesAt = async (target: EditorView, files: File[], startPos: number) => {
      let pos = startPos;
      for (const file of files) {
        const path = await onInsertImageRef.current?.(file);
        if (!path || viewRef.current !== target) {
          continue;
        }
        const at = Math.min(pos, target.state.doc.length);
        const snippet = imageSnippet(language, path, imageAlt(file.name));
        target.dispatch({
          changes: { from: at, insert: snippet },
          selection: { anchor: at + snippet.length },
        });
        pos = at + snippet.length;
      }
    };
    const imageInsertHandlers = EditorView.domEventHandlers({
      paste(event, target) {
        if (readOnly || !onInsertImageRef.current) {
          return false;
        }
        const files = imageFilesFrom(event.clipboardData);
        if (files.length === 0) {
          return false;
        }
        event.preventDefault();
        void insertImagesAt(target, files, target.state.selection.main.head);
        return true;
      },
      drop(event, target) {
        if (readOnly || !onInsertImageRef.current) {
          return false;
        }
        const files = imageFilesFrom(event.dataTransfer);
        if (files.length === 0) {
          return false;
        }
        event.preventDefault();
        const pos =
          target.posAtCoords({ x: event.clientX, y: event.clientY }) ??
          target.state.selection.main.head;
        void insertImagesAt(target, files, pos);
        return true;
      },
    });
    const view = new EditorView({
      doc: collab ? (ytext?.toString() ?? "") : initialContentRef.current,
      parent: parentRef.current,
      extensions: [
        ...editorExtensions(language, collab, fileNode, nodes),
        EditorState.readOnly.of(readOnly),
        maxContentBytes
          ? EditorState.transactionFilter.of((transaction) => {
              if (
                !transaction.docChanged ||
                byteLength(transaction.newDoc.toString()) <= maxContentBytes
              ) {
                return transaction;
              }
              onLimitRef.current?.();
              return [];
            })
          : [],
        ...commentExtensions,
        imageInsertHandlers,
        ...collabExtensions,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
          if (update.selectionSet || update.docChanged) {
            const selection = update.state.selection.main;
            onSelectionChangeRef.current?.({
              from: selection.from,
              to: selection.to,
              text: update.state.sliceDoc(selection.from, selection.to),
            });
          }
        }),
      ],
    });
    viewRef.current = view;
    const selection = view.state.selection.main;
    onSelectionChangeRef.current?.({
      from: selection.from,
      to: selection.to,
      text: view.state.sliceDoc(selection.from, selection.to),
    });
    return () => {
      viewRef.current = null;
      view.destroy();
      undoManager?.destroy();
    };
  }, [language, maxContentBytes, readOnly, ytext, awareness, fileNode, nodes]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || (ytext && awareness)) {
      return;
    }
    const current = view.state.doc.toString();
    if (current !== initialContent) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: initialContent } });
    }
  }, [initialContent, ytext, awareness]);

  useEffect(() => {
    if (focusRequest) {
      const view = viewRef.current;
      if (!view) {
        return;
      }
      const start = Math.max(0, Math.min(focusRequest.from, view.state.doc.length));
      const end = Math.max(start, Math.min(focusRequest.to, view.state.doc.length));
      view.dispatch({
        selection: { anchor: start, head: end },
        effects: EditorView.scrollIntoView(start, { y: "center" }),
      });
      view.focus();
    }
  }, [focusRequest]);

  return <div ref={parentRef} className="h-full overflow-hidden" />;
});
