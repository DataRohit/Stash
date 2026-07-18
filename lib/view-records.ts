import type { ViewFilter } from "./view-model";

export type ViewRecordSummary = {
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

export const VIEW_BUILTIN_PROPERTIES = new Set([
  "title",
  "fileType",
  "updatedAt",
  "boardDue",
  "boardColumn",
]);

export function viewRecordValue(record: ViewRecordSummary, propertyId: string): string {
  if (propertyId === "title") return record.name;
  if (propertyId === "fileType") return record.fileType ?? "Unknown";
  if (propertyId === "updatedAt") return String(record.updatedAt);
  return record.properties.find((value) => value.propertyId === propertyId)?.displayValue ?? "";
}

export function viewRecordMatches(record: ViewRecordSummary, filter: ViewFilter): boolean {
  const value = viewRecordValue(record, filter.propertyId);
  const left = value.toLocaleLowerCase();
  const right = filter.value.trim().toLocaleLowerCase();
  if (filter.operator === "is-empty") return value.length === 0;
  if (filter.operator === "is-not-empty") return value.length > 0;
  if (filter.operator === "contains") return left.includes(right);
  if (filter.operator === "equals") return left === right;
  if (filter.operator === "not-equals") return left !== right;
  const propertyValue = record.properties.find((row) => row.propertyId === filter.propertyId);
  const numeric =
    filter.propertyId === "updatedAt"
      ? record.updatedAt
      : filter.operator === "before"
        ? (propertyValue?.dateEndValue ?? propertyValue?.dateValue ?? Date.parse(value))
        : (propertyValue?.dateValue ?? Date.parse(value));
  const target = Date.parse(filter.value);
  if (!Number.isFinite(numeric) || !Number.isFinite(target)) return false;
  return filter.operator === "before" ? numeric < target : numeric > target;
}

export function applyViewFilters(
  records: ViewRecordSummary[],
  filters: ViewFilter[],
  activeProperties: Set<string>,
): ViewRecordSummary[] {
  return records.filter((record) =>
    filters.every(
      (filter) =>
        (!VIEW_BUILTIN_PROPERTIES.has(filter.propertyId) &&
          !activeProperties.has(filter.propertyId)) ||
        viewRecordMatches(record, filter),
    ),
  );
}

export function aggregateViewRecords(
  records: ViewRecordSummary[],
  options: {
    groupPropertyId?: string | null;
    valuePropertyId?: string | null;
    aggregate?: "count" | "sum";
    groupOptions?: string[];
  },
): Array<[string, number]> {
  const groups = new Map<string, number>();
  for (const record of records) {
    const label = options.groupPropertyId
      ? viewRecordValue(record, options.groupPropertyId) || "None"
      : "All records";
    let amount = 1;
    if (options.aggregate === "sum") {
      if (!options.valuePropertyId) continue;
      amount = Number(viewRecordValue(record, options.valuePropertyId)) || 0;
    }
    groups.set(label, (groups.get(label) ?? 0) + amount);
  }
  for (const option of options.groupOptions ?? []) {
    if (!groups.has(option)) groups.set(option, 0);
  }
  return [...groups.entries()];
}
