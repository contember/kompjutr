import { IGNORE_LIMITS, IgnoreLimitError } from "./limits.js";
import {
  compareLiteralBytes,
  encodePath,
  type IgnorePattern,
  matchPatternDepths,
  patternLiteral,
  patternMatchesNever,
} from "./pattern.js";
import { boundedUtf8Bytes } from "./source.js";

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
const ENCODER = new TextEncoder();

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

export interface IgnoreMatcher {
  /** Is this repo-relative path ignored? */
  ignores(path: string, isDirectory: boolean): boolean;
}

/** Nothing is ignored. For tests and for callers that opt out. */
export const includeEverything: IgnoreMatcher = {
  ignores: () => false,
};

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
