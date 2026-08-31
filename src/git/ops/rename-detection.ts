// Bounded exact-identity rename pairing shared by status and diff.

import { isOid } from "../common/bytes.js";
import { CorruptError, GitError } from "../common/errors.js";
import { comparePaths } from "../common/streams.js";
import type { Repository } from "./repository.js";

export const MAX_EXACT_RENAME_CANDIDATES = 10_000;
export const MAX_EXACT_RENAME_RETAINED_BYTES = 16 * 1024 * 1024;
const RENAME_CANDIDATE_FIXED_BYTES = 256;
const RENAME_CONFIG_BYTES = 16;
const TRUE_CONFIG_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_CONFIG_VALUES = new Set(["", "0", "false", "no", "off"]);

export interface ExactRenameCandidate {
  path: string;
  mode: string;
  oid: string;
}

export interface ExactRename {
  source: ExactRenameCandidate;
  destination: ExactRenameCandidate;
  similarity: 100;
}

export interface ExactRenameLimits {
  maxCandidates?: number;
  maxRetainedBytes?: number;
}

export type ExactRenameClassification =
  | {
      kind: "classified";
      renames: readonly ExactRename[];
      candidateCount: number;
    }
  | {
      kind: "fallback";
      renames: readonly [];
      candidateCount: number;
    };

interface RenameBucket {
  sources: ExactRenameCandidate[];
  destinations: ExactRenameCandidate[];
}

interface BasenameBucket {
  sources: ExactRenameCandidate[];
  ordinal: number;
}

interface ResolvedRenameLimits {
  maxCandidates: number;
  maxRetainedBytes: number;
}

/** Resolve explicit option > command config > Git's enabled-by-default policy. */
export function renameDetectionEnabled(
  repo: Repository,
  command: "status" | "diff",
  explicit: boolean | undefined,
): boolean {
  if (explicit !== undefined) return explicit;
  const path = `${command}.renames`;
  const configured = repo.store.configGetBounded(path, RENAME_CONFIG_BYTES);
  if (configured === undefined) return true;
  const normalized = configured.trim().toLowerCase();
  if (normalized === "copies" || TRUE_CONFIG_VALUES.has(normalized)) return true;
  if (FALSE_CONFIG_VALUES.has(normalized)) return false;
  throw new GitError("EINVAL", `config ${path} has invalid boolean value ${configured}`);
}

/** Incremental form for one bounded identity prepass. */
export class ExactRenameClassifier {
  readonly #limits: ResolvedRenameLimits;
  readonly #buckets = new Map<string, RenameBucket>();
  #candidateCount = 0;
  #retainedBytes = 0;
  #fallback = false;

  constructor(limits?: ExactRenameLimits) {
    this.#limits = resolveLimits(limits);
  }

  addSource(candidate: ExactRenameCandidate): boolean {
    return this.#retain(candidate, "source");
  }

  addDestination(candidate: ExactRenameCandidate): boolean {
    return this.#retain(candidate, "destination");
  }

  finish(): ExactRenameClassification {
    if (this.#fallback) {
      return {
        kind: "fallback",
        renames: [],
        candidateCount: this.#candidateCount,
      };
    }
    const renames: ExactRename[] = [];
    for (const bucket of this.#buckets.values()) pairBucket(bucket, renames);
    renames.sort((left, right) => comparePaths(left.destination.path, right.destination.path));
    return {
      kind: "classified",
      renames,
      candidateCount: this.#candidateCount,
    };
  }

  #retain(candidate: ExactRenameCandidate, side: "source" | "destination"): boolean {
    if (this.#fallback) return false;
    const bytes = exactRenameCandidateRetainedBytes(candidate);
    this.#candidateCount++;
    if (
      this.#candidateCount > this.#limits.maxCandidates ||
      bytes > this.#limits.maxRetainedBytes - this.#retainedBytes
    ) {
      this.#fallback = true;
      return false;
    }
    this.#retainedBytes += bytes;
    const key = `${candidate.oid}:${modeClass(candidate.mode)}`;
    let bucket = this.#buckets.get(key);
    if (bucket === undefined) {
      bucket = { sources: [], destinations: [] };
      this.#buckets.set(key, bucket);
    }
    if (side === "source") bucket.sources.push(candidate);
    else bucket.destinations.push(candidate);
    return true;
  }
}

/** Pair exact blob identities without reading objects or repository state. */
export function classifyExactRenames(
  deletions: Iterable<ExactRenameCandidate>,
  additions: Iterable<ExactRenameCandidate>,
  limits?: ExactRenameLimits,
): ExactRenameClassification {
  const classifier = new ExactRenameClassifier(limits);
  for (const candidate of deletions) {
    if (!classifier.addSource(candidate)) return classifier.finish();
  }
  for (const candidate of additions) {
    if (!classifier.addDestination(candidate)) return classifier.finish();
  }
  return classifier.finish();
}

/** Retained charge reserves the candidate plus its future basename index. */
export function exactRenameCandidateRetainedBytes(candidate: ExactRenameCandidate): number {
  const pathBytes = validateCandidate(candidate);
  return RENAME_CANDIDATE_FIXED_BYTES + pathBytes * 2;
}

function pairBucket(bucket: RenameBucket, output: ExactRename[]): void {
  bucket.sources.sort((left, right) => comparePaths(left.path, right.path));
  bucket.destinations.sort((left, right) => comparePaths(left.path, right.path));
  const byBasename = new Map<string, BasenameBucket>();
  for (const source of bucket.sources) {
    const basename = basenameOf(source.path);
    const matching = byBasename.get(basename);
    if (matching === undefined) byBasename.set(basename, { sources: [source], ordinal: 0 });
    else matching.sources.push(source);
  }

  const used = new Set<string>();
  let sourceOrdinal = 0;
  // Git does not reserve a source for a later destination's basename match.
  for (const destination of bucket.destinations) {
    const basenameMatches = byBasename.get(basenameOf(destination.path));
    let source: ExactRenameCandidate | undefined;
    while (
      basenameMatches !== undefined &&
      source === undefined &&
      basenameMatches.ordinal < basenameMatches.sources.length
    ) {
      const candidate = basenameMatches.sources[basenameMatches.ordinal++];
      if (candidate !== undefined && !used.has(candidate.path)) source = candidate;
    }
    while (source === undefined && sourceOrdinal < bucket.sources.length) {
      const candidate = bucket.sources[sourceOrdinal++];
      if (candidate !== undefined && !used.has(candidate.path)) source = candidate;
    }
    if (source === undefined) break;
    used.add(source.path);
    output.push({ source, destination, similarity: 100 });
  }
}

function validateCandidate(candidate: ExactRenameCandidate): number {
  if (typeof candidate.path !== "string") {
    throw new CorruptError("rename candidate path is invalid");
  }
  const pathBytes = validatePathAndCountUtf8(candidate.path);
  modeClass(candidate.mode);
  if (!isOid(candidate.oid)) throw new CorruptError("rename candidate object id is invalid");
  return pathBytes;
}

function validatePathAndCountUtf8(path: string): number {
  let bytes = 0;
  let segmentStart = 0;
  for (let index = 0; index <= path.length; index++) {
    if (index === path.length || path.charCodeAt(index) === 0x2f) {
      const length = index - segmentStart;
      if (
        length === 0 ||
        (length === 1 && path.charCodeAt(segmentStart) === 0x2e) ||
        (length === 2 &&
          path.charCodeAt(segmentStart) === 0x2e &&
          path.charCodeAt(segmentStart + 1) === 0x2e)
      ) {
        throw new CorruptError("rename candidate path is invalid");
      }
      if (index < path.length) bytes++;
      segmentStart = index + 1;
      continue;
    }
    const unit = path.charCodeAt(index);
    if (unit === 0) throw new CorruptError("rename candidate path is invalid");
    if (unit < 0x80) bytes++;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = path.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        index++;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
  }
  return bytes;
}

function modeClass(mode: string): "regular" | "symlink" {
  if (mode === "100644" || mode === "100755") return "regular";
  if (mode === "120000") return "symlink";
  throw new CorruptError("rename candidate mode is invalid");
}

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function resolveLimits(limits: ExactRenameLimits | undefined): ResolvedRenameLimits {
  return {
    maxCandidates: boundedLimit(limits?.maxCandidates, MAX_EXACT_RENAME_CANDIDATES, "candidate"),
    maxRetainedBytes: boundedLimit(
      limits?.maxRetainedBytes,
      MAX_EXACT_RENAME_RETAINED_BYTES,
      "retained byte",
    ),
  };
}

function boundedLimit(value: number | undefined, ceiling: number, label: string): number {
  if (value === undefined) return ceiling;
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {
    throw new RangeError(`invalid exact-rename ${label} limit`);
  }
  return value;
}
