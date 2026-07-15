import { CalendarDays, Link2, UserRound } from "lucide-react";
import type { BoardRenderModel } from "@/lib/doc-projection";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const PRIORITY_CLASS = {
  low: "border-info/35 bg-info/10 text-info",
  medium: "border-warning/35 bg-warning/10 text-warning",
  high: "border-orange-500/35 bg-orange-500/10 text-orange-500",
  critical: "border-destructive/35 bg-destructive/10 text-destructive",
} as const;

export function BoardView({
  model,
  className = "",
}: {
  model: BoardRenderModel;
  className?: string;
}) {
  return (
    <div className={`overflow-auto ${className}`}>
      <div className="flex min-h-full w-max min-w-full items-start gap-3 p-3">
        {model.columns.map((column) => (
          <section
            key={column.id}
            className="w-72 shrink-0 rounded-lg border border-hairline bg-surface/70 p-2"
          >
            <header className="flex items-center justify-between gap-2 px-1 py-1.5">
              <div className="flex min-w-0 items-center gap-2">
                <span
                  aria-hidden="true"
                  className="size-4 shrink-0 rounded-sm"
                  style={{ backgroundColor: column.color }}
                />
                <h2 className="truncate font-medium text-sm">{column.name}</h2>
              </div>
              <span className="rounded-full bg-foreground/[0.06] px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                {column.cards.length}
              </span>
            </header>
            <div className="mt-1 flex flex-col gap-2">
              {column.cards.map((card) => (
                <article
                  key={card.id}
                  className="rounded-md border border-hairline border-l-4 p-3"
                  style={{ borderLeftColor: card.color, backgroundColor: `${card.color}0d` }}
                >
                  {card.priority ? (
                    <span
                      className={cn(
                        "mb-2 inline-flex rounded-full border px-2 py-0.5 font-medium text-[10px] uppercase",
                        PRIORITY_CLASS[card.priority],
                      )}
                    >
                      {card.priority}
                    </span>
                  ) : null}
                  {card.labels.length > 0 ? (
                    <div className="mb-2 flex flex-wrap gap-1">
                      {card.labels.map((label) => (
                        <span
                          key={label.id}
                          className="rounded-full px-2 py-0.5 text-[10px]"
                          style={{ backgroundColor: `${label.color}22`, color: label.color }}
                        >
                          {label.name}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <h3 className="break-words font-medium text-sm">{card.title}</h3>
                  {card.description ? (
                    <p className="mt-2 line-clamp-6 whitespace-pre-wrap text-muted-foreground text-xs">
                      {card.description}
                    </p>
                  ) : null}
                  {card.due || card.assignees.length > 0 || card.linkedDocId ? (
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                      {card.due ? (
                        <span className="inline-flex items-center gap-1">
                          <CalendarDays className="size-3" aria-hidden="true" />
                          <time dateTime={new Date(card.due).toISOString()}>
                            {formatDateTime(card.due)}
                          </time>
                        </span>
                      ) : null}
                      {card.assignees.length > 0 ? (
                        <span className="inline-flex items-center gap-1">
                          <UserRound className="size-3" aria-hidden="true" />
                          {card.assignees.length}
                        </span>
                      ) : null}
                      {card.linkedDocId ? (
                        <span className="inline-flex items-center gap-1">
                          <Link2 className="size-3" aria-hidden="true" />
                          {card.linkedDocRemoved ? "Removed document" : "Linked document"}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </article>
              ))}
              {column.cards.length === 0 ? (
                <p className="rounded-md border border-hairline border-dashed px-3 py-6 text-center text-muted-foreground text-xs">
                  No cards
                </p>
              ) : null}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
