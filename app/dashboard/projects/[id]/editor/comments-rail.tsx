"use client";

import { useQuery } from "convex/react";
import { Check, CornerDownRight, Loader2, MessageSquare, RotateCcw, X } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DataLoader, DataState } from "@/components/ui/data-state";
import { useAnchoredPosition } from "@/components/ui/floating";
import { useDialogA11y } from "@/components/ui/use-dialog-a11y";
import { useMediaQuery } from "@/components/ui/use-media-query";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export type MentionCandidate = {
  userId: string;
  name: string;
  email: string;
  imageUrl: string | null;
};

export type CommentMessage = {
  id: string;
  body: string;
  mentionUserIds: string[];
  authorUserId: string;
  authorName: string;
  authorEmail: string | null;
  authorImage: string | null;
  createdAt: number;
};

export type CommentThread = {
  id: string;
  anchor:
    | { kind: "text"; startRel: ArrayBuffer; endRel: ArrayBuffer }
    | { kind: "cell"; rowId: string; colId: string }
    | { kind: "card"; cardId: string }
    | { kind: "document" };
  orphaned: boolean;
  quote: string;
  status: "open" | "resolved";
  authorName: string;
  resolvedByName: string | null;
  resolvedAt: number | null;
  createdAt: number;
  updatedAt: number;
  hasMoreMessages: boolean;
  messages: CommentMessage[];
};

export type ResolvedCommentRange = {
  id: string;
  from: number;
  to: number;
  status: "open" | "resolved";
};

type SelectionState = {
  from: number;
  to: number;
  text: string;
};

type CommentsRailProps = {
  threads: CommentThread[];
  loading: boolean;
  candidates: MentionCandidate[];
  ranges: Map<string, ResolvedCommentRange>;
  activeThreadId: string | null;
  selection: SelectionState | null;
  selectionKind?: "text" | "cell" | "card" | "document";
  onClose: () => void;
  onCreate: (body: string, mentionUserIds: string[]) => Promise<void>;
  onReply: (threadId: string, body: string, mentionUserIds: string[]) => Promise<void>;
  onResolve: (threadId: string, resolved: boolean) => Promise<void>;
  onFocusThread: (threadId: string) => void;
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return `${parts[0]?.[0] ?? "?"}${parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : ""}`.toUpperCase();
}

function mentionToken(value: string, cursor: number) {
  const before = value.slice(0, cursor);
  const match = /(^|\s)@([A-Za-z0-9._-]*)$/.exec(before);
  if (!match) {
    return null;
  }
  const prefix = match[1] ?? "";
  const query = match[2] ?? "";
  return { from: before.length - query.length - 1, to: before.length, prefix, query };
}

function Composer({
  placeholder,
  submitLabel,
  candidates,
  disabled,
  onSubmit,
}: {
  placeholder: string;
  submitLabel: string;
  candidates: MentionCandidate[];
  disabled?: boolean;
  onSubmit: (body: string, mentionUserIds: string[]) => Promise<void>;
}) {
  const [body, setBody] = useState("");
  const [mentions, setMentions] = useState<MentionCandidate[]>([]);
  const [cursor, setCursor] = useState(0);
  const [pending, setPending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const floatingRef = useRef<HTMLUListElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const token = mentionToken(body, cursor);

  useEffect(() => {
    if (pendingCaret.current === null || !textareaRef.current) {
      return;
    }
    const position = pendingCaret.current;
    pendingCaret.current = null;
    textareaRef.current.focus();
    textareaRef.current.setSelectionRange(position, position);
    setCursor(position);
  }, [body]);
  const options = useMemo(() => {
    if (!token) {
      return [];
    }
    const query = token.query.toLowerCase();
    return candidates
      .filter(
        (candidate) =>
          candidate.name.toLowerCase().includes(query) ||
          candidate.email.toLowerCase().includes(query),
      )
      .slice(0, 6);
  }, [candidates, token]);
  const position = useAnchoredPosition({
    open: options.length > 0,
    anchorRef: textareaRef,
    floatingRef,
    estimatedHeight: 192,
  });

  const addMention = (candidate: MentionCandidate) => {
    if (!token) {
      return;
    }
    const next = `${body.slice(0, token.from)}@${candidate.name} ${body.slice(token.to)}`;
    const nextCursor = token.from + candidate.name.length + 2;
    setBody(next);
    setCursor(nextCursor);
    pendingCaret.current = nextCursor;
    setMentions((value) =>
      value.some((mention) => mention.userId === candidate.userId) ? value : [...value, candidate],
    );
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = body.trim();
    if (!text || pending || disabled) {
      return;
    }
    setPending(true);
    try {
      await onSubmit(
        text,
        mentions
          .filter((mention) => body.includes(`@${mention.name}`))
          .map((mention) => mention.userId),
      );
      setBody("");
      setMentions([]);
      setCursor(0);
    } catch {
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={submit} className="relative flex flex-col gap-2">
      <textarea
        ref={textareaRef}
        value={body}
        disabled={disabled || pending}
        onChange={(event) => {
          setBody(event.target.value);
          setCursor(event.target.selectionStart);
        }}
        onKeyUp={(event) => setCursor(event.currentTarget.selectionStart)}
        onClick={(event) => setCursor(event.currentTarget.selectionStart)}
        placeholder={placeholder}
        aria-label={placeholder}
        aria-disabled={disabled || pending}
        className="min-h-20 resize-none rounded-md border border-hairline bg-[var(--editor-control)] px-3 py-2 text-foreground text-xs outline-none transition-colors placeholder:text-muted-foreground/45 focus:border-accent/50 focus:ring-1 focus:ring-ring disabled:opacity-60"
      />
      {options.length > 0 && typeof document !== "undefined"
        ? createPortal(
            <ul
              ref={floatingRef}
              className="fixed z-[180] max-h-48 overflow-auto rounded-md border border-hairline bg-surface p-1 shadow-xl"
              style={position}
            >
              {options.map((candidate) => (
                <li key={candidate.userId}>
                  <button
                    type="button"
                    onClick={() => addMention(candidate)}
                    className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-foreground/[0.06]"
                  >
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground/10 font-medium font-mono text-[10px] text-muted-foreground">
                      {initials(candidate.name)}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-xs">{candidate.name}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {candidate.email}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>,
            document.body,
          )
        : null}
      <button
        type="submit"
        disabled={disabled || pending || body.trim().length === 0}
        className="inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-sm bg-foreground px-3 font-medium text-background text-xs transition-colors hover:bg-foreground/90 disabled:cursor-not-allowed disabled:bg-foreground/12 disabled:text-muted-foreground"
      >
        {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
        {submitLabel}
      </button>
    </form>
  );
}

function MessageItem({ message }: { message: CommentMessage }) {
  return (
    <li className="flex gap-2">
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground/10 font-medium font-mono text-[10px] text-muted-foreground">
        {initials(message.authorName)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="truncate font-medium text-xs">{message.authorName}</span>
          <time
            dateTime={new Date(message.createdAt).toISOString()}
            title={formatDateTime(message.createdAt)}
            className="shrink-0 text-[10px] text-muted-foreground"
          >
            {formatRelativeTime(message.createdAt)}
          </time>
        </div>
        <p className="whitespace-pre-wrap break-words text-muted-foreground text-xs leading-relaxed">
          {message.body}
        </p>
      </div>
    </li>
  );
}

function ThreadMessages({ thread }: { thread: CommentThread }) {
  const [loadOlder, setLoadOlder] = useState(false);
  const loaded = useQuery(
    api.comments.listThreadMessages,
    loadOlder ? { commentId: thread.id as Id<"comments"> } : "skip",
  );
  const messages = loaded?.messages ?? thread.messages;
  return (
    <>
      <ul className="space-y-3">
        {messages.map((message) => (
          <MessageItem key={message.id} message={message} />
        ))}
      </ul>
      {thread.hasMoreMessages && !loadOlder ? (
        <button
          type="button"
          onClick={() => setLoadOlder(true)}
          className="w-full cursor-pointer rounded-sm bg-foreground/[0.04] px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-foreground/[0.08] hover:text-foreground"
        >
          Load older replies
        </button>
      ) : null}
      {loadOlder && loaded === undefined ? (
        <DataLoader label="Loading older replies" compact />
      ) : null}
      {loaded?.hasMore ? (
        <p className="text-[11px] text-muted-foreground">Showing the 200 most recent replies.</p>
      ) : null}
    </>
  );
}

export function CommentsRail({
  threads,
  loading,
  candidates,
  ranges,
  activeThreadId,
  selection,
  selectionKind = "text",
  onClose,
  onCreate,
  onReply,
  onResolve,
  onFocusThread,
}: CommentsRailProps) {
  const [busyThreadId, setBusyThreadId] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const mobile = useMediaQuery("(max-width: 639px)");
  const hasSelection = Boolean(selection && selection.from < selection.to && selection.text.trim());
  const openCount = threads.filter((thread) => thread.status === "open").length;

  useDialogA11y({
    open: mobile,
    onClose,
    containerRef: panelRef,
    initialFocusRef: closeRef,
  });

  const resolve = async (threadId: string, resolved: boolean) => {
    setBusyThreadId(threadId);
    try {
      await onResolve(threadId, resolved);
    } finally {
      setBusyThreadId(null);
    }
  };

  return (
    <>
      <button
        type="button"
        aria-label="Close comments overlay"
        onClick={onClose}
        className="fixed inset-0 z-[94] cursor-default bg-black/45 sm:hidden"
      />
      <aside
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal={mobile}
        aria-label="Comments"
        className="glass fixed right-0 bottom-0 left-0 z-[95] flex h-[min(82dvh,760px)] w-full max-w-none shrink-0 flex-col overflow-hidden rounded-t-lg sm:static sm:ml-3 sm:h-auto sm:w-[360px] sm:max-w-[360px] sm:rounded-lg"
      >
        <div className="flex h-5 shrink-0 items-center justify-center sm:hidden" aria-hidden="true">
          <span className="h-1 w-10 rounded-full bg-foreground/20" />
        </div>
        <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-hairline border-b pr-2 pl-3">
          <div className="flex min-w-0 items-center gap-2">
            <MessageSquare className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="font-medium font-mono text-muted-foreground text-xs uppercase tracking-widest">
              Comments
            </span>
            <span className="rounded-full bg-foreground/[0.08] px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {openCount}
            </span>
            <span className="sr-only">{openCount} open comments</span>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close comments"
            className="flex size-9 cursor-pointer items-center justify-center rounded-xs text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive sm:size-7"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        <div className="thin-scrollbar min-h-0 flex-1 space-y-3 overflow-auto p-3">
          <section className="rounded-md border border-hairline bg-foreground/[0.025] p-3">
            <p className="mb-2 font-medium text-xs">New thread</p>
            {hasSelection ? (
              <p className="mb-2 line-clamp-3 rounded-sm bg-accent/10 px-2 py-1.5 text-[11px] text-muted-foreground leading-relaxed">
                {selection?.text}
              </p>
            ) : (
              <p className="mb-2 rounded-sm bg-foreground/[0.04] px-2 py-1.5 text-[11px] text-muted-foreground leading-relaxed">
                {selectionKind === "cell"
                  ? "Select a cell to start a thread."
                  : selectionKind === "card"
                    ? "Select a card to start a thread."
                    : selectionKind === "document"
                      ? "Start a thread about this team view."
                      : "Select text in the editor to start a thread."}
              </p>
            )}
            <Composer
              placeholder="Write a comment. Type @ to mention someone."
              submitLabel="Comment"
              candidates={candidates}
              disabled={!hasSelection}
              onSubmit={onCreate}
            />
          </section>

          {loading ? (
            <DataLoader label="Loading comments" compact />
          ) : threads.length === 0 ? (
            <DataState
              title="No comments yet"
              description="Threads anchored to this file will appear here."
              icon={<MessageSquare className="size-5" aria-hidden="true" />}
            />
          ) : null}

          {loading
            ? null
            : threads.map((thread) => {
                const active = activeThreadId === thread.id;
                const range = ranges.get(thread.id);
                const unavailable = thread.anchor.kind === "text" ? !range : thread.orphaned;
                return (
                  <section
                    key={thread.id}
                    className={cn(
                      "rounded-md border bg-foreground/[0.025] transition-colors",
                      active ? "border-accent/45" : "border-hairline",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => onFocusThread(thread.id)}
                      className="flex w-full cursor-pointer flex-col gap-2 px-3 pt-3 text-left"
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span
                          className={cn(
                            "rounded-full px-1.5 py-0.5 font-medium font-mono text-[10px] uppercase tracking-widest",
                            thread.status === "open"
                              ? "bg-accent/10 text-accent"
                              : "bg-foreground/[0.08] text-muted-foreground",
                          )}
                        >
                          {thread.status}
                        </span>
                        <time
                          dateTime={new Date(thread.updatedAt).toISOString()}
                          title={formatDateTime(thread.updatedAt)}
                          className="text-[10px] text-muted-foreground"
                        >
                          {formatRelativeTime(thread.updatedAt)}
                        </time>
                      </span>
                      <span className="line-clamp-3 rounded-sm bg-foreground/[0.04] px-2 py-1.5 text-[11px] text-muted-foreground leading-relaxed">
                        {thread.quote}
                      </span>
                      {unavailable ? (
                        <span className="text-[11px] text-warning">
                          {thread.anchor.kind === "cell" || thread.anchor.kind === "card"
                            ? "Location removed"
                            : "Anchor unavailable"}
                        </span>
                      ) : null}
                    </button>

                    <div className="space-y-3 px-3 py-3">
                      <ThreadMessages thread={thread} />
                      <div className="flex items-center gap-2 border-hairline border-t pt-3">
                        <button
                          type="button"
                          onClick={() => resolve(thread.id, thread.status === "open")}
                          disabled={busyThreadId === thread.id}
                          className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-xs border border-hairline px-2.5 font-medium text-muted-foreground text-xs transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {busyThreadId === thread.id ? (
                            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                          ) : thread.status === "open" ? (
                            <Check className="size-3.5" aria-hidden="true" />
                          ) : (
                            <RotateCcw className="size-3.5" aria-hidden="true" />
                          )}
                          {thread.status === "open" ? "Resolve" : "Reopen"}
                        </button>
                        {thread.resolvedByName && thread.resolvedAt ? (
                          <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                            by {thread.resolvedByName}
                          </span>
                        ) : null}
                      </div>
                      <div className="flex gap-2">
                        <CornerDownRight
                          className="mt-2 size-4 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                        <div className="min-w-0 flex-1">
                          <Composer
                            placeholder="Reply or mention someone."
                            submitLabel="Reply"
                            candidates={candidates}
                            onSubmit={(body, mentionUserIds) =>
                              onReply(thread.id, body, mentionUserIds)
                            }
                          />
                        </div>
                      </div>
                    </div>
                  </section>
                );
              })}
        </div>
      </aside>
    </>
  );
}
