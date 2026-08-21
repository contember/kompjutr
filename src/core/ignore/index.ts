// `.gitignore` handling. Rules are loaded in bounded pages and evaluated in JS.

import type { RealPath, RegularFileHandle } from "../../fs/types.js";
import { relativeTo } from "../paths.js";
import type { Worktree } from "../worktree.js";
import {
  compareLiteralBytes,
  compilePatternBytes,
  encodePath,
  type IgnorePattern,
  matchPatternDepths,
  patternLimits,
  patternLiteral,
  patternMatchesNever,
} from "./pattern.js";

export type { IgnorePattern } from "./pattern.js";

export const IGNORE_LIMITS = {
  rawBytes: 1_000_000,
  fileBytes: 250_000,
  files: 1_024,
  patterns: 8_192,
  compiledBytes: 256_000,
  patternBytes: 4_096,
  nfaStates: 64,
  totalNfaStates: 4_096,
  wildcardSegments: 4_096,
  queryBytes: 16_384,
  querySegments: 128,
  matcherWork: 4_096,
  discoveryPage: 128,
  discoveryStatements: 8,
  readStatements: 8,
};

export type IgnoreLimitResource =
  | "rawBytes"
  | "fileBytes"
  | "files"
  | "patterns"
  | "compiledBytes"
  | "patternBytes"
  | "nfaStates"
  | "totalNfaStates"
  | "wildcardSegments"
  | "queryBytes"
  | "querySegments"
  | "matcherWork"
  | "discoveryStatements"
  | "readStatements";

/** A fail-closed resource limit from loading ignore rules. */
export class IgnoreLimitError extends Error {
  readonly code = "E2BIG";

  constructor(
    readonly resource: IgnoreLimitResource,
    readonly limit: number,
    readonly observed: number,
    readonly path?: string,
  ) {
    super(
      `E2BIG: .gitignore ${resource} exceeds ${limit}${path === undefined ? "" : ` at '${path}'`}`,
    );
    this.name = "IgnoreLimitError";
  }
}

class IgnoreLoadError extends Error {
  readonly code = "EIO";

  constructor(detail: string) {
    super(`EIO: invalid ignore loader result: ${detail}`);
    this.name = "IgnoreLoadError";
  }
}

class IgnoreBudget {
  rawBytes = 0;
  files = 0;
  patterns = 0;
  compiledBytes = 0;
  totalNfaStates = 0;
  wildcardSegments = 0;
  discoveryStatements = 0;
  readStatements = 0;

  addRaw(bytes: number, path?: string): void {
    const observed = this.rawBytes + bytes;
    if (observed > IGNORE_LIMITS.rawBytes) {
      throw new IgnoreLimitError("rawBytes", IGNORE_LIMITS.rawBytes, observed, path);
    }
    this.rawBytes = observed;
  }

  addFile(handle: RegularFileHandle): void {
    if (handle.size > IGNORE_LIMITS.fileBytes) {
      throw new IgnoreLimitError("fileBytes", IGNORE_LIMITS.fileBytes, handle.size, handle.path);
    }
    const observed = this.files + 1;
    if (observed > IGNORE_LIMITS.files) {
      throw new IgnoreLimitError("files", IGNORE_LIMITS.files, observed, handle.path);
    }
    this.files = observed;
    this.addRaw(handle.size, handle.path);
  }

  checkLine(bytes: number, path?: string): number {
    if (bytes > IGNORE_LIMITS.patternBytes) {
      throw new IgnoreLimitError("patternBytes", IGNORE_LIMITS.patternBytes, bytes, path);
    }
    return bytes;
  }

  addPattern(pattern: IgnorePattern, bytes: number, path?: string): void {
    const observed = this.patterns + 1;
    if (observed > IGNORE_LIMITS.patterns) {
      throw new IgnoreLimitError("patterns", IGNORE_LIMITS.patterns, observed, path);
    }
    this.patterns = observed;
    const compiledBytes = this.compiledBytes + bytes;
    if (compiledBytes > IGNORE_LIMITS.compiledBytes) {
      throw new IgnoreLimitError("compiledBytes", IGNORE_LIMITS.compiledBytes, compiledBytes, path);
    }
    this.compiledBytes = compiledBytes;
    const limits = patternLimits(pattern);
    if (limits.nfaStates > IGNORE_LIMITS.nfaStates) {
      throw new IgnoreLimitError("nfaStates", IGNORE_LIMITS.nfaStates, limits.nfaStates, path);
    }
    const totalNfaStates = this.totalNfaStates + limits.nfaStates;
    if (totalNfaStates > IGNORE_LIMITS.totalNfaStates) {
      throw new IgnoreLimitError(
        "totalNfaStates",
        IGNORE_LIMITS.totalNfaStates,
        totalNfaStates,
        path,
      );
    }
    this.totalNfaStates = totalNfaStates;
    const wildcardSegments = this.wildcardSegments + limits.wildcardSegments;
    if (wildcardSegments > IGNORE_LIMITS.wildcardSegments) {
      throw new IgnoreLimitError(
        "wildcardSegments",
        IGNORE_LIMITS.wildcardSegments,
        wildcardSegments,
        path,
      );
    }
    this.wildcardSegments = wildcardSegments;
  }

  beforeDiscovery(): void {
    const observed = this.discoveryStatements + 1;
    if (observed > IGNORE_LIMITS.discoveryStatements) {
      throw new IgnoreLimitError(
        "discoveryStatements",
        IGNORE_LIMITS.discoveryStatements,
        observed,
      );
    }
    this.discoveryStatements = observed;
  }

  beforeRead(): void {
    const observed = this.readStatements + 1;
    if (observed > IGNORE_LIMITS.readStatements) {
      throw new IgnoreLimitError("readStatements", IGNORE_LIMITS.readStatements, observed);
    }
    this.readStatements = observed;
  }
}

export interface IgnoreMatcher {
  /** Is this repo-relative path ignored? */
  ignores(path: string, isDirectory: boolean): boolean;
}

/** Nothing is ignored. For tests and for callers that opt out. */
export const includeEverything: IgnoreMatcher = {
  ignores: () => false,
};

export interface IgnoreOptions {
  /** Extra patterns applied at the repository root, lowest precedence. */
  extra?: string[];
}

const ENCODER = new TextEncoder();

function boundedUtf8Bytes(value: string, limit: number): number {
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

interface RuleSource {
  bytes: Uint8Array;
  depth: number;
  parent: RuleSource | null;
  basenames: ReadonlyMap<number, readonly IndexedRule[]>;
  paths: ReadonlyMap<number, readonly IndexedRule[]>;
  dynamic: readonly IndexedRule[];
}

interface IndexedRule {
  pattern: IgnorePattern;
  literal: Uint8Array;
  line: number;
}

const SOURCE_HASH_INITIAL = 0x811c9dc5;

export type IgnoreSourceHashStep = (hash: number, byte: number) => number;

function sourceHashStep(hash: number, byte: number): number {
  return Math.imul(hash ^ byte, 0x01000193) >>> 0;
}

function hashBytes(bytes: Uint8Array, start: number, end: number): number {
  let hash = SOURCE_HASH_INITIAL;
  for (let index = start; index < end; index++) {
    hash = sourceHashStep(hash, bytes[index] ?? 0);
  }
  return hash;
}

function addIndexed(map: Map<number, IndexedRule[]>, hash: number, rule: IndexedRule): void {
  const bucket = map.get(hash);
  if (bucket === undefined) map.set(hash, [rule]);
  else bucket.push(rule);
}

function compileRuleSource(
  bytes: Uint8Array,
  depth: number,
  patterns: readonly IgnorePattern[],
): RuleSource {
  const basenames = new Map<number, IndexedRule[]>();
  const paths = new Map<number, IndexedRule[]>();
  const dynamic: IndexedRule[] = [];
  for (let line = 0; line < patterns.length; line++) {
    const pattern = patterns[line];
    if (pattern === undefined) continue;
    if (patternMatchesNever(pattern)) continue;
    const literal = patternLiteral(pattern);
    if (literal === null) {
      dynamic.push({ pattern, literal: new Uint8Array(0), line });
      continue;
    }
    const rule = { pattern, literal: literal.bytes, line };
    addIndexed(
      literal.basename ? basenames : paths,
      hashBytes(literal.bytes, 0, literal.bytes.length),
      rule,
    );
  }
  return { bytes, depth, parent: null, basenames, paths, dynamic };
}

export interface IgnoreSourceIndexStats {
  sources: number;
  buckets: number;
  bucketEntries: number;
  sourceBytes: number;
  maxBucketEntries: number;
}

function sourceSuffixEqual(left: Uint8Array, right: Uint8Array, start: number): boolean {
  for (let index = start; index < right.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

class SourceIndex {
  readonly #buckets = new Map<number, RuleSource[]>();
  #sourceBytes = 0;
  #maxBucketEntries = 0;

  constructor(
    sources: readonly RuleSource[],
    private readonly hashStep: IgnoreSourceHashStep,
  ) {
    for (const source of sources) {
      let hash = SOURCE_HASH_INITIAL;
      for (const byte of source.bytes) hash = this.hashStep(hash, byte) >>> 0;
      const bucket = this.#buckets.get(hash);
      if (bucket === undefined) {
        this.#buckets.set(hash, [source]);
        this.#maxBucketEntries = Math.max(this.#maxBucketEntries, 1);
      } else {
        bucket.push(source);
        this.#maxBucketEntries = Math.max(this.#maxBucketEntries, bucket.length);
      }
      this.#sourceBytes += source.bytes.byteLength;
    }
  }

  applicable(bytes: Uint8Array, addWork: (amount: number) => void): RuleSource[] {
    const sources: RuleSource[] = [];
    const verified = new Set<RuleSource>();
    if (this.#buckets.size > 0) addWork(bytes.byteLength);
    let hash = SOURCE_HASH_INITIAL;
    for (let index = 0; index < bytes.byteLength; index++) {
      hash = this.hashStep(hash, bytes[index] ?? 0) >>> 0;
      if (bytes[index + 1] !== 0x2f) continue;
      const bucket = this.#buckets.get(hash);
      if (bucket === undefined) continue;
      for (const source of bucket) {
        const verifiedBytes =
          source.parent !== null && verified.has(source.parent)
            ? source.parent.bytes.byteLength
            : 0;
        addWork(source.bytes.byteLength - verifiedBytes);
        if (source.bytes.byteLength !== index + 1) continue;
        if (!sourceSuffixEqual(bytes, source.bytes, verifiedBytes)) continue;
        sources.push(source);
        verified.add(source);
      }
    }
    return sources;
  }

  stats(): IgnoreSourceIndexStats {
    let bucketEntries = 0;
    for (const bucket of this.#buckets.values()) bucketEntries += bucket.length;
    return {
      sources: bucketEntries,
      buckets: this.#buckets.size,
      bucketEntries,
      sourceBytes: this.#sourceBytes,
      maxBucketEntries: this.#maxBucketEntries,
    };
  }
}

export class WorktreeIgnoreMatcher implements IgnoreMatcher {
  readonly #rootSource: RuleSource | null;
  readonly #sourceIndex: SourceIndex;
  readonly #extraSource: RuleSource;

  constructor(
    rules: ReadonlyMap<string, IgnorePattern[]>,
    extra: readonly IgnorePattern[],
    hashStep: IgnoreSourceHashStep = sourceHashStep,
  ) {
    this.#extraSource = compileRuleSource(new Uint8Array(0), 0, extra);
    let rootSource: RuleSource | null = null;
    const sources: RuleSource[] = [];
    const sourceDirectories: { directory: string; source: RuleSource }[] = [];
    const sourcesByDirectory = new Map<string, RuleSource>();
    for (const [directory, patterns] of rules) {
      const bytes = ENCODER.encode(directory);
      let depth = 0;
      for (const byte of bytes) if (byte === 0x2f) depth++;
      if (bytes.length > 0) depth++;
      const source = compileRuleSource(bytes, depth, patterns);
      if (bytes.length === 0) rootSource = source;
      else {
        sources.push(source);
        sourceDirectories.push({ directory, source });
        sourcesByDirectory.set(directory, source);
      }
    }
    for (const entry of sourceDirectories) {
      let slash = entry.directory.lastIndexOf("/");
      while (slash >= 0) {
        const parent = sourcesByDirectory.get(entry.directory.slice(0, slash));
        if (parent !== undefined) {
          entry.source.parent = parent;
          break;
        }
        slash = entry.directory.lastIndexOf("/", slash - 1);
      }
    }
    this.#rootSource = rootSource;
    this.#sourceIndex = new SourceIndex(sources, hashStep);
  }

  sourceIndexStats(): IgnoreSourceIndexStats {
    return this.#sourceIndex.stats();
  }

  ignores(path: string, isDirectory: boolean): boolean {
    if (path === "") return false;
    const queryBytes = boundedUtf8Bytes(path, IGNORE_LIMITS.queryBytes);
    if (queryBytes > IGNORE_LIMITS.queryBytes) {
      throw new IgnoreLimitError("queryBytes", IGNORE_LIMITS.queryBytes, queryBytes);
    }
    const encoded = encodePath(path, IGNORE_LIMITS.querySegments);
    if (encoded.segments > IGNORE_LIMITS.querySegments) {
      throw new IgnoreLimitError("querySegments", IGNORE_LIMITS.querySegments, encoded.segments);
    }

    let work = 0;
    const addWork = (amount: number): void => {
      const observed = work + amount;
      if (observed > IGNORE_LIMITS.matcherWork) {
        throw new IgnoreLimitError("matcherWork", IGNORE_LIMITS.matcherWork, observed);
      }
      work = observed;
    };
    if (this.#extraSource.paths.size > 0) addWork(encoded.bytes.byteLength);
    const applicable: RuleSource[] = [];
    if (this.#rootSource !== null) applicable.push(this.#rootSource);
    applicable.push(...this.#sourceIndex.applicable(encoded.bytes, addWork));
    for (const source of applicable) {
      const relativeBytes = encoded.bytes.byteLength - source.bytes.byteLength;
      if (source.paths.size > 0) addWork(relativeBytes);
    }
    const segmentHashes = new Uint32Array(encoded.segments);
    if (
      this.#extraSource.basenames.size > 0 ||
      applicable.some((source) => source.basenames.size > 0)
    ) {
      addWork(encoded.bytes.byteLength);
      for (let depth = 1; depth <= encoded.segments; depth++) {
        segmentHashes[depth - 1] = hashBytes(
          encoded.bytes,
          encoded.starts[depth - 1] ?? 0,
          encoded.ends[depth - 1] ?? 0,
        );
      }
    }

    const decisions = new Uint8Array(encoded.segments);
    const sourceRanks = new Uint16Array(encoded.segments);
    const lineRanks = new Uint16Array(encoded.segments);
    const decide = (rule: IndexedRule, depth: number, sourceRank: number): void => {
      if (rule.pattern.directoryOnly && depth === encoded.segments && !isDirectory) return;
      const lineRank = rule.line + 1;
      const currentSource = sourceRanks[depth - 1] ?? 0;
      const currentLine = lineRanks[depth - 1] ?? 0;
      if (sourceRank < currentSource || (sourceRank === currentSource && lineRank < currentLine)) {
        return;
      }
      sourceRanks[depth - 1] = sourceRank;
      lineRanks[depth - 1] = lineRank;
      decisions[depth - 1] = rule.pattern.negated ? 1 : 2;
    };
    const apply = (source: RuleSource, sourceRank: number): void => {
      for (const rule of source.dynamic) {
        const patternWork = matchPatternDepths(
          rule.pattern,
          encoded,
          source.depth,
          isDirectory,
          (depth) => {
            decide(rule, depth, sourceRank);
          },
          IGNORE_LIMITS.matcherWork - work,
        );
        addWork(patternWork);
      }
      if (source.basenames.size > 0) {
        for (let depth = source.depth + 1; depth <= encoded.segments; depth++) {
          const start = encoded.starts[depth - 1] ?? 0;
          const end = encoded.ends[depth - 1] ?? 0;
          const bucket = source.basenames.get(segmentHashes[depth - 1] ?? 0);
          if (bucket === undefined) continue;
          for (const rule of bucket) {
            const compared = compareLiteralBytes(
              encoded.bytes,
              start,
              end,
              rule.literal,
              IGNORE_LIMITS.matcherWork - work,
            );
            addWork(compared.work);
            if (compared.matched) decide(rule, depth, sourceRank);
          }
        }
      }
      if (source.paths.size > 0) {
        const start = encoded.starts[source.depth] ?? 0;
        let hash = SOURCE_HASH_INITIAL;
        let at = start;
        for (let depth = source.depth + 1; depth <= encoded.segments; depth++) {
          const end = encoded.ends[depth - 1] ?? 0;
          while (at < end) {
            hash = sourceHashStep(hash, encoded.bytes[at] ?? 0);
            at++;
          }
          const bucket = source.paths.get(hash);
          if (bucket === undefined) continue;
          for (const rule of bucket) {
            const compared = compareLiteralBytes(
              encoded.bytes,
              start,
              end,
              rule.literal,
              IGNORE_LIMITS.matcherWork - work,
            );
            addWork(compared.work);
            if (compared.matched) decide(rule, depth, sourceRank);
          }
        }
      }
    };
    let sourceRank = 1;
    apply(this.#extraSource, sourceRank++);
    for (const source of applicable) apply(source, sourceRank++);

    for (let depth = 1; depth <= encoded.segments; depth++) {
      if (decisions[depth - 1] === 2) return true;
    }
    return false;
  }
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
  worktree: Worktree,
  root: RealPath,
  handles: readonly RegularFileHandle[],
  budget: IgnoreBudget,
  rules: Map<string, IgnorePattern[]>,
): void {
  let remaining = [...handles];
  while (remaining.length > 0) {
    budget.beforeRead();
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

function loadRules(
  worktree: Worktree,
  root: string,
  extraSources: readonly string[],
): { rules: Map<string, IgnorePattern[]>; extra: IgnorePattern[] } {
  const budget = new IgnoreBudget();
  const extra = compileExtra(extraSources, budget);
  const canonicalRoot = worktree.realpath(root);
  const rules = new Map<string, IgnorePattern[]>();
  const cursors = new Set<RealPath>();
  let after: RealPath | undefined;

  for (;;) {
    budget.beforeDiscovery();
    const page = worktree.discoverFiles(canonicalRoot, "*/.gitignore", {
      after,
      limit: IGNORE_LIMITS.discoveryPage,
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

export function loadIgnoreMatcher(
  worktree: Worktree,
  root: string,
  options: IgnoreOptions = {},
): IgnoreMatcher {
  const loaded = loadRules(worktree, root, options.extra ?? []);
  return new WorktreeIgnoreMatcher(loaded.rules, loaded.extra);
}
