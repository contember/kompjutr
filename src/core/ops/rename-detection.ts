// Bounded exact-identity rename pairing shared by status and diff.

import { isOid, utf8 } from "../bytes.js";
import { CorruptError, GitError } from "../errors.js";
import type { Repository } from "../repository.js";
import { comparePaths } from "../streams.js";

export const MAX_EXACT_RENAME_CANDIDATES = 10_000;
export const MAX_EXACT_RENAME_RETAINED_BYTES = 16 * 1024 * 1024;
const MAX_RENAME_PATH_BYTES = 2_200;
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
      retainedBytes: number;
    }
  | {
      kind: "fallback";
      renames: readonly [];
      candidateCount: number;
      retainedBytes: number;
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

/** Pair exact blob identities without reading objects or repository state. */
export function classifyExactRenames(
  deletions: Iterable<ExactRenameCandidate>,
  additions: Iterable<ExactRenameCandidate>,
  limits?: ExactRenameLimits,
): ExactRenameClassification {
  const resolved = resolveLimits(limits);
  const buckets = new Map<string, RenameBucket>();
  let candidateCount = 0;
  let retainedBytes = 0;

  const retain = (candidate: ExactRenameCandidate, side: "source" | "destination"): boolean => {
    const bytes = exactRenameCandidateRetainedBytes(candidate);
    candidateCount++;
    if (
      candidateCount > resolved.maxCandidates ||
      bytes > resolved.maxRetainedBytes - retainedBytes
    ) {
      return false;
    }
    retainedBytes += bytes;
    const key = `${candidate.oid}:${modeClass(candidate.mode)}`;
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = { sources: [], destinations: [] };
      buckets.set(key, bucket);
    }
    if (side === "source") bucket.sources.push(candidate);
    else bucket.destinations.push(candidate);
    return true;
  };

  for (const candidate of deletions) {
    if (!retain(candidate, "source")) {
      return { kind: "fallback", renames: [], candidateCount, retainedBytes };
    }
  }
  for (const candidate of additions) {
    if (!retain(candidate, "destination")) {
      return { kind: "fallback", renames: [], candidateCount, retainedBytes };
    }
  }

  const renames: ExactRename[] = [];
  for (const bucket of buckets.values()) pairBucket(bucket, renames);
  renames.sort((left, right) => comparePaths(left.destination.path, right.destination.path));
  return { kind: "classified", renames, candidateCount, retainedBytes };
}

/** Retained charge reserves the candidate plus its future basename index. */
export function exactRenameCandidateRetainedBytes(candidate: ExactRenameCandidate): number {
  validateCandidate(candidate);
  const pathBytes = utf8.encode(candidate.path).length;
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

function validateCandidate(candidate: ExactRenameCandidate): void {
  if (
    typeof candidate.path !== "string" ||
    candidate.path.length === 0 ||
    candidate.path.startsWith("/") ||
    candidate.path.endsWith("/") ||
    candidate.path.includes("\0") ||
    candidate.path
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new CorruptError("rename candidate path is invalid");
  }
  const pathBytes = utf8.encode(candidate.path).length;
  if (pathBytes > MAX_RENAME_PATH_BYTES) {
    throw new GitError(
      "E2BIG",
      `rename candidate path exceeds ${MAX_RENAME_PATH_BYTES} UTF-8 bytes`,
    );
  }
  modeClass(candidate.mode);
  if (!isOid(candidate.oid)) throw new CorruptError("rename candidate object id is invalid");
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
