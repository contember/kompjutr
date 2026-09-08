import { join, normalize } from "../../fs/path.js";
import { ShellSyntaxError } from "../parse/ast.js";
import type { Argument } from "../plan/types.js";
import { type BoundedFs, ShellLimitError } from "./context.js";
import { compileGlob, sqlGlobFor } from "./glob.js";
import { utf8Bytes } from "./utf8.js";

const ARGUMENT_COUNT_MAX = 10_000;
const PATH_PAGE_MAX = 1_000;

export interface ExpandedArguments {
  readonly argv: readonly string[];
  release(): void;
}

export function expandArguments(
  args: readonly Argument[],
  fs: BoundedFs,
  cwd: string,
  env?: Readonly<Record<string, string>>,
): ExpandedArguments {
  const out: string[] = [];
  const releases: Array<() => void> = [];
  const push = (value: string): void => {
    if (out.length >= ARGUMENT_COUNT_MAX) {
      throw new ShellLimitError(
        "arguments",
        `E2BIG: expanded argv exceeds ${ARGUMENT_COUNT_MAX} entries`,
      );
    }
    const valueBytes = utf8Bytes(value);
    releases.push(fs.retained.retain(valueBytes, "command arguments"));
    out.push(value);
  };

  try {
    for (const arg of args) {
      for (const field of expandWord(arg, env)) {
        const value = fieldText(field);
        if (!fieldHasGlob(field)) {
          push(value);
          continue;
        }
        let matched = false;
        for (const match of expandGlob(fieldPattern(field), fs, cwd)) {
          push(match);
          matched = true;
        }
        if (!matched) push(value);
      }
    }
  } catch (error) {
    for (const release of releases) release();
    throw error;
  }
  return {
    argv: out,
    release: () => {
      for (const release of releases) release();
    },
  };
}

export function single(arg: Argument, fs: BoundedFs, cwd: string): string {
  const expanded = expandArguments([arg], fs, cwd);
  try {
    const first = expanded.argv[0];
    if (expanded.argv.length !== 1 || first === undefined) {
      throw new ShellSyntaxError("redirection", "ambiguous redirect", 0);
    }
    return first;
  } finally {
    expanded.release();
  }
}

interface FieldPart {
  readonly value: string;
  readonly globActive: boolean;
}

type ExpandedField = readonly FieldPart[];

function* expandWord(
  argument: Argument,
  env: Readonly<Record<string, string>> | undefined,
): Generator<ExpandedField> {
  let field: FieldPart[] = [];
  let preserveEmpty = false;

  for (const part of argument.parts) {
    if (part.kind === "literal") {
      if (part.value !== "") field.push({ value: part.value, globActive: false });
      preserveEmpty ||= part.quoted;
      continue;
    }
    if (part.kind === "glob") {
      field.push({ value: part.value, globActive: true });
      continue;
    }

    const value = environmentValue(env, part.name);
    if (part.quoted) {
      if (value !== "") field.push({ value, globActive: false });
      preserveEmpty = true;
      continue;
    }

    let start = 0;
    for (let index = 0; index <= value.length; index++) {
      if (index < value.length && !isIfsWhitespace(value.charAt(index))) continue;
      if (index > start) {
        field.push({ value: value.slice(start, index), globActive: true });
      }
      if (index < value.length) {
        if (field.length > 0 || preserveEmpty) yield field;
        field = [];
        preserveEmpty = false;
        while (isIfsWhitespace(value.charAt(index + 1))) index++;
      }
      start = index + 1;
    }
  }

  if (field.length > 0 || preserveEmpty) yield field;
}

function environmentValue(env: Readonly<Record<string, string>> | undefined, name: string): string {
  if (env === undefined || !Object.hasOwn(env, name)) return "";
  return env[name] ?? "";
}

function isIfsWhitespace(value: string): boolean {
  return value === " " || value === "\t" || value === "\n";
}

function fieldText(field: ExpandedField): string {
  let value = "";
  for (const part of field) value += part.value;
  return value;
}

function fieldPattern(field: ExpandedField): string {
  let pattern = "";
  for (const part of field) {
    pattern += part.globActive ? part.value : escapeGlob(part.value);
  }
  return pattern;
}

function fieldHasGlob(field: ExpandedField): boolean {
  return field.some((part) => part.globActive && /[*?[]/.test(part.value));
}

function escapeGlob(value: string): string {
  return value.replace(/[*?[]/g, (match) => `[${match}]`);
}

/**
 * Paths matching `pattern`, relative to `cwd` when the pattern is relative.
 *
 * The SQL GLOB narrows and JS decides, because SQLite's `*` crosses `/` and
 * a shell's does not. Over the ceiling the narrowing is dropped and the
 * subtree is scanned instead — correct either way, only slower.
 */
function* expandGlob(pattern: string, fs: BoundedFs, cwd: string): Generator<string> {
  const isAbsolute = pattern.startsWith("/");
  const absolute = isAbsolute ? normalize(pattern) : join(cwd, pattern);
  const fixed = absolute.slice(0, Math.max(0, absolute.search(/[*?[]/)));
  const root = fixed.includes("/") ? fixed.slice(0, fixed.lastIndexOf("/")) || "/" : "/";
  const matcher = compileGlob(absolute);
  const displayRoot = isAbsolute ? null : relativeGlobRoot(pattern);

  const sql = sqlGlobFor(absolute);
  if (sql !== null) {
    let after: string | undefined;
    for (;;) {
      const page = fs.globPage(
        root,
        sql,
        after === undefined ? { limit: PATH_PAGE_MAX } : { after, limit: PATH_PAGE_MAX },
      );
      for (const path of page.paths) {
        if (matcher.test(path)) yield projectGlobMatch(path, root, displayRoot);
      }
      if (page.next === null) return;
      after = page.next;
    }
  }

  let after: string | undefined;
  for (;;) {
    const page = fs.scan(
      root,
      after === undefined ? { limit: PATH_PAGE_MAX } : { after, limit: PATH_PAGE_MAX },
    );
    for (const entry of page) {
      if (matcher.test(entry.path)) yield projectGlobMatch(entry.path, root, displayRoot);
    }
    if (page.length < PATH_PAGE_MAX) return;
    after = page[page.length - 1]?.path;
    if (after === undefined) return;
  }
}

function relativeGlobRoot(pattern: string): string {
  const metacharacter = pattern.search(/[*?[]/);
  const fixed = pattern.slice(0, Math.max(0, metacharacter));
  const slash = fixed.lastIndexOf("/");
  return slash === -1 ? "" : fixed.slice(0, slash);
}

function projectGlobMatch(path: string, root: string, displayRoot: string | null): string {
  if (displayRoot === null) return path;
  const suffix = root === "/" ? path.slice(1) : path.slice(root.length + 1);
  if (displayRoot === "") return suffix;
  return `${displayRoot}/${suffix}`;
}

export function resolve(cwd: string, path: string): string {
  return path.startsWith("/") ? normalize(path) : join(cwd, path);
}
