"use client";

import { Check, CornerDownRight, Loader2, MessageSquare, RotateCcw, X } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
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
  startRel: ArrayBuffer;
  endRel: ArrayBuffer;
  quote: string;
  status: "open" | "resolved";
  authorName: string;
  resolvedByName: string | null;
  resolvedAt: number | null;
  createdAt: number;
  updatedAt: number;
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
  candidates: MentionCandidate[];
  ranges: Map<string, ResolvedCommentRange>;
  activeThreadId: string | null;
  selection: SelectionState | null;
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

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString([], {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  });
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
      {options.length > 0 ? (
        <ul className="absolute top-20 right-2 left-2 z-20 max-h-48 overflow-auto rounded-md border border-hairline bg-surface p-1 shadow-xl">
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
        </ul>
      ) : null}
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
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {formatTime(message.createdAt)}
          </span>
        </div>
        <p className="whitespace-pre-wrap break-words text-muted-foreground text-xs leading-relaxed">
          {message.body}
        </p>
      </div>
    </li>
  );
}

export function CommentsRail({
  threads,
  candidates,
  ranges,
  activeThreadId,
  selection,
  onClose,
  onCreate,
  onReply,
  onResolve,
  onFocusThread,
}: CommentsRailProps) {
  const [busyThreadId, setBusyThreadId] = useState<string | null>(null);
  const hasSelection = Boolean(selection && selection.from < selection.to && selection.text.trim());
  const openCount = threads.filter((thread) => thread.status === "open").length;

  const resolve = async (threadId: string, resolved: boolean) => {
    setBusyThreadId(threadId);
    try {
      await onResolve(threadId, resolved);
    } finally {
      setBusyThreadId(null);
    }
  };

  return (
    <aside className="glass absolute inset-y-0 right-0 left-0 z-50 ml-0 flex w-full max-w-none shrink-0 flex-col overflow-hidden rounded-lg sm:static sm:left-auto sm:ml-3 sm:w-[360px] sm:max-w-[360px]">
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
          type="button"
          onClick={onClose}
          aria-label="Close comments"
          className="flex size-7 cursor-pointer items-center justify-center rounded-xs text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
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
              Select text in the editor to start a thread.
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

        {threads.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-md border border-hairline border-dashed px-6 py-10 text-center">
            <MessageSquare className="mb-2 size-5 text-muted-foreground" aria-hidden="true" />
            <p className="font-medium text-sm">No comments yet</p>
            <p className="mt-1 text-muted-foreground text-xs leading-relaxed">
              Threads anchored to this file will appear here.
            </p>
          </div>
        ) : null}

        {threads.map((thread) => {
          const active = activeThreadId === thread.id;
          const range = ranges.get(thread.id);
          const unavailable = !range;
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
                  <span className="text-[10px] text-muted-foreground">
                    {formatTime(thread.updatedAt)}
                  </span>
                </span>
                <span className="line-clamp-3 rounded-sm bg-foreground/[0.04] px-2 py-1.5 text-[11px] text-muted-foreground leading-relaxed">
                  {thread.quote}
                </span>
                {unavailable ? (
                  <span className="text-[11px] text-warning">Anchor unavailable</span>
                ) : null}
              </button>

              <div className="space-y-3 px-3 py-3">
                <ul className="space-y-3">
                  {thread.messages.map((message) => (
                    <MessageItem key={message.id} message={message} />
                  ))}
                </ul>
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
                      onSubmit={(body, mentionUserIds) => onReply(thread.id, body, mentionUserIds)}
                    />
                  </div>
                </div>
              </div>
            </section>
          );
        })}
      </div>
    </aside>
  );
}
