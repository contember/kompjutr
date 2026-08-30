import { MemoryCoordinator, type MemoryReservation } from "../../memory.js";
import { utf8, utf8Decoder } from "../bytes.js";
import { GitError } from "../errors.js";
import { type ByteGlobPattern, compileByteGlob } from "../ignore/pattern.js";
import { retainedStringBytes } from "../retained.js";
import { comparePaths } from "../streams.js";

export const MAX_LS_FILES_WILDCARD_TOKENS = 4_096;
export const MAX_LS_FILES_MATCHER_WORK = 32 * 1024 * 1024;
export const LS_FILES_RESULT_FIXED_BYTES = 128;
export const LS_FILES_INDEX_PAGE = 256;
const PATHSPEC_FIXED_BYTES = 512;
const PATHSPEC_PATTERN_BYTES = 256;
const COLLECTION_FIXED_BYTES = 128;
const SET_ENTRY_BYTES = 96;
const ARRAY_SLOT_BYTES = 8;
const ENCODED_ROW_FIXED_BYTES = 64;
const COMPILE_SEGMENT_BYTES = 48;
const COMPILED_GLOB_TOKEN_BYTES = 96;

export interface LsFilesLimits {
  maxWildcardTokens?: number;
  maxMatcherWork?: number;
}

export interface LsFilesOptions {
  paths?: readonly string[];
  limits?: LsFilesLimits;
}

interface ResolvedLimits {
  maxWildcardTokens: number;
  maxMatcherWork: number;
}

interface LiteralPathspec {
  kind: "literal";
  path: string;
  bytes: Uint8Array;
  directoryOnly: boolean;
  exact: boolean;
}

interface GlobPathspec {
  kind: "glob";
  pattern: ByteGlobPattern;
}

type ReadPathspec = LiteralPathspec | GlobPathspec;

/** A compiled read-only pathspec and the indexed prefixes that can cover it. */
export class CompiledReadPathspec {
  readonly scanPrefixes: readonly string[] | null;
  readonly #all: boolean;
  readonly #patterns: readonly ReadPathspec[];
  readonly #limits: ResolvedLimits;
  readonly #memory: MemoryReservation;

  constructor(
    all: boolean,
    patterns: readonly ReadPathspec[],
    scanPrefixes: readonly string[] | null,
    limits: ResolvedLimits,
    memory: MemoryReservation,
  ) {
    this.#all = all;
    this.#patterns = patterns;
    this.scanPrefixes = scanPrefixes;
    this.#limits = limits;
    this.#memory = memory;
  }

  /** Filter bounded source rows, deduplicate conflict stages, and restore Git byte order. */
  collect(rows: Iterable<string>): string[] {
    const resultMemory = this.#memory.scope();
    try {
      let retainedBytes = 2 * COLLECTION_FIXED_BYTES;
      resultMemory.set("other", retainedBytes);
      const unique = new Set<string>();
      const out: string[] = [];
      let matcherWork = 0;

      for (const path of rows) {
        if (unique.has(path)) continue;

        let matched = this.#all;
        if (!matched) {
          const rowMemory = resultMemory.scope();
          try {
            rowMemory.set("other", ENCODED_ROW_FIXED_BYTES + encodedUtf8Length(path));
            const bytes = utf8.encode(path);
            for (const pattern of this.#patterns) {
              const result =
                pattern.kind === "literal"
                  ? matchLiteral(pattern, bytes, this.#limits.maxMatcherWork - matcherWork)
                  : pattern.pattern.match(bytes, this.#limits.maxMatcherWork - matcherWork);
              matcherWork += result.work;
              if (matcherWork > this.#limits.maxMatcherWork) {
                throw tooBig("matcher work", this.#limits.maxMatcherWork);
              }
              if (result.matched) {
                matched = true;
                break;
              }
            }
          } finally {
            rowMemory.dispose();
          }
        }
        if (!matched) continue;

        const additional = lsFilesResultRetainedBytes(path) + SET_ENTRY_BYTES + ARRAY_SLOT_BYTES;
        retainedBytes = checkedMemoryAdd(retainedBytes, additional, "result");
        resultMemory.set("other", retainedBytes);
        unique.add(path);
        out.push(path);
      }

      resultMemory.set("other", retainedBytes + out.length * ARRAY_SLOT_BYTES);
      out.sort(comparePaths);
      resultMemory.set("other", retainedBytes);
      return out;
    } finally {
      resultMemory.dispose();
    }
  }

  release(): void {
    this.#memory.dispose();
  }
}

export function compileReadPathspec(
  options?: LsFilesOptions,
  owningReservation?: MemoryReservation,
): CompiledReadPathspec {
  const memory = owningReservation?.scope() ?? new MemoryCoordinator().reserve();
  try {
    return compileReadPathspecOwned(options, memory);
  } catch (error) {
    memory.dispose();
    throw error;
  }
}

function compileReadPathspecOwned(
  options: LsFilesOptions | undefined,
  memory: MemoryReservation,
): CompiledReadPathspec {
  let retainedBytes = PATHSPEC_FIXED_BYTES + COLLECTION_FIXED_BYTES;
  memory.set("other", retainedBytes);
  const input = runtimeOptions(options);
  const limits = resolveLimits(input.limits);
  const paths = input.paths;
  if (paths === undefined || paths.length === 0) {
    return new CompiledReadPathspec(true, [], null, limits, memory);
  }
  const patterns: ReadPathspec[] = [];
  let all = false;
  let wildcardTokens = 0;

  for (let index = 0; index < paths.length; index++) {
    const raw = Reflect.get(paths, index);
    if (typeof raw !== "string") throw new GitError("EINVAL", "ls-files paths must be strings");
    if (raw === "") throw new GitError("EINVAL", "empty ls-files pathspec");
    if (raw.startsWith("/") || raw.startsWith(":")) throw unsupportedPathspec();

    const rawBytes = validatedUtf8Length(raw);
    const segments = pathSegmentCount(raw);
    const compilePeak =
      2 * COLLECTION_FIXED_BYTES +
      segments * (ARRAY_SLOT_BYTES + COMPILE_SEGMENT_BYTES) +
      raw.length * 4 +
      rawBytes * (1 + COMPILED_GLOB_TOKEN_BYTES);
    memory.set("other", checkedMemoryAdd(retainedBytes, compilePeak, "compiler"));

    const normalized = canonicalPathspec(raw);
    if (normalized === "." || normalized === "") {
      all = true;
      memory.set("other", retainedBytes);
      continue;
    }

    const additionalStructure = wildcardStructure(normalized);
    if (additionalStructure > limits.maxWildcardTokens - wildcardTokens) {
      throw tooBig("wildcard structure", limits.maxWildcardTokens);
    }
    wildcardTokens += additionalStructure;

    const glob = compileByteGlob(utf8.encode(normalized), {
      slashSensitive: false,
      unmatchedClassLiteral: true,
    });
    const escaped = normalized.includes("\\");
    if (escaped) {
      retainedBytes = checkedMemoryAdd(
        retainedBytes,
        literalPatternRetainedBytes(normalized),
        "compiled pathspec",
      );
      addLiteral(patterns, normalized);
    }
    if (glob === null) {
      memory.set("other", retainedBytes);
      continue;
    }

    if (glob.literal === null) {
      retainedBytes = checkedMemoryAdd(
        retainedBytes,
        globPatternRetainedBytes(glob, rawBytes),
        "compiled pathspec",
      );
      patterns.push({ kind: "glob", pattern: glob });
      memory.set("other", retainedBytes);
      continue;
    }

    const decoded = utf8Decoder.decode(glob.literal);
    retainedBytes = checkedMemoryAdd(
      retainedBytes,
      literalPatternRetainedBytes(decoded),
      "compiled pathspec",
    );
    if (escaped) addExact(patterns, decoded);
    else if (addLiteral(patterns, decoded)) all = true;
    memory.set("other", retainedBytes);
  }

  const hasGlob = patterns.some((pattern) => pattern.kind === "glob");
  let scanPrefixes: readonly string[] | null = null;
  if (!all && !hasGlob) {
    let longestPathUnits = 0;
    for (const pattern of patterns) {
      if (pattern.kind === "literal")
        longestPathUnits = Math.max(longestPathUnits, pattern.path.length);
    }
    const coalescingPeak =
      3 * COLLECTION_FIXED_BYTES +
      patterns.length * (3 * ARRAY_SLOT_BYTES + SET_ENTRY_BYTES) +
      48 +
      longestPathUnits * 2;
    memory.set("other", checkedMemoryAdd(retainedBytes, coalescingPeak, "coalescing"));
    scanPrefixes = coalescedPaths(patterns);
    retainedBytes = checkedMemoryAdd(
      retainedBytes,
      COLLECTION_FIXED_BYTES + scanPrefixes.length * ARRAY_SLOT_BYTES,
      "scan prefixes",
    );
  }
  memory.set("other", retainedBytes);
  return new CompiledReadPathspec(all, patterns, scanPrefixes, limits, memory);
}

export function lsFilesResultRetainedBytes(path: string): number {
  return LS_FILES_RESULT_FIXED_BYTES + retainedStringBytes(path);
}

function matchLiteral(
  pattern: LiteralPathspec,
  path: Uint8Array,
  maxWork: number,
): { matched: boolean; work: number } {
  let work = 1;
  if (work > maxWork || path.byteLength < pattern.bytes.byteLength) {
    return { matched: false, work };
  }
  for (let index = 0; index < pattern.bytes.byteLength; index++) {
    work++;
    if (work > maxWork) return { matched: false, work };
    if (path[index] !== pattern.bytes[index]) return { matched: false, work };
  }
  work++;
  if (work > maxWork) return { matched: false, work };
  if (path.byteLength === pattern.bytes.byteLength) {
    return { matched: !pattern.directoryOnly, work };
  }
  return { matched: !pattern.exact && path[pattern.bytes.byteLength] === 0x2f, work };
}

function runtimeOptions(options: unknown): {
  paths: readonly unknown[] | undefined;
  limits: unknown;
} {
  if (options === undefined) return { paths: undefined, limits: undefined };
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new GitError("EINVAL", "ls-files options must be an object");
  }
  for (const key of ["cached", "others", "excludeStandard", "excludeRoots"]) {
    if (Reflect.has(options, key)) {
      throw new GitError("EINVAL", "ls-files worktree selection requires a worktree");
    }
  }
  const paths = Reflect.get(options, "paths");
  if (paths !== undefined && !Array.isArray(paths)) {
    throw new GitError("EINVAL", "ls-files paths must be an array");
  }
  return { paths, limits: Reflect.get(options, "limits") };
}

function resolveLimits(limits: unknown): ResolvedLimits {
  if (
    limits !== undefined &&
    (typeof limits !== "object" || limits === null || Array.isArray(limits))
  ) {
    throw new GitError("EINVAL", "ls-files limits must be an object");
  }
  return {
    maxWildcardTokens: boundedLimit(
      limitValue(limits, "maxWildcardTokens"),
      MAX_LS_FILES_WILDCARD_TOKENS,
      "wildcard token",
    ),
    maxMatcherWork: boundedLimit(
      limitValue(limits, "maxMatcherWork"),
      MAX_LS_FILES_MATCHER_WORK,
      "matcher work",
    ),
  };
}

function checkedMemoryAdd(total: number, bytes: number, label: string): number {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > Number.MAX_SAFE_INTEGER - total) {
    throw new GitError("E2BIG", `ls-files ${label} memory accounting overflows`);
  }
  return total + bytes;
}

function limitValue(limits: unknown, key: string): number | undefined {
  if (limits === undefined) return undefined;
  if (typeof limits !== "object" || limits === null) {
    throw new GitError("EINVAL", "ls-files limits must be an object");
  }
  const value = Reflect.get(limits, key);
  if (value === undefined) return undefined;
  if (typeof value !== "number") {
    throw new GitError("EINVAL", "ls-files limits must be numbers");
  }
  return value;
}

function boundedLimit(value: number | undefined, hard: number, label: string): number {
  if (value === undefined) return hard;
  if (!Number.isSafeInteger(value) || value < 0 || value > hard) {
    throw new GitError("EINVAL", `ls-files ${label} limit must be from 0 to ${hard}`);
  }
  return value;
}

function coalescedPaths(patterns: readonly ReadPathspec[]): string[] {
  const ordered: string[] = [];
  for (const pattern of patterns) {
    if (pattern.kind === "literal") ordered.push(pattern.path);
  }
  ordered.sort(comparePaths);
  const out: string[] = [];
  const retained = new Set<string>();
  for (const path of ordered) {
    if (retained.has(path)) continue;
    let covered = false;
    let slash = path.indexOf("/");
    while (slash >= 0) {
      if (retained.has(path.slice(0, slash))) {
        covered = true;
        break;
      }
      slash = path.indexOf("/", slash + 1);
    }
    if (covered) continue;
    retained.add(path);
    out.push(path);
  }
  return out;
}

function pathSegmentCount(path: string): number {
  let segments = 1;
  for (let index = 0; index < path.length; index++) {
    if (path.charCodeAt(index) === 0x2f) segments++;
  }
  return segments;
}

function literalPatternRetainedBytes(path: string): number {
  return (
    PATHSPEC_PATTERN_BYTES + ARRAY_SLOT_BYTES + retainedStringBytes(path) + encodedUtf8Length(path)
  );
}

function globPatternRetainedBytes(pattern: ByteGlobPattern, encodedBytes: number): number {
  return (
    PATHSPEC_PATTERN_BYTES +
    ARRAY_SLOT_BYTES +
    pattern.tokenCount * COMPILED_GLOB_TOKEN_BYTES +
    encodedBytes * 3
  );
}

function unsupportedPathspec(): GitError {
  return new GitError("EINVAL", "unsupported leading ls-files pathspec syntax");
}

function tooBig(resource: string, limit: number): GitError {
  return new GitError("E2BIG", `ls-files ${resource} exceeds ${limit}`);
}

function addLiteral(patterns: ReadPathspec[], literal: string): boolean {
  const directoryOnly = literal.endsWith("/");
  const path = directoryOnly ? literal.slice(0, -1) : literal;
  if (path === "" || path === ".") return true;
  patterns.push({ kind: "literal", path, bytes: utf8.encode(path), directoryOnly, exact: false });
  return false;
}

function addExact(patterns: ReadPathspec[], path: string): void {
  patterns.push({
    kind: "literal",
    path,
    bytes: utf8.encode(path),
    directoryOnly: false,
    exact: true,
  });
}

function canonicalPathspec(raw: string): string {
  const directoryOnly = raw.endsWith("/");
  const segments: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) {
        throw new GitError("EINVAL", "ls-files pathspec escapes the repository");
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (segments.length === 0) return ".";
  const normalized = segments.join("/");
  return directoryOnly ? `${normalized}/` : normalized;
}

function validatedUtf8Length(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit === 0) throw new GitError("EINVAL", "ls-files pathspec contains NUL");
    if (unit < 0x80) bytes++;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) {
        throw new GitError("EINVAL", "ls-files pathspec is not canonical UTF-16");
      }
      bytes += 4;
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new GitError("EINVAL", "ls-files pathspec is not canonical UTF-16");
    } else bytes += 3;
    if (!Number.isSafeInteger(bytes)) {
      throw new GitError("E2BIG", "ls-files pathspec byte length overflows");
    }
  }
  return bytes;
}

function encodedUtf8Length(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit < 0x80) bytes++;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        index++;
      } else bytes += 3;
    } else bytes += 3;
    if (!Number.isSafeInteger(bytes)) {
      throw new GitError("E2BIG", "ls-files row encoding size overflows");
    }
  }
  return bytes;
}

function wildcardStructure(pattern: string): number {
  let tokens = 0;
  for (let index = 0; index < pattern.length; index++) {
    const unit = pattern.charCodeAt(index);
    if (unit === 0x2a || unit === 0x3f || unit === 0x5b || unit === 0x5c) tokens++;
  }
  return tokens;
}
