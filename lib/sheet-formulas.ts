import type * as Y from "yjs";
import {
  columnIndex,
  columnLabel,
  getSheetRoots,
  inspectSheet,
  readCell,
  type SheetCell,
  type SheetCellValue,
  type SheetRoots,
  setCell,
} from "./sheet-model";

type FormulaError = "#CYCLE" | "#NAME?" | "#DIV/0!" | "#VALUE!";

type Ref = { rowId: string; colId: string };
type Ast =
  | { kind: "literal"; value: SheetCellValue }
  | { kind: "ref"; ref: Ref }
  | { kind: "range"; from: Ref; to: Ref }
  | { kind: "unary"; op: "+" | "-"; value: Ast }
  | { kind: "binary"; op: string; left: Ast; right: Ast }
  | { kind: "call"; name: string; args: Ast[] };

type Token = {
  kind: "number" | "string" | "identifier" | "ref" | "operator" | "punctuation" | "eof";
  value: string;
  ref?: Ref;
};

type Result = { kind: "value"; value: SheetCellValue } | { kind: "error"; code: FormulaError };

const error = (code: FormulaError): Result => ({ kind: "error", code });
const value = (result: SheetCellValue): Result => ({ kind: "value", value: result });

class FormulaParseError extends Error {
  constructor() {
    super("#VALUE!");
  }
}

function tokenize(source: string): Token[] {
  const result: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index] ?? "";
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (source.startsWith("@[", index)) {
      const end = source.indexOf("]", index + 2);
      if (end < 0) throw new FormulaParseError();
      const parts = source.slice(index + 2, end).split(",");
      if (parts.length !== 2 || !parts[0] || !parts[1]) throw new FormulaParseError();
      result.push({
        kind: "ref",
        value: source.slice(index, end + 1),
        ref: { rowId: parts[0], colId: parts[1] },
      });
      index = end + 1;
      continue;
    }
    if (character === '"') {
      let text = "";
      index += 1;
      let closed = false;
      while (index < source.length) {
        if (source[index] === '"') {
          if (source[index + 1] === '"') {
            text += '"';
            index += 2;
            continue;
          }
          index += 1;
          closed = true;
          break;
        }
        text += source[index] ?? "";
        index += 1;
      }
      if (!closed) throw new FormulaParseError();
      result.push({ kind: "string", value: text });
      continue;
    }
    const numberMatch = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i.exec(source.slice(index));
    if (numberMatch) {
      result.push({ kind: "number", value: numberMatch[0] });
      index += numberMatch[0].length;
      continue;
    }
    const identifierMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(index));
    if (identifierMatch) {
      result.push({ kind: "identifier", value: identifierMatch[0] });
      index += identifierMatch[0].length;
      continue;
    }
    const pair = source.slice(index, index + 2);
    if (pair === "<=" || pair === ">=" || pair === "<>") {
      result.push({ kind: "operator", value: pair });
      index += 2;
      continue;
    }
    if ("+-*/^=<>".includes(character)) {
      result.push({ kind: "operator", value: character });
      index += 1;
      continue;
    }
    if ("(),:".includes(character)) {
      result.push({ kind: "punctuation", value: character });
      index += 1;
      continue;
    }
    throw new FormulaParseError();
  }
  result.push({ kind: "eof", value: "" });
  return result;
}

class Parser {
  private index = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly resolveA1: (label: string) => Ref | null,
  ) {}

  parse(): Ast {
    const result = this.comparison();
    if (this.peek().kind !== "eof") throw new FormulaParseError();
    return result;
  }

  private peek(): Token {
    return this.tokens[this.index] ?? { kind: "eof", value: "" };
  }

  private take(): Token {
    const token = this.peek();
    this.index += 1;
    return token;
  }

  private match(value: string): boolean {
    if (this.peek().value !== value) return false;
    this.index += 1;
    return true;
  }

  private comparison(): Ast {
    let left = this.addition();
    while (["=", "<>", "<", "<=", ">", ">="].includes(this.peek().value)) {
      const op = this.take().value;
      left = { kind: "binary", op, left, right: this.addition() };
    }
    return left;
  }

  private addition(): Ast {
    let left = this.multiplication();
    while (this.peek().value === "+" || this.peek().value === "-") {
      const op = this.take().value;
      left = { kind: "binary", op, left, right: this.multiplication() };
    }
    return left;
  }

  private multiplication(): Ast {
    let left = this.power();
    while (this.peek().value === "*" || this.peek().value === "/") {
      const op = this.take().value;
      left = { kind: "binary", op, left, right: this.power() };
    }
    return left;
  }

  private power(): Ast {
    let left = this.unary();
    if (this.match("^")) left = { kind: "binary", op: "^", left, right: this.power() };
    return left;
  }

  private unary(): Ast {
    if (this.peek().value === "+" || this.peek().value === "-") {
      const op = this.take().value as "+" | "-";
      return { kind: "unary", op, value: this.unary() };
    }
    return this.primary();
  }

  private primary(): Ast {
    const token = this.take();
    if (token.kind === "number") return { kind: "literal", value: Number(token.value) };
    if (token.kind === "string") return { kind: "literal", value: token.value };
    if (token.kind === "ref" && token.ref) return this.range({ kind: "ref", ref: token.ref });
    if (token.kind === "identifier") {
      if (/^[A-Za-z]+[1-9]\d*$/.test(token.value)) {
        const ref = this.resolveA1(token.value);
        if (!ref) throw new FormulaParseError();
        return this.range({ kind: "ref", ref });
      }
      if (/^true$/i.test(token.value)) return { kind: "literal", value: true };
      if (/^false$/i.test(token.value)) return { kind: "literal", value: false };
      if (!this.match("(")) return { kind: "call", name: token.value.toUpperCase(), args: [] };
      const args: Ast[] = [];
      if (!this.match(")")) {
        do {
          args.push(this.comparison());
        } while (this.match(","));
        if (!this.match(")")) throw new FormulaParseError();
      }
      return { kind: "call", name: token.value.toUpperCase(), args };
    }
    if (token.value === "(") {
      const result = this.comparison();
      if (!this.match(")")) throw new FormulaParseError();
      return result;
    }
    throw new FormulaParseError();
  }

  private range(start: Extract<Ast, { kind: "ref" }>): Ast {
    if (!this.match(":")) return start;
    const token = this.take();
    let end: Ref | null = null;
    if (token.kind === "ref" && token.ref) end = token.ref;
    if (token.kind === "identifier" && /^[A-Za-z]+[1-9]\d*$/.test(token.value)) {
      end = this.resolveA1(token.value);
    }
    if (!end) throw new FormulaParseError();
    return { kind: "range", from: start.ref, to: end };
  }
}

function parse(source: string, resolveA1: (label: string) => Ref | null): Ast {
  const body = source.trim().startsWith("=") ? source.trim().slice(1) : source.trim();
  if (!body) throw new FormulaParseError();
  return new Parser(tokenize(body), resolveA1).parse();
}

function serialize(ast: Ast): string {
  if (ast.kind === "literal") {
    if (typeof ast.value === "string") return `"${ast.value.replaceAll('"', '""')}"`;
    if (typeof ast.value === "boolean") return ast.value ? "TRUE" : "FALSE";
    return ast.value === null ? '""' : String(ast.value);
  }
  if (ast.kind === "ref") return `@[${ast.ref.rowId},${ast.ref.colId}]`;
  if (ast.kind === "range") {
    return `@[${ast.from.rowId},${ast.from.colId}]:@[${ast.to.rowId},${ast.to.colId}]`;
  }
  if (ast.kind === "unary") return `${ast.op}(${serialize(ast.value)})`;
  if (ast.kind === "binary") return `(${serialize(ast.left)}${ast.op}${serialize(ast.right)})`;
  return `${ast.name}(${ast.args.map(serialize).join(",")})`;
}

export function formulaToInternal(source: string, rows: string[], cols: string[]): string {
  const ast = parse(source, (label) => {
    const match = /^([A-Za-z]+)([1-9]\d*)$/.exec(label);
    if (!match) return null;
    const colId = cols[columnIndex(match[1] ?? "")];
    const rowId = rows[Number(match[2]) - 1];
    return rowId && colId ? { rowId, colId } : null;
  });
  return `=${serialize(ast)}`;
}

export function formulaToA1(source: string, rows: string[], cols: string[]): string {
  const rowIndex = new Map(rows.map((id, index) => [id, index]));
  const colIndex = new Map(cols.map((id, index) => [id, index]));
  return source.replace(/@\[([^,\]]+),([^\]]+)\]/g, (_match, rowId: string, colId: string) => {
    const row = rowIndex.get(rowId);
    const col = colIndex.get(colId);
    return row === undefined || col === undefined ? "#REF!" : `${columnLabel(col)}${row + 1}`;
  });
}

function numberOf(input: SheetCellValue): number | null {
  if (input === null || input === "") return 0;
  if (typeof input === "number") return Number.isFinite(input) ? input : null;
  if (typeof input === "boolean") return input ? 1 : 0;
  const parsed = Number(input);
  return Number.isFinite(parsed) ? parsed : null;
}

function truthy(input: SheetCellValue): boolean {
  if (input === null || input === "" || input === false || input === 0) return false;
  return true;
}

function textOf(input: SheetCellValue): string {
  if (input === null) return "";
  if (typeof input === "boolean") return input ? "TRUE" : "FALSE";
  return String(input);
}

function literalValue(cell: SheetCell | null): SheetCellValue {
  if (!cell) return null;
  if (cell.type === "text") return cell.raw;
  return cell.value;
}

function comparison(left: SheetCellValue, right: SheetCellValue, op: string): boolean {
  const leftNumber = numberOf(left);
  const rightNumber = numberOf(right);
  const a = leftNumber !== null && rightNumber !== null ? leftNumber : textOf(left);
  const b = leftNumber !== null && rightNumber !== null ? rightNumber : textOf(right);
  if (op === "=") return a === b;
  if (op === "<>") return a !== b;
  if (op === "<") return a < b;
  if (op === "<=") return a <= b;
  if (op === ">") return a > b;
  return a >= b;
}

function display(result: Result): string {
  if (result.kind === "error") return result.code;
  return textOf(result.value);
}

class Evaluator {
  private readonly cache = new Map<string, Result>();
  private readonly visiting = new Set<string>();
  private readonly rowIndex: Map<string, number>;
  private readonly colIndex: Map<string, number>;

  constructor(
    private readonly roots: SheetRoots,
    private readonly rows: string[],
    private readonly cols: string[],
  ) {
    this.rowIndex = new Map(rows.map((id, index) => [id, index]));
    this.colIndex = new Map(cols.map((id, index) => [id, index]));
  }

  cell(rowId: string, colId: string): Result {
    const key = `${rowId}:${colId}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    if (this.visiting.has(key)) return error("#CYCLE");
    if (!this.rowIndex.has(rowId) || !this.colIndex.has(colId)) return value(null);
    const cell = readCell(this.roots, rowId, colId);
    if (!cell?.formula) return value(literalValue(cell));
    this.visiting.add(key);
    let result: Result;
    try {
      const ast = parse(cell.formula, () => null);
      result = this.ast(ast);
    } catch {
      result = error("#VALUE!");
    }
    this.visiting.delete(key);
    this.cache.set(key, result);
    return result;
  }

  private ast(ast: Ast): Result {
    if (ast.kind === "literal") return value(ast.value);
    if (ast.kind === "ref") return this.cell(ast.ref.rowId, ast.ref.colId);
    if (ast.kind === "range") return error("#VALUE!");
    if (ast.kind === "unary") {
      const result = this.ast(ast.value);
      if (result.kind === "error") return result;
      const numeric = numberOf(result.value);
      return numeric === null ? error("#VALUE!") : value(ast.op === "-" ? -numeric : numeric);
    }
    if (ast.kind === "binary") {
      const left = this.ast(ast.left);
      if (left.kind === "error") return left;
      const right = this.ast(ast.right);
      if (right.kind === "error") return right;
      if (["=", "<>", "<", "<=", ">", ">="].includes(ast.op)) {
        return value(comparison(left.value, right.value, ast.op));
      }
      const a = numberOf(left.value);
      const b = numberOf(right.value);
      if (a === null || b === null) return error("#VALUE!");
      if (ast.op === "/" && b === 0) return error("#DIV/0!");
      const numeric =
        ast.op === "+"
          ? a + b
          : ast.op === "-"
            ? a - b
            : ast.op === "*"
              ? a * b
              : ast.op === "/"
                ? a / b
                : a ** b;
      return Number.isFinite(numeric) ? value(numeric) : error("#VALUE!");
    }
    return this.call(ast);
  }

  private range(ast: Extract<Ast, { kind: "range" }>): Result[] {
    const startRow = this.rowIndex.get(ast.from.rowId);
    const endRow = this.rowIndex.get(ast.to.rowId);
    const startCol = this.colIndex.get(ast.from.colId);
    const endCol = this.colIndex.get(ast.to.colId);
    if (
      startRow === undefined ||
      endRow === undefined ||
      startCol === undefined ||
      endCol === undefined
    )
      return [];
    const result: Result[] = [];
    for (let row = Math.min(startRow, endRow); row <= Math.max(startRow, endRow); row += 1) {
      for (let col = Math.min(startCol, endCol); col <= Math.max(startCol, endCol); col += 1) {
        result.push(this.cell(this.rows[row] ?? "", this.cols[col] ?? ""));
      }
    }
    return result;
  }

  private values(args: Ast[]): Result[] {
    return args.flatMap((arg) => (arg.kind === "range" ? this.range(arg) : [this.ast(arg)]));
  }

  private call(ast: Extract<Ast, { kind: "call" }>): Result {
    if (ast.name === "IF") {
      if (ast.args.length < 2 || ast.args.length > 3) return error("#VALUE!");
      const condition = this.ast(ast.args[0] as Ast);
      if (condition.kind === "error") return condition;
      return this.ast(
        (truthy(condition.value) ? ast.args[1] : ast.args[2]) ?? { kind: "literal", value: false },
      );
    }
    if (!["SUM", "AVERAGE", "MIN", "MAX", "COUNT", "CONCAT"].includes(ast.name))
      return error("#NAME?");
    const values = this.values(ast.args);
    const failure = values.find((item) => item.kind === "error");
    if (failure?.kind === "error") return failure;
    const scalars = values.map((item) => (item.kind === "value" ? item.value : null));
    if (ast.name === "CONCAT") return value(scalars.map(textOf).join(""));
    const numbers = scalars.map(numberOf).filter((item): item is number => item !== null);
    if (ast.name === "COUNT") return value(numbers.length);
    if (ast.name === "SUM") return value(numbers.reduce((sum, item) => sum + item, 0));
    if (ast.name === "AVERAGE")
      return numbers.length === 0
        ? error("#DIV/0!")
        : value(numbers.reduce((sum, item) => sum + item, 0) / numbers.length);
    if (ast.name === "MIN") return value(numbers.length === 0 ? 0 : Math.min(...numbers));
    return value(numbers.length === 0 ? 0 : Math.max(...numbers));
  }
}

export function recomputeFormulas(ydoc: Y.Doc): number {
  const inspection = inspectSheet(ydoc);
  const roots = getSheetRoots(ydoc);
  const evaluator = new Evaluator(roots, inspection.rows, inspection.cols);
  const updates: Array<{ rowId: string; colId: string; cell: SheetCell; nextDisplay: string }> = [];
  for (const rowId of inspection.rows) {
    for (const colId of inspection.cols) {
      const cell = readCell(roots, rowId, colId);
      if (!cell?.formula) continue;
      const nextDisplay = display(evaluator.cell(rowId, colId));
      if (nextDisplay !== cell.display) updates.push({ rowId, colId, cell, nextDisplay });
    }
  }
  if (updates.length > 0) {
    ydoc.transact(() => {
      for (const update of updates)
        setCell(roots, update.rowId, update.colId, { ...update.cell, display: update.nextDisplay });
    }, "formula");
  }
  return updates.length;
}
