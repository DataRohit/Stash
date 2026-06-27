import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import process from "node:process";
import ts from "typescript";

const ROOT = process.cwd();
const IGNORED_DIRS = new Set([".git", ".next", "build", "coverage", "dist", "node_modules", "out"]);
const IGNORED_FILES = new Set(["next-env.d.ts"]);
const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".css"]);

function collectFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        files.push(...collectFiles(fullPath));
      }
    } else if (SCANNED_EXTENSIONS.has(extname(entry.name)) && !IGNORED_FILES.has(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

function lineOf(text, position) {
  let line = 1;
  for (let index = 0; index < position; index += 1) {
    if (text.charCodeAt(index) === 10) {
      line += 1;
    }
  }
  return line;
}

function scanScript(text, isTsx) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    isTsx ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard,
    text,
  );
  const positions = [];
  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      positions.push(scanner.getTokenStart());
    }
    token = scanner.scan();
  }
  return positions;
}

function scanCss(text) {
  const positions = [];
  const pattern = /\/\*[\s\S]*?\*\//g;
  let match = pattern.exec(text);
  while (match !== null) {
    positions.push(match.index);
    match = pattern.exec(text);
  }
  return positions;
}

const offenders = [];
for (const file of collectFiles(ROOT)) {
  const text = readFileSync(file, "utf8");
  const extension = extname(file);
  const positions = extension === ".css" ? scanCss(text) : scanScript(text, extension === ".tsx");
  for (const position of positions) {
    offenders.push(`${relative(ROOT, file)}:${lineOf(text, position)}`);
  }
}

if (offenders.length > 0) {
  process.stdout.write(
    `Found ${offenders.length} comment(s) in source files. Comments are not allowed:\n`,
  );
  for (const offender of offenders) {
    process.stdout.write(`  ${offender}\n`);
  }
  process.exit(1);
}

process.stdout.write("check-no-comments: no comments found in scanned source files.\n");
