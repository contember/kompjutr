// Pure one-commit replay planning shared by cherry-pick and revert.

import { MAX_INDEXED_COMMIT_BYTES } from "../../sqlite/commits.js";
import { isAbbreviatedOid, isOid } from "../bytes.js";
import type { TextMergeOptions } from "../diff/xmerge.js";
import { CorruptError, GitError, ObjectNotFoundError, RefNotFoundError } from "../errors.js";
import { type Commit, hashObject, parseCommit, parseTag } from "../objects.js";
import type { Repository } from "../repository.js";
import { type IntegrationLimits, type IntegrationPlan, planIntegration } from "./integration.js";

export const MAX_REPLAY_REVISION_CODE_UNITS = 1_024;
export const MAX_REPLAY_REVISION_HOPS = 32;
export const MAX_REPLAY_TAG_HOPS = 16;
// Covers bounded revision/tag peeling and authoritative commit-object reads.
export const MAX_REPLAY_METADATA_SQL_STATEMENTS = 256;

export type ReplayKind = "cherry-pick" | "revert";

export interface ReplayInput {
  kind: ReplayKind;
  source: string;
  currentOid: string;
  mainline?: number;
  text?: TextMergeOptions;
  limits?: IntegrationLimits;
  /** Use Git's sequencer label without changing the planner's default fixture labels. */
  sourceSubjectLabel?: boolean;
}

export interface ReplayLabels {
  current: string;
  base: string;
  incoming: string;
}

export interface ReplayPlan {
  kind: ReplayKind;
  sourceOid: string;
  sourceCommit: Commit;
  sourceTreeOid: string;
  selectedParentOid: string | null;
  selectedParentTreeOid: string | null;
  mainline: number | null;
  currentOid: string;
  currentCommit: Commit;
  currentTreeOid: string;
  baseTreeOid: string | null;
  incomingTreeOid: string | null;
  labels: ReplayLabels;
  integration: IntegrationPlan;
  /** Conservative metadata work, excluding the integration plan's own reads. */
  sqlStatements: number;
}

function requireRevision(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new GitError("EINVAL", "replay source revision is required");
  }
  if (value.length > MAX_REPLAY_REVISION_CODE_UNITS) {
    throw new GitError(
      "E2BIG",
      `replay source revision exceeds ${MAX_REPLAY_REVISION_CODE_UNITS} code units`,
    );
  }
  return value;
}

interface RevisionTraversal {
  hops: number;
  readonly commits: Set<string>;
}

function readCommit(repo: Repository, oid: string): Commit {
  const metadata = repo.store.typeAndSize(oid);
  if (metadata === null) throw new ObjectNotFoundError(oid);
  if (metadata.type !== "commit") {
    throw new CorruptError(`${oid} is a ${metadata.type}, not a commit`);
  }
  if (metadata.size > MAX_INDEXED_COMMIT_BYTES) {
    throw new CorruptError(`commit ${oid} exceeds the indexed commit size limit`);
  }
  const object = repo.read(oid);
  if (object.type !== "commit") {
    throw new CorruptError(`${oid} is a ${object.type}, not a commit`);
  }
  if (object.data.length !== metadata.size || hashObject("commit", object.data) !== oid) {
    throw new CorruptError(`commit ${oid} does not match its authoritative object metadata`);
  }
  return parseCommit(object.data);
}

function peelCommit(repo: Repository, start: string): string {
  let oid = start;
  const seen = new Set<string>();
  for (let hops = 0; ; hops++) {
    if (seen.has(oid)) throw new CorruptError(`tag chain from ${start} contains a cycle`);
    seen.add(oid);
    const metadata = repo.store.objectInfo([oid])[0];
    if (metadata === undefined) throw new ObjectNotFoundError(oid);
    if (metadata.type === "commit" || metadata.type !== "tag") return oid;
    if (metadata.size > MAX_INDEXED_COMMIT_BYTES) {
      throw new CorruptError(`tag ${oid} exceeds the replay metadata size limit`);
    }
    const object = repo.read(oid);
    if (
      object.type !== "tag" ||
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

function revisionOrdinal(digits: string): number {
  if (digits === "") return 1;
  let value = 0;
  for (let index = 0; index < digits.length; index++) {
    const digit = digits.charCodeAt(index) - 0x30;
    if (value > Math.floor((Number.MAX_SAFE_INTEGER - digit) / 10)) {
      throw new GitError("E2BIG", "replay revision ordinal exceeds the safe integer range");
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
): string {
  if (traversal.hops >= MAX_REPLAY_REVISION_HOPS) {
    throw new GitError("E2BIG", `replay revision exceeds ${MAX_REPLAY_REVISION_HOPS} parent hops`);
  }
  const commitOid = peelCommit(repo, oid);
  if (!traversal.commits.has(commitOid)) traversal.commits.add(commitOid);
  const next = readCommit(repo, commitOid).parent[which - 1];
  if (next === undefined) throw new RefNotFoundError(expression);
  if (traversal.commits.has(next)) {
    throw new CorruptError(`revision ${expression} traverses a commit cycle`);
  }
  traversal.hops++;
  traversal.commits.add(next);
  return next;
}

function resolveRevision(repo: Repository, expression: string): string {
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
    const ordinal = revisionOrdinal(digits);
    if (operator === "^") {
      if (ordinal === 0) {
        oid = peelCommit(repo, oid);
      } else {
        oid = parent(repo, oid, ordinal, expression, traversal);
      }
      continue;
    }
    if (ordinal > MAX_REPLAY_REVISION_HOPS - traversal.hops) {
      throw new GitError(
        "E2BIG",
        `replay revision exceeds ${MAX_REPLAY_REVISION_HOPS} parent hops`,
      );
    }
    for (let hop = 0; hop < ordinal; hop++) {
      oid = parent(repo, oid, 1, expression, traversal);
    }
  }
  return peelCommit(repo, oid);
}

function requireMainline(
  kind: ReplayKind,
  parentCount: number,
  value: number | undefined,
): number | null {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
    throw new GitError("EINVAL", "replay mainline must be a positive safe integer");
  }
  if (parentCount === 0) {
    if (value !== undefined) {
      throw new GitError("EINVAL", `${kind} of a root commit does not accept a mainline parent`);
    }
    return null;
  }
  if (parentCount === 1) {
    if (value !== undefined && value !== 1) {
      throw new GitError("EINVAL", `replay mainline ${value} is outside the source parent range`);
    }
    return value ?? null;
  }
  if (value === undefined) {
    throw new GitError("EINVAL", `${kind} of a merge commit requires a mainline parent`);
  }
  if (value > parentCount) {
    throw new GitError("EINVAL", `replay mainline ${value} is outside the source parent range`);
  }
  return value;
}

function shortOid(oid: string | null): string {
  return oid === null ? "empty tree" : oid.slice(0, 12);
}

function sourceSubject(message: string): string {
  const newline = message.indexOf("\n");
  return (newline < 0 ? message : message.slice(0, newline)).replace(/\r$/, "");
}

/** Resolve one source commit and build its bounded integration delta without mutating state. */
export function planReplay(repo: Repository, input: ReplayInput): ReplayPlan {
  const sourceRevision = requireRevision(input.source);
  if (!isOid(input.currentOid)) {
    throw new GitError("EINVAL", "replay current commit must be a full object id");
  }

  const currentCommit = readCommit(repo, input.currentOid);
  const sourceOid = resolveRevision(repo, sourceRevision);
  const sourceCommit = readCommit(repo, sourceOid);
  const mainline = requireMainline(input.kind, sourceCommit.parent.length, input.mainline);
  const selectedParentOid =
    sourceCommit.parent.length === 0 ? null : (sourceCommit.parent[(mainline ?? 1) - 1] ?? null);
  if (sourceCommit.parent.length > 0 && selectedParentOid === null) {
    throw new GitError("ECORRUPT", "replay selected parent is missing");
  }
  const selectedParentTreeOid =
    selectedParentOid === null ? null : readCommit(repo, selectedParentOid).tree;

  const baseTreeOid = input.kind === "cherry-pick" ? selectedParentTreeOid : sourceCommit.tree;
  const incomingTreeOid = input.kind === "cherry-pick" ? sourceCommit.tree : selectedParentTreeOid;
  const labels: ReplayLabels = {
    current: input.text?.labels?.current ?? "HEAD",
    base:
      input.text?.labels?.base ??
      shortOid(input.kind === "cherry-pick" ? selectedParentOid : sourceOid),
    incoming:
      input.text?.labels?.incoming ??
      (input.sourceSubjectLabel === true
        ? `${sourceOid.slice(0, 7)} (${sourceSubject(sourceCommit.message)})`
        : shortOid(input.kind === "cherry-pick" ? sourceOid : selectedParentOid)),
  };
  const integration = planIntegration(repo, {
    baseTreeOid,
    currentTreeOid: currentCommit.tree,
    incomingTreeOid,
    text: {
      ...input.text,
      labels,
    },
    limits: input.limits,
  });

  return {
    kind: input.kind,
    sourceOid,
    sourceCommit,
    sourceTreeOid: sourceCommit.tree,
    selectedParentOid,
    selectedParentTreeOid,
    mainline,
    currentOid: input.currentOid,
    currentCommit,
    currentTreeOid: currentCommit.tree,
    baseTreeOid,
    incomingTreeOid,
    labels,
    integration,
    sqlStatements: MAX_REPLAY_METADATA_SQL_STATEMENTS,
  };
}
