import { isAbbreviatedOid, isOid } from "../../common/bytes.js";
import {
  CorruptError,
  GitError,
  ObjectNotFoundError,
  RefNotFoundError,
} from "../../common/errors.js";
import { type Commit, hashObject, parseReplayCommit, parseTag } from "../../common/objects.js";
import { PACK_BLOB_BATCH_TARGET_BYTES } from "../../store/index.js";
import { MAX_OPERATION_STEPS } from "../core/operation-state.js";
import type { Repository } from "../repository/repository.js";
import type { BoundedRevisionLabels } from "./replay-types.js";

export const MAX_REPLAY_REVISION_CODE_UNITS = 1_024;
export const MAX_REPLAY_REVISION_HOPS = 32;
export const MAX_REPLAY_TAG_HOPS = 16;
const MAX_REPLAY_PREFLIGHT_INPUT_OIDS = MAX_OPERATION_STEPS * 2 + 1;
const MAX_REPLAY_PREFLIGHT_UNIQUE_OIDS = MAX_OPERATION_STEPS + 2;
const MAX_REPLAY_PREFLIGHT_OIDS_PER_PAGE = 4_096;
export function requireBoundedRevision(value: unknown, labels: BoundedRevisionLabels): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new GitError("EINVAL", `${labels.input} revision is required`);
  }
  if (value.length > MAX_REPLAY_REVISION_CODE_UNITS) {
    throw new GitError(
      "E2BIG",
      `${labels.input} revision exceeds ${MAX_REPLAY_REVISION_CODE_UNITS} code units`,
    );
  }
  return value;
}

interface RevisionTraversal {
  hops: number;
  readonly commits: Set<string>;
}

export function readReplayCommit(repo: Repository, oid: string): Commit {
  const metadata = repo.store.typeAndSize(oid);
  if (metadata === null) throw new ObjectNotFoundError(oid);
  if (metadata.type !== "commit") {
    throw new CorruptError(`${oid} is a ${metadata.type}, not a commit`);
  }
  const object = repo.store.readAuthenticatedObject(oid, "commit");
  if (object === null) throw new ObjectNotFoundError(oid);
  if (object.type !== "commit") {
    throw new CorruptError(`${oid} is a ${object.type}, not a commit`);
  }
  if (object.data.length !== metadata.size || hashObject("commit", object.data) !== oid) {
    throw new CorruptError(`commit ${oid} does not match its authoritative object metadata`);
  }
  return parseReplayCommit(object.data);
}

/** Validate every source commit before a sequencer creates durable state. */
export function preflightReplayCommitObjects(
  repo: Repository,
  sourceOids: readonly string[],
): void {
  preflightReplayCommitObjectsInternal(repo, sourceOids);
}

function preflightReplayCommitObjectsInternal(
  repo: Repository,
  sourceOids: readonly string[],
): void {
  if (sourceOids.length > MAX_REPLAY_PREFLIGHT_INPUT_OIDS) {
    throw new GitError(
      "E2BIG",
      `replay commit preflight exceeds ${MAX_REPLAY_PREFLIGHT_INPUT_OIDS} inputs`,
    );
  }
  const unique = [...new Set(sourceOids)];
  if (unique.length > MAX_REPLAY_PREFLIGHT_UNIQUE_OIDS) {
    throw new GitError(
      "E2BIG",
      `replay commit preflight exceeds ${MAX_REPLAY_PREFLIGHT_UNIQUE_OIDS} commits`,
    );
  }
  const sizes = new Map<string, number>();
  for (let offset = 0; offset < unique.length; offset += MAX_REPLAY_PREFLIGHT_OIDS_PER_PAGE) {
    const count = Math.min(MAX_REPLAY_PREFLIGHT_OIDS_PER_PAGE, unique.length - offset);
    const page = unique.slice(offset, offset + count);
    const info = repo.store.objectInfo(page);
    for (let ordinal = 0; ordinal < info.length; ordinal++) {
      const object = info[ordinal];
      const oid = page[ordinal];
      if (object === undefined || oid === undefined || object.oid !== oid) {
        throw new CorruptError("replay commit preflight metadata is incomplete");
      }
      if (object.type !== "commit") throw new CorruptError(`${oid} is not a commit`);
      sizes.set(oid, object.size);
    }
  }
  for (let offset = 0; offset < unique.length; ) {
    let batchBytes = 0;
    let end = offset;
    const batchEnd = Math.min(unique.length, offset + MAX_REPLAY_PREFLIGHT_OIDS_PER_PAGE);
    while (end < batchEnd) {
      const oid = unique[end];
      if (oid === undefined) throw new CorruptError("replay commit preflight lost an object id");
      const size = sizes.get(oid);
      if (size === undefined) throw new CorruptError(`replay commit preflight lost ${oid}`);
      if (end > offset && size > PACK_BLOB_BATCH_TARGET_BYTES - batchBytes) break;
      batchBytes += size;
      end++;
    }
    const batchOids = unique.slice(offset, end);
    const batch = repo.readObjects(batchOids, { budgetBytes: Math.max(1, batchBytes) });
    if (batch.objects.size !== batchOids.length || batch.remaining.length !== 0) {
      throw new CorruptError("replay commit preflight made no progress");
    }
    for (const [oid, object] of batch.objects) {
      if (object.type !== "commit" || hashObject("commit", object.data) !== oid) {
        throw new CorruptError(`commit ${oid} failed authoritative replay preflight`);
      }
      parseReplayCommit(object.data);
    }
    offset = end;
  }
}

function peelCommit(repo: Repository, start: string, _operation: string): string {
  let oid = start;
  const seen = new Set<string>();
  for (let hops = 0; ; hops++) {
    if (seen.has(oid)) throw new CorruptError(`tag chain from ${start} contains a cycle`);
    seen.add(oid);
    const metadata = repo.store.objectInfo([oid])[0];
    if (metadata === undefined) throw new ObjectNotFoundError(oid);
    if (metadata.type === "commit" || metadata.type !== "tag") return oid;
    const object = repo.store.readAuthenticatedObject(oid, "tag");
    if (
      object === null ||
      object.data.length !== metadata.size ||
      hashObject("tag", object.data) !== oid
    ) {
      throw new CorruptError(`tag ${oid} does not match its authoritative object metadata`);
    }
    if (hops >= MAX_REPLAY_TAG_HOPS) {
      throw new GitError("E2BIG", `tag chain exceeds ${MAX_REPLAY_TAG_HOPS} hops`);
    }
    oid = parseTag(object.data).object;
  }
}

function resolveBase(repo: Repository, base: string): string {
  if (base === "") throw new RefNotFoundError(base);
  const viaRef = repo.resolveRef(base);
  if (viaRef !== null) return viaRef;
  if (isOid(base) && repo.has(base)) return base;
  if (isAbbreviatedOid(base)) {
    const resolved = repo.store.resolvePrefix(base);
    if (resolved !== null) return resolved;
  }
  throw new RefNotFoundError(base);
}

function revisionOrdinal(digits: string, operation: string): number {
  if (digits === "") return 1;
  let value = 0;
  for (let index = 0; index < digits.length; index++) {
    const digit = digits.charCodeAt(index) - 0x30;
    if (value > Math.floor((Number.MAX_SAFE_INTEGER - digit) / 10)) {
      throw new GitError("E2BIG", `${operation} revision ordinal exceeds the safe integer range`);
    }
    value = value * 10 + digit;
  }
  return value;
}

function parent(
  repo: Repository,
  oid: string,
  which: number,
  expression: string,
  traversal: RevisionTraversal,
  labels: BoundedRevisionLabels,
): string {
  if (traversal.hops >= MAX_REPLAY_REVISION_HOPS) {
    throw new GitError(
      "E2BIG",
      `${labels.operation} revision exceeds ${MAX_REPLAY_REVISION_HOPS} parent hops`,
    );
  }
  const commitOid = peelCommit(repo, oid, labels.operation);
  if (!traversal.commits.has(commitOid)) traversal.commits.add(commitOid);
  const next = readReplayCommit(repo, commitOid).parent[which - 1];
  if (next === undefined) throw new RefNotFoundError(expression);
  if (traversal.commits.has(next)) {
    throw new CorruptError(`revision ${expression} traverses a commit cycle`);
  }
  traversal.hops++;
  traversal.commits.add(next);
  return next;
}

export function resolveRevision(
  repo: Repository,
  expression: string,
  labels: BoundedRevisionLabels,
): string {
  const trimmed = expression.trim();
  if (trimmed === "") throw new RefNotFoundError(expression);
  let split = trimmed.length;
  for (let index = 0; index < trimmed.length; index++) {
    const unit = trimmed[index];
    if (unit === "^" || unit === "~") {
      split = index;
      break;
    }
  }
  let oid = resolveBase(repo, trimmed.slice(0, split));
  const suffix = trimmed.slice(split);
  const traversal: RevisionTraversal = { hops: 0, commits: new Set() };
  let position = 0;
  while (position < suffix.length) {
    const operator = suffix[position++];
    if (operator !== "^" && operator !== "~") throw new RefNotFoundError(expression);
    let digits = "";
    while (position < suffix.length) {
      const unit = suffix[position];
      if (unit === undefined || unit < "0" || unit > "9") break;
      digits += unit;
      position++;
    }
    const ordinal = revisionOrdinal(digits, labels.operation);
    if (operator === "^") {
      if (ordinal === 0) {
        oid = peelCommit(repo, oid, labels.operation);
      } else {
        oid = parent(repo, oid, ordinal, expression, traversal, labels);
      }
      continue;
    }
    if (ordinal > MAX_REPLAY_REVISION_HOPS - traversal.hops) {
      throw new GitError(
        "E2BIG",
        `${labels.operation} revision exceeds ${MAX_REPLAY_REVISION_HOPS} parent hops`,
      );
    }
    for (let hop = 0; hop < ordinal; hop++) {
      oid = parent(repo, oid, 1, expression, traversal, labels);
    }
  }
  return peelCommit(repo, oid, labels.operation);
}

/** Resolve and peel one revision through bounded, authoritative metadata reads. */
export function resolveBoundedCommitRevision(
  repo: Repository,
  value: unknown,
  labels: BoundedRevisionLabels,
): string {
  return resolveRevision(repo, requireBoundedRevision(value, labels), labels);
}
