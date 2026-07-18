"use client";

import { CalendarDays, Clock3, LayoutGrid, TableProperties } from "lucide-react";
import { useMemo } from "react";
import { cn } from "@/lib/utils";
import type { ViewConfig } from "@/lib/view-model";

type ViewPreviewProperty = {
  id: string;
  name: string;
  type: "text" | "number" | "boolean" | "date" | "status" | "person" | "formula" | "rollup";
  deleted?: boolean;
};

export type ViewPreviewRecord = {
  id: string;
  name: string;
  fileType: string | null;
  updatedAt: number;
  properties: Array<{
    propertyId: string;
    displayValue: string;
    dateValue?: number;
    dateEndValue?: number;
  }>;
};

export type ViewPreviewModel = {
  config: ViewConfig;
  properties: ViewPreviewProperty[];
  records: ViewPreviewRecord[];
  truncated?: boolean;
};

function builtinName(id: string): string | null {
  if (id === "title") return "Document";
  if (id === "fileType") return "Type";
  if (id === "updatedAt") return "Updated";
  return null;
}

function display(record: ViewPreviewRecord, propertyId: string): string {
  if (propertyId === "title") return record.name;
  if (propertyId === "fileType") return record.fileType ?? "Unknown";
  if (propertyId === "updatedAt") return new Date(record.updatedAt).toLocaleDateString();
  return record.properties.find((value) => value.propertyId === propertyId)?.displayValue ?? "";
}

function dateValue(
  record: ViewPreviewRecord,
  propertyId: string | null,
): { start: number; end: number; dateOnly: boolean } | null {
  if (propertyId === "updatedAt") {
    return { start: record.updatedAt, end: record.updatedAt, dateOnly: false };
  }
  const row = record.properties.find((value) => value.propertyId === propertyId);
  return row?.dateValue === undefined
    ? null
    : { start: row.dateValue, end: row.dateEndValue ?? row.dateValue, dateOnly: true };
}

export function ViewPreview({ model, className }: { model: ViewPreviewModel; className?: string }) {
  const propertyById = new Map(model.properties.map((property) => [property.id, property]));
  const titleFor = (id: string) => {
    const property = propertyById.get(id);
    return builtinName(id) ?? (property && !property.deleted ? property.name : "Removed field");
  };
  const groups = useMemo(() => {
    const result = new Map<string, ViewPreviewRecord[]>();
    const propertyId = model.config.groupBy ?? "fileType";
    for (const record of model.records) {
      const key = display(record, propertyId) || "Unassigned";
      result.set(key, [...(result.get(key) ?? []), record]);
    }
    return result;
  }, [model]);
  const dated = model.records
    .map((record) => ({ record, date: dateValue(record, model.config.datePropertyId) }))
    .filter(
      (
        row,
      ): row is {
        record: ViewPreviewRecord;
        date: { start: number; end: number; dateOnly: boolean };
      } => row.date !== null,
    )
    .sort((left, right) => left.date.start - right.date.start);
  const unscheduled = model.records.length - dated.length;

  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-background", className)}>
      <div className="flex h-11 shrink-0 items-center justify-between border-hairline border-b px-3">
        <span className="flex items-center gap-2 font-medium text-sm capitalize">
          {model.config.layout === "table" ? (
            <TableProperties className="size-4 text-accent" />
          ) : model.config.layout === "board" ? (
            <LayoutGrid className="size-4 text-accent" />
          ) : model.config.layout === "calendar" ? (
            <CalendarDays className="size-4 text-accent" />
          ) : (
            <Clock3 className="size-4 text-accent" />
          )}
          {model.config.layout} view
        </span>
        <span className="text-muted-foreground text-xs">
          {model.config.filters.length} filter{model.config.filters.length === 1 ? "" : "s"} ·{" "}
          {model.config.sorts.length} sort{model.config.sorts.length === 1 ? "" : "s"} ·{" "}
          {model.records.length} record{model.records.length === 1 ? "" : "s"}
          {model.truncated ? " shown · more available" : ""}
        </span>
      </div>
      <div className="thin-scrollbar min-h-0 flex-1 overflow-auto">
        {model.records.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
            No matching records
          </div>
        ) : model.config.layout === "table" ? (
          <table className="min-w-full border-separate border-spacing-0">
            <thead className="sticky top-0 bg-surface">
              <tr>
                {model.config.visibleColumns.map((id) => (
                  <th
                    key={id}
                    className="min-w-40 border-hairline border-b px-3 py-2 text-left font-medium text-muted-foreground text-xs"
                  >
                    {titleFor(id)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {model.records.map((record) => (
                <tr key={record.id}>
                  {model.config.visibleColumns.map((id) => (
                    <td key={id} className="h-11 border-hairline border-b px-3 py-2 text-sm">
                      {display(record, id) || "—"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : model.config.layout === "board" ? (
          <div className="flex min-h-full items-start gap-3 p-3">
            {[...groups].map(([group, records]) => (
              <section
                key={group}
                className="w-72 shrink-0 rounded-lg border border-hairline bg-surface/60 p-2"
              >
                <h3 className="flex items-center justify-between px-1 py-1 font-medium text-sm">
                  <span className="truncate">{group}</span>
                  <span className="rounded-full bg-foreground/[0.07] px-2 py-0.5 text-[10px]">
                    {records.length}
                  </span>
                </h3>
                <div className="space-y-2 pt-2">
                  {records.map((record) => (
                    <article
                      key={record.id}
                      className="rounded-md border border-hairline bg-background p-3"
                    >
                      <p className="truncate font-medium text-sm">{record.name}</p>
                      <p className="mt-1 text-[10px] text-muted-foreground uppercase">
                        {record.fileType ?? "unknown"}
                      </p>
                    </article>
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : model.config.layout === "timeline" ? (
          <div className="space-y-2 p-3">
            {dated.map(({ record, date }) => (
              <div
                key={record.id}
                className="grid grid-cols-[9rem_1fr] items-center gap-3 rounded-md border border-hairline bg-surface/50 p-3"
              >
                <time className="text-muted-foreground text-xs">
                  {new Intl.DateTimeFormat(undefined, {
                    dateStyle: "medium",
                    ...(date.dateOnly ? { timeZone: "UTC" } : {}),
                  }).format(date.start)}
                  {date.end !== date.start
                    ? ` – ${new Intl.DateTimeFormat(undefined, {
                        dateStyle: "medium",
                        ...(date.dateOnly ? { timeZone: "UTC" } : {}),
                      }).format(date.end)}`
                    : ""}
                </time>
                <span className="truncate font-medium text-sm">{record.name}</span>
              </div>
            ))}
            {unscheduled > 0 ? (
              <div className="rounded-md border border-hairline border-dashed p-3 text-muted-foreground text-xs">
                {unscheduled} unscheduled record{unscheduled === 1 ? "" : "s"}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="min-w-[42rem] p-3">
            {(() => {
              const anchor = dated[0]?.date;
              const anchorDate = anchor ? new Date(anchor.start) : new Date();
              const year = anchor?.dateOnly
                ? anchorDate.getUTCFullYear()
                : anchorDate.getFullYear();
              const month = anchor?.dateOnly ? anchorDate.getUTCMonth() : anchorDate.getMonth();
              const first = new Date(year, month, 1);
              const days = Array.from(
                { length: 42 },
                (_, index) => new Date(year, month, index - first.getDay() + 1),
              );
              return (
                <>
                  <h3 className="mb-3 font-medium text-sm">
                    {new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(
                      first,
                    )}
                  </h3>
                  <div className="grid grid-cols-7 border-hairline border-t border-l">
                    {days.map((day) => {
                      const local = new Date(
                        day.getFullYear(),
                        day.getMonth(),
                        day.getDate(),
                      ).valueOf();
                      const utc = Date.UTC(day.getFullYear(), day.getMonth(), day.getDate());
                      const records = dated.filter(({ date }) => {
                        const point = date.dateOnly ? utc : local;
                        return date.start <= point && date.end >= point;
                      });
                      const inMonth = day.getMonth() === month;
                      return (
                        <div
                          key={day.toISOString()}
                          className={cn(
                            "min-h-24 border-hairline border-r border-b p-1.5",
                            !inMonth && "bg-foreground/2 text-muted-foreground",
                          )}
                        >
                          <span
                            className={cn(
                              "text-xs",
                              inMonth && day.getDay() === 0 && "text-destructive",
                              inMonth && day.getDay() === 6 && "text-warning",
                            )}
                          >
                            {day.getDate()}
                          </span>
                          <div className="mt-1 space-y-1">
                            {records.slice(0, 3).map(({ record }) => (
                              <span
                                key={record.id}
                                className="block truncate rounded-sm bg-accent/10 px-1.5 py-1 text-[10px]"
                              >
                                {record.name}
                              </span>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {unscheduled > 0 ? (
                    <p className="mt-3 text-muted-foreground text-xs">
                      {unscheduled} unscheduled record{unscheduled === 1 ? "" : "s"}
                    </p>
                  ) : null}
                </>
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
}
