import type { GitDrive, RealPath, RegularFileHandle } from "@kompjutr/drive";
import { joinPath, relativeTo } from "../common/paths.js";
import { IGNORE_LIMITS, IgnoreBudget, IgnoreLimitError } from "./limits.js";
import { compilePatternBytes, type IgnorePattern } from "./pattern.js";

export type IgnoreWorktree = Pick<GitDrive, "discoverFiles" | "readFileHandles" | "realpath">;

const ENCODER = new TextEncoder();

class IgnoreLoadError extends Error {
  readonly code = "EIO";

  constructor(detail: string) {
    super(`EIO: invalid ignore loader result: ${detail}`);
    this.name = "IgnoreLoadError";
  }
}

export function boundedUtf8Bytes(value: string, limit: number): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next !== undefined && next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
    if (bytes > limit) return limit + 1;
  }
  return bytes;
}

function compileSource(contents: Uint8Array, budget: IgnoreBudget, path?: string): IgnorePattern[] {
  const patterns: IgnorePattern[] = [];
  let start = 0;
  let first = true;
  for (let end = 0; end <= contents.byteLength; end++) {
    if (end < contents.byteLength && contents[end] !== 0x0a) continue;
    let lineStart = start;
    let lineEnd = end;
    if (
      first &&
      contents[lineStart] === 0xef &&
      contents[lineStart + 1] === 0xbb &&
      contents[lineStart + 2] === 0xbf
    ) {
      lineStart += 3;
    }
    if (lineEnd > lineStart && contents[lineEnd - 1] === 0x0d) lineEnd--;
    const lineBytes = budget.checkLine(lineEnd - lineStart, path);
    const compiled = compilePatternBytes(contents.subarray(lineStart, lineEnd));
    if (compiled !== null) {
      budget.addPattern(compiled, lineBytes, path);
      patterns.push(compiled);
    }
    start = end + 1;
    first = false;
  }
  return patterns;
}

export function parseIgnoreFile(contents: string): IgnorePattern[] {
  const budget = new IgnoreBudget();
  budget.addRaw(boundedUtf8Bytes(contents, IGNORE_LIMITS.rawBytes));
  const bytes = ENCODER.encode(contents);
  return compileSource(bytes, budget);
}

function directoryOfIgnoreFile(root: RealPath, path: RealPath): string {
  const relative = relativeTo(root, path);
  if (relative === null) throw new IgnoreLoadError(`'${path}' is outside '${root}'`);
  if (relative === ".gitignore") return "";
  const suffix = "/.gitignore";
  if (!relative.endsWith(suffix)) throw new IgnoreLoadError(`unexpected path '${path}'`);
  return relative.slice(0, -suffix.length);
}

function sameHandle(left: RegularFileHandle, right: RegularFileHandle): boolean {
  return (
    left.path === right.path &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.rev === right.rev
  );
}

function compileHandlePage(
  worktree: IgnoreWorktree,
  root: RealPath,
  handles: readonly RegularFileHandle[],
  budget: IgnoreBudget,
  rules: Map<string, IgnorePattern[]>,
): void {
  let remaining = [...handles];
  while (remaining.length > 0) {
    const batch = worktree.readFileHandles(remaining);
    const completed = remaining.length - batch.remaining.length;
    if (completed <= 0) throw new IgnoreLoadError("readFileHandles made no progress");
    for (let index = 0; index < batch.remaining.length; index++) {
      const expected = remaining[completed + index];
      const actual = batch.remaining[index];
      if (expected === undefined || actual === undefined || !sameHandle(expected, actual)) {
        throw new IgnoreLoadError("readFileHandles changed the retry boundary");
      }
    }
    for (let index = 0; index < completed; index++) {
      const handle = remaining[index];
      if (handle === undefined) continue;
      const bytes = batch.files.get(handle.path);
      if (bytes === undefined || bytes.byteLength !== handle.size) {
        throw new IgnoreLoadError(`readFileHandles omitted '${handle.path}'`);
      }
      const patterns = compileSource(bytes, budget, handle.path);
      batch.files.delete(handle.path);
      if (patterns.length > 0) rules.set(directoryOfIgnoreFile(root, handle.path), patterns);
    }
    remaining = batch.remaining;
  }
}

function compileExtra(extra: readonly string[], budget: IgnoreBudget): IgnorePattern[] {
  const patterns: IgnorePattern[] = [];
  for (let index = 0; index < extra.length; index++) {
    const source = extra[index];
    if (source === undefined) continue;
    if (index > 0) budget.addRaw(1, "options.extra");
    budget.addRaw(boundedUtf8Bytes(source, IGNORE_LIMITS.rawBytes), "options.extra");
    const bytes = ENCODER.encode(source);
    patterns.push(...compileSource(bytes, budget, "options.extra"));
  }
  return patterns;
}

export function loadRules(
  worktree: IgnoreWorktree,
  root: string,
  extraSources: readonly string[],
  excludeRoots: readonly string[],
): { rules: Map<string, IgnorePattern[]>; extra: IgnorePattern[] } {
  const budget = new IgnoreBudget();
  const extra = compileExtra(extraSources, budget);
  const canonicalRoot = worktree.realpath(root);
  const excluded = excludeRoots.map((path) => {
    const relative = relativeTo(root, path);
    return relative === null ? path.replace(/\/+$/, "") : joinPath(canonicalRoot, relative);
  });
  const rules = new Map<string, IgnorePattern[]>();
  const cursors = new Set<RealPath>();
  let after: RealPath | undefined;

  for (;;) {
    const page = worktree.discoverFiles(canonicalRoot, "*/.gitignore", {
      after,
      limit: IGNORE_LIMITS.discoveryPage,
      excludeRoots: excluded,
    });
    for (const handle of page.handles) budget.addFile(handle);
    if (page.next !== null && budget.files === IGNORE_LIMITS.files) {
      throw new IgnoreLimitError("files", IGNORE_LIMITS.files, IGNORE_LIMITS.files + 1);
    }
    compileHandlePage(worktree, canonicalRoot, page.handles, budget, rules);
    if (page.next === null) break;
    if (page.next === after || cursors.has(page.next)) {
      throw new IgnoreLoadError("discoverFiles repeated its cursor");
    }
    cursors.add(page.next);
    after = page.next;
  }
  return { rules, extra };
}
