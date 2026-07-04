"use client";

import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import {
  bracketMatching,
  defaultHighlightStyle,
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
} from "@codemirror/view";
import { useEffect, useRef } from "react";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import { UndoManager } from "yjs";

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

const editorTheme = EditorView.theme(
  {
    "&": { height: "100%", backgroundColor: "transparent", fontSize: "13px" },
    ".cm-scroller": {
      fontFamily: "var(--font-mono), monospace",
      lineHeight: "1.6",
      padding: "0.5rem 0",
      scrollbarColor:
        "color-mix(in oklab, var(--foreground) 38%, transparent) color-mix(in oklab, var(--surface) 62%, transparent)",
      scrollbarWidth: "thin",
    },
    ".cm-scroller::-webkit-scrollbar": {
      width: "12px",
      height: "12px",
    },
    ".cm-scroller::-webkit-scrollbar-track": {
      backgroundColor: "color-mix(in oklab, var(--surface) 62%, transparent)",
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
    ".cm-content": { caretColor: "var(--foreground)" },
    ".cm-gutters": {
      backgroundColor: "transparent",
      color: "color-mix(in oklab, var(--muted-foreground) 70%, transparent)",
      border: "none",
    },
    ".cm-activeLine": {
      backgroundColor: "color-mix(in oklab, var(--foreground) 4%, transparent)",
    },
    ".cm-activeLineGutter": { backgroundColor: "transparent" },
    ".cm-cursor": { borderLeftColor: "var(--foreground)" },
    "&.cm-focused": { outline: "none" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
      backgroundColor: "color-mix(in oklab, var(--accent) 24%, transparent)",
    },
    ".cm-panels": {
      backgroundColor: "color-mix(in oklab, var(--surface) 96%, transparent)",
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
      backgroundColor: "color-mix(in oklab, var(--warning) 30%, transparent)",
      borderRadius: "2px",
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: "color-mix(in oklab, var(--accent) 42%, transparent)",
    },
    ".cm-selectionMatch": {
      backgroundColor: "color-mix(in oklab, var(--accent) 16%, transparent)",
    },
    ".cm-tooltip": {
      backgroundColor: "var(--surface)",
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
      backgroundColor: "var(--surface)",
      border: "1px solid var(--hairline)",
    },
    ".cm-foldPlaceholder": {
      backgroundColor: "color-mix(in oklab, var(--foreground) 10%, transparent)",
      color: "var(--muted-foreground)",
      border: "1px solid var(--hairline)",
      borderRadius: "4px",
      padding: "0 6px",
    },
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
      backgroundColor: "color-mix(in oklab, var(--accent) 26%, transparent)",
      outline: "1px solid color-mix(in oklab, var(--accent) 45%, transparent)",
    },
  },
  { dark: true },
);

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
});

const SEARCH_INPUT =
  "h-7 w-48 max-w-[45vw] rounded-md border border-hairline bg-surface/60 px-2.5 font-mono text-foreground text-xs outline-none transition-colors placeholder:text-muted-foreground/45 focus:border-accent/50 focus:ring-1 focus:ring-ring";
const SEARCH_ACTION_GROUP = "grid w-[246px] grid-cols-6 gap-1.5";
const SEARCH_REPLACE_GROUP = "grid w-[246px] grid-cols-2 gap-1.5";
const SEARCH_ACTION_BTN =
  "flex h-7 w-9 shrink-0 cursor-pointer items-center justify-center rounded-md border border-hairline bg-foreground/[0.04] font-medium font-mono text-[10px] text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground";
const SEARCH_REPLACE_BTN =
  "flex h-7 w-full shrink-0 cursor-pointer items-center justify-center rounded-md border border-hairline bg-foreground/[0.04] px-2 font-medium font-mono text-[10px] text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground";
const SEARCH_TOGGLE_ON =
  "flex h-7 w-9 shrink-0 cursor-pointer items-center justify-center rounded-md border border-accent/40 bg-accent/15 font-medium font-mono text-[10px] text-foreground";
const SEARCH_TOGGLE_OFF =
  "flex h-7 w-9 shrink-0 cursor-pointer items-center justify-center rounded-md border border-hairline font-medium font-mono text-[10px] text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground";
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
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    rectangularSelection(),
    crosshairCursor(),
    search({ top: true, createPanel: createStashSearchPanel }),
    highlightActiveLine(),
    highlightSelectionMatches(),
    language === "html" ? html() : markdown(),
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
