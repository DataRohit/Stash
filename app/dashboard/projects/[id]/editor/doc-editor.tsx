"use client";

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
import { useEffect, useRef } from "react";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import { UndoManager } from "yjs";
import {
  editorHighlightStyle,
  editorTheme,
  languageExtension,
} from "@/app/dashboard/projects/[id]/editor/lib/editor-theme";

type DocEditorProps = {
  initialContent: string;
  language: "md" | "html";
  readOnly: boolean;
  onChange: (value: string) => void;
  maxContentBytes?: number;
  onLimit?: () => void;
  ytext?: Y.Text;
  awareness?: Awareness;
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

const SEARCH_INPUT =
  "h-7 w-48 max-w-[45vw] rounded-md border border-hairline bg-[var(--editor-control)] px-2.5 font-mono text-foreground text-xs outline-none transition-colors placeholder:text-muted-foreground/45 focus:border-accent/50 focus:ring-1 focus:ring-ring";
const SEARCH_ACTION_GROUP = "grid w-[246px] grid-cols-6 gap-1.5";
const SEARCH_REPLACE_GROUP = "grid w-[246px] grid-cols-2 gap-1.5";
const SEARCH_ACTION_BTN =
  "flex h-7 w-9 shrink-0 cursor-pointer items-center justify-center rounded-md border border-hairline bg-[var(--editor-control)] font-medium font-mono text-[10px] text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground";
const SEARCH_REPLACE_BTN =
  "flex h-7 w-full shrink-0 cursor-pointer items-center justify-center rounded-md border border-hairline bg-[var(--editor-control)] px-2 font-medium font-mono text-[10px] text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground";
const SEARCH_TOGGLE_ON =
  "flex h-7 w-9 shrink-0 cursor-pointer items-center justify-center rounded-md border border-accent/40 bg-accent/15 font-medium font-mono text-[10px] text-foreground";
const SEARCH_TOGGLE_OFF =
  "flex h-7 w-9 shrink-0 cursor-pointer items-center justify-center rounded-md border border-hairline bg-[var(--editor-control)] font-medium font-mono text-[10px] text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground";
const SEARCH_CLOSE =
  "ml-auto flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-sm text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive";

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

function editorExtensions(language: "md" | "html", collab: boolean) {
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
    autocompletion(),
    rectangularSelection(),
    crosshairCursor(),
    search({ top: true, createPanel: createStashSearchPanel }),
    highlightActiveLine(),
    highlightSelectionMatches(),
    languageExtension(language),
    editorTheme,
    EditorView.lineWrapping,
    keymap.of(editorKeymap),
    ...(collab ? [] : [history()]),
  ];
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
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

export function DocEditor({
  initialContent,
  language,
  readOnly,
  onChange,
  maxContentBytes,
  onLimit,
  ytext,
  awareness,
}: DocEditorProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onLimitRef = useRef(onLimit);
  const initialContentRef = useRef(initialContent);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onLimitRef.current = onLimit;
  }, [onLimit]);

  useEffect(() => {
    initialContentRef.current = initialContent;
  }, [initialContent]);

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
    const view = new EditorView({
      doc: collab ? (ytext?.toString() ?? "") : initialContentRef.current,
      parent: parentRef.current,
      extensions: [
        ...editorExtensions(language, collab),
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
        ...collabExtensions,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
      ],
    });
    viewRef.current = view;
    return () => {
      viewRef.current = null;
      view.destroy();
      undoManager?.destroy();
    };
  }, [language, maxContentBytes, readOnly, ytext, awareness]);

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

  return <div ref={parentRef} className="h-full overflow-hidden" />;
}
