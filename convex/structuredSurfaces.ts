import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import * as Y from "yjs";
import { inspectBoard } from "../lib/board-model";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { accessForProject, documentState, isInactiveTree, requireProjectEditor } from "./documents";

const MAX_PROPERTIES = 64;
const MAX_PROPERTY_ROWS = 256;
const MAX_PROPERTY_NAME = 60;
const MAX_PROPERTY_OPTIONS = 50;
const MAX_OPTION_NAME = 60;
const MAX_TEXT_VALUE = 2000;
const MAX_LINKS_PER_SOURCE = 200;

const propertyTypeValidator = v.union(
  v.literal("text"),
  v.literal("number"),
  v.literal("boolean"),
  v.literal("date"),
  v.literal("status"),
  v.literal("person"),
  v.literal("formula"),
  v.literal("rollup"),
);

const optionValidator = v.object({ id: v.string(), name: v.string(), color: v.string() });

const propertyValueValidator = v.union(
  v.object({ type: v.literal("text"), value: v.string() }),
  v.object({ type: v.literal("number"), value: v.number() }),
  v.object({ type: v.literal("boolean"), value: v.boolean() }),
  v.object({
    type: v.literal("date"),
    value: v.number(),
    endValue: v.optional(v.number()),
  }),
  v.object({ type: v.literal("status"), optionId: v.string() }),
  v.object({ type: v.literal("person"), userId: v.string() }),
);

function cleanName(value: string): string {
  const name = value.trim().slice(0, MAX_PROPERTY_NAME).trim();
  if (!name) throw new Error("invalid-property");
  return name;
}

function cleanOptions(options: Array<{ id: string; name: string; color: string }>) {
  if (options.length > MAX_PROPERTY_OPTIONS) throw new Error("too-many-options");
  const ids = new Set<string>();
  return options.map((option) => {
    const id = option.id.trim();
    const name = option.name.trim().slice(0, MAX_OPTION_NAME).trim();
    const color = option.color.toLowerCase();
    if (!id || id.length > 128 || ids.has(id) || !name || !/^#[0-9a-f]{6}$/.test(color)) {
      throw new Error("invalid-property");
    }
    ids.add(id);
    return { id, name, color };
  });
}

async function acceptedMember(ctx: QueryCtx, clerkOrgId: string, userId: string) {
  const member = await ctx.db
    .query("members")
    .withIndex("by_org_user", (q) => q.eq("clerkOrgId", clerkOrgId).eq("memberUserId", userId))
    .first();
  return member?.status === "accepted" ? member : null;
}

function memberName(member: Doc<"members">): string {
  return [member.firstName, member.lastName].filter(Boolean).join(" ") || member.email;
}

type RecordProperty = {
  propertyId: Id<"documentProperties">;
  type: Doc<"documentPropertyValues">["type"];
  displayValue: string;
  textValue?: string;
  numberValue?: number;
  booleanValue?: boolean;
  dateValue?: number;
  dateEndValue?: number;
  statusOptionId?: string;
  personUserId?: string;
  computed?: boolean;
  error?: string;
  includesRestricted?: boolean;
  truncated?: boolean;
};

function numericExpression(source: string): number | null {
  const tokens = source.match(/\d+(?:\.\d+)?|[()+\-*/]/g);
  if (!tokens || tokens.join("") !== source.replace(/\s/g, "")) return null;
  let index = 0;
  const primary = (): number => {
    const token = tokens[index++];
    if (token === "(") {
      const value = add();
      if (tokens[index++] !== ")") throw new Error("formula");
      return value;
    }
    if (token === "-") return -primary();
    const value = Number(token);
    if (!Number.isFinite(value)) throw new Error("formula");
    return value;
  };
  const multiply = (): number => {
    let value = primary();
    while (tokens[index] === "*" || tokens[index] === "/") {
      const operator = tokens[index++];
      const right = primary();
      value = operator === "*" ? value * right : value / right;
    }
    return value;
  };
  const add = (): number => {
    let value = multiply();
    while (tokens[index] === "+" || tokens[index] === "-") {
      const operator = tokens[index++];
      const right = multiply();
      value = operator === "+" ? value + right : value - right;
    }
    return value;
  };
  try {
    const value = add();
    return index === tokens.length && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function formulaValue(
  expression: string,
  values: Map<string, RecordProperty>,
): RecordProperty["displayValue"] | null {
  const reference = (id: string) => values.get(id)?.displayValue ?? "";
  const join = /^JOIN\(([^,]*),(.+)\)$/i.exec(expression.trim());
  if (join) {
    const separator = (join[1] ?? "").trim().replace(/^['"]|['"]$/g, "");
    return [...(join[2] ?? "").matchAll(/\{([A-Za-z0-9_-]+)\}/g)]
      .map((match) => reference(match[1] ?? ""))
      .filter(Boolean)
      .join(separator);
  }
  const dateDiff = /^DATEDIFF\(\{([^}]+)\},\{([^}]+)\}\)$/i.exec(expression.trim());
  if (dateDiff) {
    const left = values.get(dateDiff[1] ?? "")?.dateValue;
    const right = values.get(dateDiff[2] ?? "")?.dateValue;
    return left === undefined || right === undefined
      ? ""
      : String(Math.round((left - right) / 86_400_000));
  }
  const condition = /^IF\(\{([^}]+)\},([^,]*),(.*)\)$/i.exec(expression.trim());
  if (condition) {
    const value = values.get(condition[1] ?? "");
    const truthy = Boolean(value?.booleanValue ?? value?.displayValue);
    return (truthy ? condition[2] : condition[3])?.trim().replace(/^['"]|['"]$/g, "") ?? "";
  }
  const numeric = expression.replace(/\{([A-Za-z0-9_-]+)\}/g, (_match, id: string) => {
    const value = values.get(id)?.numberValue;
    return value === undefined ? "NaN" : String(value);
  });
  const result = numericExpression(numeric);
  return result === null ? null : String(result);
}

const ROLLUP_LINKS_PER_RECORD = 100;
const ROLLUP_TRAVERSAL_BUDGET = 2_000;

type ComputedContext = {
  definitions: Doc<"documentProperties">[];
  definitionById: Map<string, Doc<"documentProperties">>;
  documents: Map<string, Doc<"documents"> | null>;
  access: Map<string, boolean>;
  budget: { remaining: number };
};

function orderComputedDefinitions(
  definitions: Doc<"documentProperties">[],
): Doc<"documentProperties">[] {
  const byId = new Map(definitions.map((definition) => [String(definition._id), definition]));
  const ordered: Doc<"documentProperties">[] = [];
  const placed = new Set<string>();
  const visiting = new Set<string>();
  const visit = (definition: Doc<"documentProperties">): void => {
    const id = String(definition._id);
    if (placed.has(id) || visiting.has(id)) return;
    visiting.add(id);
    if (definition.type === "formula") {
      for (const match of (definition.expression ?? "").matchAll(/\{([A-Za-z0-9_-]+)\}/g)) {
        const dependency = byId.get(match[1] ?? "");
        if (dependency && dependency.type === "formula") visit(dependency);
      }
    }
    visiting.delete(id);
    placed.add(id);
    ordered.push(definition);
  };
  for (const definition of definitions) visit(definition);
  return ordered;
}

async function computedContext(ctx: QueryCtx, projectId: Id<"projects">): Promise<ComputedContext> {
  const definitions = await ctx.db
    .query("documentProperties")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .collect();
  return {
    definitions: orderComputedDefinitions(definitions.filter((item) => !item.deletedAt)),
    definitionById: new Map(definitions.map((definition) => [String(definition._id), definition])),
    documents: new Map(),
    access: new Map(),
    budget: { remaining: ROLLUP_TRAVERSAL_BUDGET },
  };
}

async function cachedDocument(
  ctx: QueryCtx,
  context: ComputedContext,
  documentId: Id<"documents">,
): Promise<Doc<"documents"> | null> {
  const key = String(documentId);
  const cached = context.documents.get(key);
  if (cached !== undefined) return cached;
  const document = await ctx.db.get(documentId);
  context.documents.set(key, document);
  return document;
}

async function cachedAccess(
  ctx: QueryCtx,
  context: ComputedContext,
  projectId: Id<"projects">,
): Promise<boolean> {
  const key = String(projectId);
  const cached = context.access.get(key);
  if (cached !== undefined) return cached;
  const allowed = Boolean(await accessForProject(ctx, projectId));
  context.access.set(key, allowed);
  return allowed;
}

async function computedProperties(
  ctx: QueryCtx,
  document: Doc<"documents">,
  base: RecordProperty[],
  context: ComputedContext,
): Promise<RecordProperty[]> {
  const { definitions, definitionById } = context;
  const values = new Map(base.map((value) => [String(value.propertyId), value]));
  const result: RecordProperty[] = [];
  for (const definition of definitions) {
    if (definition.type === "formula") {
      const referenced = [...(definition.expression ?? "").matchAll(/\{([A-Za-z0-9_-]+)\}/g)].map(
        (match) => match[1] ?? "",
      );
      const removedReference = referenced.some((id) => {
        const target = definitionById.get(id);
        return !target || Boolean(target.deletedAt);
      });
      const displayValue = removedReference
        ? null
        : formulaValue(definition.expression ?? "", values);
      const computed: RecordProperty = {
        propertyId: definition._id,
        type: "formula",
        displayValue: displayValue ?? "#ERROR",
        computed: true,
        error:
          displayValue === null
            ? removedReference
              ? "A referenced property was removed."
              : "A referenced property is missing or invalid."
            : undefined,
      };
      values.set(String(definition._id), computed);
      result.push(computed);
    } else if (definition.type === "rollup") {
      const outgoing = await ctx.db
        .query("documentLinks")
        .withIndex("by_source_document", (q) => q.eq("sourceDocumentId", document._id))
        .take(ROLLUP_LINKS_PER_RECORD + 1);
      const incoming = await ctx.db
        .query("documentLinks")
        .withIndex("by_target_document", (q) => q.eq("targetDocumentId", document._id))
        .take(ROLLUP_LINKS_PER_RECORD + 1);
      const links = [...outgoing, ...incoming].slice(0, ROLLUP_LINKS_PER_RECORD);
      const targets = links.map((link) =>
        link.sourceDocumentId === document._id ? link.targetDocumentId : link.sourceDocumentId,
      );
      const operation = definition.rollup?.operation ?? "count";
      let restricted = false;
      let truncated = false;
      const numbers: number[] = [];
      const dates: number[] = [];
      for (const targetId of targets) {
        if (context.budget.remaining <= 0) {
          truncated = true;
          break;
        }
        context.budget.remaining -= 1;
        const target = await cachedDocument(ctx, context, targetId);
        if (!target || !(await cachedAccess(ctx, context, target.projectId))) {
          restricted = true;
          continue;
        }
        const rollupPropertyId = definition.rollup?.propertyId;
        if (operation !== "count" && rollupPropertyId) {
          const row = await ctx.db
            .query("documentPropertyValues")
            .withIndex("by_document_property", (q) =>
              q.eq("documentId", targetId).eq("propertyId", rollupPropertyId),
            )
            .unique();
          if (row?.numberValue !== undefined) numbers.push(row.numberValue);
          if (row?.dateValue !== undefined) dates.push(row.dateValue);
        }
      }
      const displayValue =
        operation === "count"
          ? String(targets.length)
          : operation === "sum"
            ? String(numbers.reduce((sum, value) => sum + value, 0))
            : dates.length > 0
              ? new Date(Math.max(...dates)).toISOString().slice(0, 10)
              : "";
      const computed: RecordProperty = {
        propertyId: definition._id,
        type: "rollup",
        displayValue,
        computed: true,
        includesRestricted: restricted,
        truncated: truncated || undefined,
      };
      values.set(String(definition._id), computed);
      result.push(computed);
    }
  }
  return result;
}

export const listProperties = query({
  args: { projectId: v.id("projects"), includeDeleted: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    if (!(await accessForProject(ctx, args.projectId))) return [];
    const rows = await ctx.db
      .query("documentProperties")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    return rows
      .filter((row) => args.includeDeleted || !row.deletedAt)
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((row) => ({
        id: row._id,
        name: row.name,
        type: row.type,
        options: row.options,
        expression: row.expression,
        rollup: row.rollup,
        deleted: Boolean(row.deletedAt),
      }));
  },
});

export const createProperty = mutation({
  args: {
    projectId: v.id("projects"),
    name: v.string(),
    type: propertyTypeValidator,
    options: v.optional(v.array(optionValidator)),
    expression: v.optional(v.string()),
    rollup: v.optional(
      v.object({
        operation: v.union(v.literal("count"), v.literal("sum"), v.literal("latest")),
        propertyId: v.optional(v.id("documentProperties")),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectEditor(ctx, args.projectId);
    const name = cleanName(args.name);
    const normalizedName = name.toLowerCase();
    const existing = await ctx.db
      .query("documentProperties")
      .withIndex("by_project_name", (q) =>
        q.eq("projectId", args.projectId).eq("normalizedName", normalizedName),
      )
      .first();
    if (existing && !existing.deletedAt) throw new Error("duplicate-property");
    const active = await ctx.db
      .query("documentProperties")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    if (active.filter((row) => !row.deletedAt).length >= MAX_PROPERTIES) {
      throw new Error("too-many-properties");
    }
    if (active.length >= MAX_PROPERTY_ROWS) throw new Error("too-many-properties");
    const options = args.type === "status" ? cleanOptions(args.options ?? []) : [];
    const expression =
      args.type === "formula" ? (args.expression ?? "").trim().slice(0, 1000) : undefined;
    if (args.type === "formula" && !expression) throw new Error("invalid-property");
    const rollup = args.type === "rollup" ? args.rollup : undefined;
    if (args.type === "rollup" && !rollup) throw new Error("invalid-property");
    if (rollup && rollup.operation !== "count" && !rollup.propertyId) {
      throw new Error("invalid-property");
    }
    if (rollup?.propertyId) {
      const target = await ctx.db.get(rollup.propertyId);
      if (!target || target.projectId !== args.projectId || target.deletedAt) {
        throw new Error("invalid-property");
      }
    }
    if (expression) {
      const referenced = [...expression.matchAll(/\{([A-Za-z0-9_-]+)\}/g)].map(
        (match) => match[1] ?? "",
      );
      for (const id of referenced) {
        const targetId = id ? ctx.db.normalizeId("documentProperties", id) : null;
        const target = targetId ? await ctx.db.get(targetId) : null;
        if (!target || target.projectId !== args.projectId || target.deletedAt) {
          throw new Error("invalid-property");
        }
      }
      const dependencies = new Map<string, string[]>();
      for (const property of active.filter(
        (property) => !property.deletedAt && property.type === "formula",
      )) {
        dependencies.set(
          String(property._id),
          [...(property.expression ?? "").matchAll(/\{([A-Za-z0-9_-]+)\}/g)].map(
            (match) => match[1] ?? "",
          ),
        );
      }
      dependencies.set("candidate", referenced);
      const visiting = new Set<string>();
      const visited = new Set<string>();
      const visit = (id: string): boolean => {
        if (visiting.has(id)) return true;
        if (visited.has(id)) return false;
        visiting.add(id);
        for (const dependency of dependencies.get(id) ?? []) {
          if (dependencies.has(dependency) && visit(dependency)) return true;
        }
        visiting.delete(id);
        visited.add(id);
        return false;
      };
      if ([...dependencies.keys()].some(visit)) throw new Error("formula-cycle");
    }
    const now = Date.now();
    return await ctx.db.insert("documentProperties", {
      projectId: args.projectId,
      clerkOrgId: access.project.clerkOrgId,
      name,
      normalizedName,
      type: args.type,
      options,
      expression,
      rollup,
      createdBy: access.userId,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateProperty = mutation({
  args: {
    propertyId: v.id("documentProperties"),
    name: v.string(),
    options: v.optional(v.array(optionValidator)),
  },
  handler: async (ctx, args) => {
    const property = await ctx.db.get(args.propertyId);
    if (!property || property.deletedAt) throw new Error("property-removed");
    await requireProjectEditor(ctx, property.projectId);
    const name = cleanName(args.name);
    const normalizedName = name.toLowerCase();
    const duplicate = await ctx.db
      .query("documentProperties")
      .withIndex("by_project_name", (q) =>
        q.eq("projectId", property.projectId).eq("normalizedName", normalizedName),
      )
      .first();
    if (duplicate && duplicate._id !== property._id && !duplicate.deletedAt) {
      throw new Error("duplicate-property");
    }
    await ctx.db.patch(property._id, {
      name,
      normalizedName,
      options: property.type === "status" ? cleanOptions(args.options ?? property.options) : [],
      updatedAt: Date.now(),
    });
  },
});

export const deleteProperty = mutation({
  args: { propertyId: v.id("documentProperties") },
  handler: async (ctx, args) => {
    const property = await ctx.db.get(args.propertyId);
    if (!property || property.deletedAt) return;
    await requireProjectEditor(ctx, property.projectId);
    await ctx.db.patch(property._id, { deletedAt: Date.now(), updatedAt: Date.now() });
  },
});

export const setPropertyValue = mutation({
  args: {
    documentId: v.id("documents"),
    propertyId: v.id("documentProperties"),
    value: v.union(propertyValueValidator, v.null()),
  },
  handler: async (ctx, args) => {
    const [document, property] = await Promise.all([
      ctx.db.get(args.documentId),
      ctx.db.get(args.propertyId),
    ]);
    if (
      document?.kind !== "file" ||
      !property ||
      property.deletedAt ||
      document.projectId !== property.projectId ||
      (await isInactiveTree(ctx, document))
    ) {
      throw new Error("property-removed");
    }
    const access = await requireProjectEditor(ctx, document.projectId);
    const existing = await ctx.db
      .query("documentPropertyValues")
      .withIndex("by_document_property", (q) =>
        q.eq("documentId", document._id).eq("propertyId", property._id),
      )
      .unique();
    if (args.value === null) {
      if (existing) await ctx.db.delete(existing._id);
      return;
    }
    if (property.type === "formula" || property.type === "rollup") {
      throw new Error("computed-property-read-only");
    }
    if (args.value.type !== property.type) throw new Error("invalid-property-value");
    let displayValue = "";
    const fields: {
      textValue?: string;
      numberValue?: number;
      booleanValue?: boolean;
      dateValue?: number;
      dateEndValue?: number;
      statusOptionId?: string;
      personUserId?: string;
    } = {};
    if (args.value.type === "text") {
      fields.textValue = args.value.value.slice(0, MAX_TEXT_VALUE);
      displayValue = fields.textValue;
    } else if (args.value.type === "number") {
      if (!Number.isFinite(args.value.value)) throw new Error("invalid-property-value");
      fields.numberValue = args.value.value;
      displayValue = String(args.value.value);
    } else if (args.value.type === "boolean") {
      fields.booleanValue = args.value.value;
      displayValue = args.value.value ? "Yes" : "No";
    } else if (args.value.type === "date") {
      if (
        !Number.isFinite(args.value.value) ||
        args.value.value < 0 ||
        args.value.value > 8_640_000_000_000_000
      ) {
        throw new Error("invalid-property-value");
      }
      fields.dateValue = args.value.value;
      if (
        args.value.endValue !== undefined &&
        (!Number.isFinite(args.value.endValue) ||
          args.value.endValue < args.value.value ||
          args.value.endValue > 8_640_000_000_000_000)
      ) {
        throw new Error("invalid-property-value");
      }
      fields.dateEndValue = args.value.endValue;
      const start = new Date(args.value.value).toISOString().slice(0, 10);
      const end =
        args.value.endValue === undefined
          ? null
          : new Date(args.value.endValue).toISOString().slice(0, 10);
      displayValue = end && end !== start ? `${start} – ${end}` : start;
    } else if (args.value.type === "status") {
      const optionId = args.value.optionId;
      const option = property.options.find((row) => row.id === optionId);
      if (!option) throw new Error("invalid-property-value");
      fields.statusOptionId = option.id;
      displayValue = option.name;
    } else {
      const member = await acceptedMember(ctx, document.clerkOrgId, args.value.userId);
      if (!member) throw new Error("invalid-assignee");
      fields.personUserId = args.value.userId;
      displayValue = memberName(member);
    }
    const row = {
      documentId: document._id,
      propertyId: property._id,
      projectId: document.projectId,
      clerkOrgId: document.clerkOrgId,
      type: property.type,
      displayValue,
      ...fields,
      updatedBy: access.userId,
      updatedAt: Date.now(),
    };
    if (existing) await ctx.db.replace(existing._id, row);
    else await ctx.db.insert("documentPropertyValues", row);
  },
});

export const listRecords = query({
  args: { projectId: v.id("projects"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    if (!(await accessForProject(ctx, args.projectId))) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    if (args.paginationOpts.numItems > 50) throw new Error("page-too-large");
    const result = await ctx.db
      .query("documents")
      .withIndex("by_project_kind", (q) => q.eq("projectId", args.projectId).eq("kind", "file"))
      .order("desc")
      .paginate(args.paginationOpts);
    const context = await computedContext(ctx, args.projectId);
    const page = [];
    for (const document of result.page) {
      if (await isInactiveTree(ctx, document)) continue;
      const values = await ctx.db
        .query("documentPropertyValues")
        .withIndex("by_document", (q) => q.eq("documentId", document._id))
        .collect();
      const properties: RecordProperty[] = values.map((value) => ({
        propertyId: value.propertyId,
        type: value.type,
        displayValue: value.displayValue,
        textValue: value.textValue,
        numberValue: value.numberValue,
        booleanValue: value.booleanValue,
        dateValue: value.dateValue,
        dateEndValue: value.dateEndValue,
        statusOptionId: value.statusOptionId,
        personUserId: value.personUserId,
      }));
      properties.push(...(await computedProperties(ctx, document, properties, context)));
      page.push({
        id: document._id,
        name: document.name,
        fileType: document.fileType,
        updatedAt: document.updatedAt,
        properties,
      });
    }
    return { ...result, page };
  },
});

export const listBoardCardRecords = query({
  args: { projectId: v.id("projects"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    if (!(await accessForProject(ctx, args.projectId))) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    if (args.paginationOpts.numItems > 50) throw new Error("page-too-large");
    const result = await ctx.db
      .query("boardCardRecords")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .paginate(args.paginationOpts);
    const page = [];
    for (const card of result.page) {
      const document = await ctx.db.get(card.documentId);
      if (!document || (await isInactiveTree(ctx, document))) continue;
      page.push({
        id: `card:${card.documentId}:${card.cardId}`,
        sourceDocumentId: card.documentId,
        cardId: card.cardId,
        name: card.title,
        fileType: "card" as const,
        updatedAt: card.updatedAt,
        boardColumn: card.columnName,
        boardDue: card.due,
        checklistCompleted: card.checklistCompleted ?? 0,
        checklistTotal: card.checklistTotal ?? 0,
        properties: [],
      });
    }
    return { ...result, page };
  },
});

export const getRecord = query({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const document = await ctx.db.get(args.documentId);
    if (
      document?.kind !== "file" ||
      !(await accessForProject(ctx, document.projectId)) ||
      (await isInactiveTree(ctx, document))
    ) {
      return null;
    }
    const values = await ctx.db
      .query("documentPropertyValues")
      .withIndex("by_document", (q) => q.eq("documentId", document._id))
      .collect();
    const properties: RecordProperty[] = values.map((value) => ({
      propertyId: value.propertyId,
      type: value.type,
      displayValue: value.displayValue,
      textValue: value.textValue,
      numberValue: value.numberValue,
      booleanValue: value.booleanValue,
      dateValue: value.dateValue,
      dateEndValue: value.dateEndValue,
      statusOptionId: value.statusOptionId,
      personUserId: value.personUserId,
    }));
    properties.push(
      ...(await computedProperties(
        ctx,
        document,
        properties,
        await computedContext(ctx, document.projectId),
      )),
    );
    return {
      id: document._id,
      name: document.name,
      fileType: document.fileType,
      updatedAt: document.updatedAt,
      properties,
    };
  },
});

export const searchLinkTargets = query({
  args: { sourceDocumentId: v.id("documents"), term: v.string() },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.sourceDocumentId);
    const sourceAccess =
      source?.kind === "file" ? await accessForProject(ctx, source.projectId) : null;
    if (source?.kind !== "file" || !sourceAccess) {
      return [];
    }
    const term = args.term.trim().slice(0, 80);
    if (term.length < 2) return [];
    const projectIds = sourceAccess.isAdmin
      ? (
          await ctx.db
            .query("projects")
            .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", source.clerkOrgId))
            .collect()
        )
          .filter((project) => !project.deletedAt)
          .map((project) => project._id)
      : (
          await ctx.db
            .query("projectAccess")
            .withIndex("by_org_user", (q) =>
              q.eq("clerkOrgId", source.clerkOrgId).eq("userId", sourceAccess.userId),
            )
            .collect()
        ).map((grant) => grant.projectId);
    const hits = (
      await Promise.all(
        projectIds.map((projectId) =>
          ctx.db
            .query("documents")
            .withSearchIndex("search_name", (q) =>
              q.search("name", term).eq("projectId", projectId),
            )
            .take(12),
        ),
      )
    ).flat();
    const results = [];
    for (const target of hits) {
      if (
        target._id === source._id ||
        target.kind !== "file" ||
        (await isInactiveTree(ctx, target))
      ) {
        continue;
      }
      const access = await accessForProject(ctx, target.projectId);
      if (!access) continue;
      results.push({
        id: target._id,
        name: target.name,
        projectId: target.projectId,
        projectTitle: access.project.title,
      });
      if (results.length === 30) break;
    }
    return results;
  },
});

async function validateLinkTarget(
  ctx: MutationCtx,
  documentId: Id<"documents">,
): Promise<Doc<"documents">> {
  const document = await ctx.db.get(documentId);
  if (document?.kind !== "file" || (await isInactiveTree(ctx, document))) {
    throw new Error("link-target-removed");
  }
  if (!(await accessForProject(ctx, document.projectId))) throw new Error("link-target-no-access");
  return document;
}

export const addLink = mutation({
  args: {
    sourceDocumentId: v.id("documents"),
    sourceCardId: v.optional(v.string()),
    targetDocumentId: v.id("documents"),
  },
  handler: async (ctx, args) => {
    if (args.sourceDocumentId === args.targetDocumentId && !args.sourceCardId) {
      throw new Error("invalid-link");
    }
    const [source, target] = await Promise.all([
      ctx.db.get(args.sourceDocumentId),
      validateLinkTarget(ctx, args.targetDocumentId),
    ]);
    if (source?.kind !== "file" || (await isInactiveTree(ctx, source))) {
      throw new Error("link-source-removed");
    }
    const access = await requireProjectEditor(ctx, source.projectId);
    if (source.clerkOrgId !== target.clerkOrgId) throw new Error("invalid-link");
    if (args.sourceCardId) {
      if (source.fileType !== "board") throw new Error("invalid-card");
      const state = await documentState(ctx, source);
      if (!state) throw new Error("invalid-card");
      const ydoc = new Y.Doc();
      Y.applyUpdate(ydoc, new Uint8Array(state));
      const validCard = inspectBoard(ydoc).cards.has(args.sourceCardId);
      ydoc.destroy();
      if (!validCard) throw new Error("invalid-card");
    }
    const links = await ctx.db
      .query("documentLinks")
      .withIndex("by_source_document", (q) => q.eq("sourceDocumentId", source._id))
      .collect();
    if (links.length >= MAX_LINKS_PER_SOURCE) throw new Error("too-many-links");
    const duplicate = links.find(
      (row) => row.sourceCardId === args.sourceCardId && row.targetDocumentId === target._id,
    );
    if (duplicate) return duplicate._id;
    const now = Date.now();
    return await ctx.db.insert("documentLinks", {
      clerkOrgId: source.clerkOrgId,
      sourceProjectId: source.projectId,
      sourceDocumentId: source._id,
      sourceCardId: args.sourceCardId,
      managedByBoard: false,
      targetProjectId: target.projectId,
      targetDocumentId: target._id,
      createdBy: access.userId,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const removeLink = mutation({
  args: { linkId: v.id("documentLinks") },
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.linkId);
    if (!link) return;
    await requireProjectEditor(ctx, link.sourceProjectId);
    if (link.managedByBoard !== false && link.sourceCardId) throw new Error("managed-link");
    await ctx.db.delete(link._id);
  },
});

export const listOutgoingLinks = query({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.documentId);
    if (!source || !(await accessForProject(ctx, source.projectId))) return [];
    const links = await ctx.db
      .query("documentLinks")
      .withIndex("by_source_document", (q) => q.eq("sourceDocumentId", source._id))
      .collect();
    return await Promise.all(
      links.map(async (link) => {
        const target = await ctx.db.get(link.targetDocumentId);
        const targetAccess = target ? await accessForProject(ctx, target.projectId) : null;
        const removed = !target || (target ? await isInactiveTree(ctx, target) : true);
        return {
          id: link._id,
          sourceCardId: link.sourceCardId ?? null,
          managedByBoard: link.managedByBoard ?? Boolean(link.sourceCardId),
          targetDocumentId: targetAccess && !removed ? (target?._id ?? null) : null,
          title: removed ? "Removed" : targetAccess ? (target?.name ?? "Removed") : "No access",
          state: removed ? "removed" : targetAccess ? "available" : "no-access",
        };
      }),
    );
  },
});

export const listBacklinks = query({
  args: { documentId: v.id("documents"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const target = await ctx.db.get(args.documentId);
    if (!target || !(await accessForProject(ctx, target.projectId))) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    if (args.paginationOpts.numItems > 50) throw new Error("page-too-large");
    const result = await ctx.db
      .query("documentLinks")
      .withIndex("by_target_document", (q) => q.eq("targetDocumentId", target._id))
      .order("desc")
      .paginate(args.paginationOpts);
    const page = [];
    for (const link of result.page) {
      const source = await ctx.db.get(link.sourceDocumentId);
      const sourceAccess = source ? await accessForProject(ctx, source.projectId) : null;
      const removed = !source || (source ? await isInactiveTree(ctx, source) : true);
      if (removed) continue;
      page.push({
        id: link._id,
        sourceCardId: sourceAccess ? (link.sourceCardId ?? null) : null,
        sourceDocumentId: sourceAccess ? (source?._id ?? null) : null,
        title: sourceAccess ? (source?.name ?? "Removed") : "No access",
        state: sourceAccess ? "available" : "no-access",
      });
    }
    return { ...result, page };
  },
});
