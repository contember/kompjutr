import { utf8, utf8Decoder } from "../bytes.js";
import { GitError } from "../errors.js";
import { type ByteGlobPattern, compileByteGlob } from "../ignore/pattern.js";
import { retainedStringBytes } from "../retained.js";
import { comparePaths } from "../streams.js";

export const MAX_LS_FILES_PATTERNS = 256;
export const MAX_LS_FILES_PATTERN_BYTES = 2_200;
export const MAX_LS_FILES_INPUT_BYTES = 64 * 1024;
export const MAX_LS_FILES_WILDCARD_TOKENS = 4_096;
export const MAX_LS_FILES_SCAN_ROWS = 100_000;
export const MAX_LS_FILES_MATCHER_WORK = 32 * 1024 * 1024;
export const MAX_LS_FILES_RETAINED_BYTES = 16 * 1024 * 1024;
export const LS_FILES_RESULT_FIXED_BYTES = 128;
export const LS_FILES_INDEX_PAGE = 256;
export const MAX_LS_FILES_SCAN_PREFIXES = MAX_LS_FILES_PATTERNS * 2;
export const MAX_LS_FILES_SQL_STATEMENTS = 1_000;

// Source pages plus one terminal probe per literal prefix stay below the SQL budget.
const MAX_INDEX_SCAN_STATEMENTS =
  Math.ceil(MAX_LS_FILES_SCAN_ROWS / LS_FILES_INDEX_PAGE) + MAX_LS_FILES_SCAN_PREFIXES;
if (MAX_INDEX_SCAN_STATEMENTS > MAX_LS_FILES_SQL_STATEMENTS) {
  throw new Error("ls-files SQL bounds exceed the operation budget");
}

export interface LsFilesLimits {
  maxPatterns?: number;
  maxPatternBytes?: number;
  maxInputBytes?: number;
  maxWildcardTokens?: number;
  maxScanRows?: number;
  maxMatcherWork?: number;
  maxRetainedBytes?: number;
}

export interface LsFilesOptions {
  paths?: readonly string[];
  limits?: LsFilesLimits;
}

interface ResolvedLimits {
  maxPatterns: number;
  maxPatternBytes: number;
  maxInputBytes: number;
  maxWildcardTokens: number;
  maxScanRows: number;
  maxMatcherWork: number;
  maxRetainedBytes: number;
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

  constructor(
    all: boolean,
    patterns: readonly ReadPathspec[],
    scanPrefixes: readonly string[] | null,
    limits: ResolvedLimits,
  ) {
    this.#all = all;
    this.#patterns = patterns;
    this.scanPrefixes = scanPrefixes;
    this.#limits = limits;
  }

  /** Filter bounded source rows, deduplicate conflict stages, and restore Git byte order. */
  collect(rows: Iterable<string>): string[] {
    const unique = new Set<string>();
    const out: string[] = [];
    let scannedRows = 0;
    let matcherWork = 0;
    let retainedBytes = 0;

    for (const path of rows) {
      scannedRows++;
      if (scannedRows > this.#limits.maxScanRows) {
        throw tooBig("scan rows", this.#limits.maxScanRows);
      }
      if (unique.has(path)) continue;

      let matched = this.#all;
      if (!matched) {
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
      }
      if (!matched) continue;

      const additional = lsFilesResultRetainedBytes(path);
      if (additional > this.#limits.maxRetainedBytes - retainedBytes) {
        throw tooBig("retained result bytes", this.#limits.maxRetainedBytes);
      }
      retainedBytes += additional;
      unique.add(path);
      out.push(path);
    }

    out.sort(comparePaths);
    return out;
  }
}

export function compileReadPathspec(options?: LsFilesOptions): CompiledReadPathspec {
  const input = runtimeOptions(options);
  const limits = resolveLimits(input.limits);
  const paths = input.paths;
  if (paths === undefined || paths.length === 0) {
    return new CompiledReadPathspec(true, [], null, limits);
  }
  if (paths.length > limits.maxPatterns) throw tooBig("input patterns", limits.maxPatterns);

  const patterns: ReadPathspec[] = [];
  let all = false;
  let inputBytes = 0;
  let wildcardTokens = 0;

  for (let index = 0; index < paths.length; index++) {
    const raw = Reflect.get(paths, index);
    if (typeof raw !== "string") throw new GitError("EINVAL", "ls-files paths must be strings");
    if (raw === "") throw new GitError("EINVAL", "empty ls-files pathspec");
    if (raw.startsWith("/") || raw.startsWith(":")) throw unsupportedPathspec();

    if (raw.length > limits.maxPatternBytes) {
      throw tooBig("pattern bytes", limits.maxPatternBytes);
    }
    if (raw.length > limits.maxInputBytes - inputBytes) {
      throw tooBig("input bytes", limits.maxInputBytes);
    }
    const rawBytes = validatedUtf8Length(raw, limits.maxPatternBytes);
    if (rawBytes > limits.maxPatternBytes) {
      throw tooBig("pattern bytes", limits.maxPatternBytes);
    }
    if (rawBytes > limits.maxInputBytes - inputBytes) {
      throw tooBig("input bytes", limits.maxInputBytes);
    }
    inputBytes += rawBytes;

    const normalized = canonicalPathspec(raw);
    if (normalized === "." || normalized === "") {
      all = true;
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
    if (escaped) addLiteral(patterns, normalized);
    if (glob === null) continue;

    if (glob.literal === null) {
      patterns.push({ kind: "glob", pattern: glob });
      continue;
    }

    const decoded = utf8Decoder.decode(glob.literal);
    if (escaped) addExact(patterns, decoded);
    else if (addLiteral(patterns, decoded)) all = true;
  }

  const hasGlob = patterns.some((pattern) => pattern.kind === "glob");
  const scanPrefixes =
    all || hasGlob
      ? null
      : coalescedPaths(patterns.map((pattern) => (pattern.kind === "literal" ? pattern.path : "")));
  if (scanPrefixes !== null && scanPrefixes.length > MAX_LS_FILES_SCAN_PREFIXES) {
    throw tooBig("compiled scan prefixes", MAX_LS_FILES_SCAN_PREFIXES);
  }
  return new CompiledReadPathspec(all, patterns, scanPrefixes, limits);
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
    maxPatterns: boundedLimit(limitValue(limits, "maxPatterns"), MAX_LS_FILES_PATTERNS, "pattern"),
    maxPatternBytes: boundedLimit(
      limitValue(limits, "maxPatternBytes"),
      MAX_LS_FILES_PATTERN_BYTES,
      "pattern byte",
    ),
    maxInputBytes: boundedLimit(
      limitValue(limits, "maxInputBytes"),
      MAX_LS_FILES_INPUT_BYTES,
      "input byte",
    ),
    maxWildcardTokens: boundedLimit(
      limitValue(limits, "maxWildcardTokens"),
      MAX_LS_FILES_WILDCARD_TOKENS,
      "wildcard token",
    ),
    maxScanRows: boundedLimit(
      limitValue(limits, "maxScanRows"),
      MAX_LS_FILES_SCAN_ROWS,
      "scan row",
    ),
    maxMatcherWork: boundedLimit(
      limitValue(limits, "maxMatcherWork"),
      MAX_LS_FILES_MATCHER_WORK,
      "matcher work",
    ),
    maxRetainedBytes: boundedLimit(
      limitValue(limits, "maxRetainedBytes"),
      MAX_LS_FILES_RETAINED_BYTES,
      "retained byte",
    ),
  };
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

function coalescedPaths(paths: readonly string[]): string[] {
  const ordered = [...paths].sort(comparePaths);
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

function validatedUtf8Length(value: string, stopAfter: number): number {
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
    if (bytes > stopAfter) return bytes;
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
