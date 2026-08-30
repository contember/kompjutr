// Pure one-commit replay planning shared by cherry-pick and revert.

import type { MemoryReservation } from "../../memory.js";
import { MAX_INDEXED_COMMIT_BYTES } from "../../sqlite/commits.js";
import { type IndexEntry, type IndexStore, MAX_BLOB_BATCH_BYTES } from "../../sqlite/store.js";
import { isAbbreviatedOid, isOid } from "../bytes.js";
import type { TextMergeOptions } from "../diff/xmerge.js";
import { CorruptError, GitError, ObjectNotFoundError, RefNotFoundError } from "../errors.js";
import { type Commit, hashObject, MODE_COMMIT, parseReplayCommit, parseTag } from "../objects.js";
import type { Repository } from "../repository.js";
import { retainedStringBytes } from "../retained.js";
import { joinSorted } from "../streams.js";
import { indexFromTree } from "./checkout.js";
import {
  type IntegrationConflictKind,
  type IntegrationLimits,
  type IntegrationPlan,
  MAX_INTEGRATION_SOURCE_ROWS,
  planIntegration,
} from "./integration.js";
import type { IntegrationStages } from "./integration-structure.js";
import {
  projectedTouchedShape,
  requireBoundedIntegrationTree,
  reserveIntegrationPlan,
} from "./integration-worktree.js";
import { applyProjectedIndex, validateProjectedIndexEntries } from "./merge-apply.js";
import { type ProjectedMergeEntry, projectMergePlan } from "./merge-projection.js";
import { MAX_OPERATION_STEPS } from "./operation-state.js";
import { writeTree } from "./plumbing.js";

export const MAX_REPLAY_REVISION_CODE_UNITS = 1_024;
export const MAX_REPLAY_REVISION_HOPS = 32;
export const MAX_REPLAY_TAG_HOPS = 16;
export const MAX_REPLAY_PREFLIGHT_BYTES = 32 * 1024 * 1024;
export const REPLAY_PREFLIGHT_HEADROOM_BYTES = 16 * 1024 * 1024;
export const MAX_REPLAY_PLAN_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_REPLAY_PREFLIGHT_INPUT_OIDS = MAX_OPERATION_STEPS * 2 + 1;
const MAX_REPLAY_PREFLIGHT_UNIQUE_OIDS = MAX_OPERATION_STEPS + 2;
const MAX_REPLAY_PREFLIGHT_OIDS_PER_PAGE = 4_096;

export type ReplayKind = "cherry-pick" | "revert";
export type ReplayIncomingLabelStyle = "tree" | "source-subject" | "parent-of-source-subject";

export interface ReplayInput {
  kind: ReplayKind;
  source: string;
  currentOid: string;
  mainline?: number;
  text?: TextMergeOptions;
  limits?: IntegrationLimits;
  /** Select Git's command-specific sequencer label or the planner's tree label. */
  incomingLabelStyle?: ReplayIncomingLabelStyle;
  /** Caller-owned bytes retained while integration planning runs. */
  integrationCallerRetainedBytes?: number;
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
  /** Replay metadata retained beside the integration plan. */
  retainedBytes: number;
}

export interface ReplaySnapshotOptions {
  snapshot: string;
  onto: string;
}

export interface ReplaySnapshotConflictStage {
  stage: 1 | 2 | 3;
  mode: string;
  oid: string;
}

export interface ReplaySnapshotConflict {
  path: string;
  kind: IntegrationConflictKind;
  stages: readonly ReplaySnapshotConflictStage[];
}

export type ReplaySnapshotResult =
  | { outcome: "clean"; tree: string }
  | { outcome: "conflicted"; conflicts: readonly ReplaySnapshotConflict[] };

export const MAX_SNAPSHOT_REPLAY_SOURCE_ROWS = MAX_INTEGRATION_SOURCE_ROWS;
const SNAPSHOT_OBJECT_INFO_PAGE = 4_096;

export interface FixedReplayStepInput {
  sourceOid: string;
  selectedParentOid: string | null;
  currentOid: string;
  callerRetainedBytes?: number;
  limits?: IntegrationLimits;
}

export interface BoundedRevisionLabels {
  input: string;
  operation: string;
}

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

function checkedRetainedAdd(total: number, bytes: number): number {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > Number.MAX_SAFE_INTEGER - total) {
    throw new GitError("E2BIG", "replay metadata retained-byte accounting overflow");
  }
  return total + bytes;
}

function commitRetainedBytes(commit: Commit): number {
  let bytes = 768;
  for (const value of [
    commit.tree,
    ...commit.parent,
    commit.author.name,
    commit.author.email,
    commit.committer.name,
    commit.committer.email,
    commit.gpgsig ?? "",
    commit.message,
  ]) {
    bytes = checkedRetainedAdd(bytes, retainedStringBytes(value));
  }
  return bytes;
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
  return parseReplayCommit(object.data);
}

export interface ReplayCommitPreflight {
  bytes: number;
}

/** Validate every source commit before a sequencer creates durable state. */
export function preflightReplayCommitObjects(
  repo: Repository,
  sourceOids: readonly string[],
): ReplayCommitPreflight {
  const reservation = repo.store.reserveMemory();
  reservation.set("other", REPLAY_PREFLIGHT_HEADROOM_BYTES);
  try {
    return preflightReplayCommitObjectsInternal(repo, sourceOids);
  } finally {
    reservation.dispose();
  }
}

function preflightReplayCommitObjectsInternal(
  repo: Repository,
  sourceOids: readonly string[],
): ReplayCommitPreflight {
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
  let bytes = 0;
  for (let offset = 0; offset < unique.length; offset += MAX_REPLAY_PREFLIGHT_OIDS_PER_PAGE) {
    const page = unique.slice(offset, offset + MAX_REPLAY_PREFLIGHT_OIDS_PER_PAGE);
    const info = repo.store.objectInfo(page);
    for (let ordinal = 0; ordinal < info.length; ordinal++) {
      const object = info[ordinal];
      const oid = page[ordinal];
      if (object === undefined || oid === undefined || object.oid !== oid) {
        throw new CorruptError("replay commit preflight metadata is incomplete");
      }
      if (object.type !== "commit") throw new CorruptError(`${oid} is not a commit`);
      if (object.size > MAX_INDEXED_COMMIT_BYTES) {
        throw new CorruptError(`commit ${oid} exceeds the indexed commit size limit`);
      }
      if (object.size > MAX_REPLAY_PREFLIGHT_BYTES - bytes) {
        throw new GitError(
          "E2BIG",
          `replay source commits exceed ${MAX_REPLAY_PREFLIGHT_BYTES} bytes`,
        );
      }
      bytes += object.size;
    }
  }
  for (let offset = 0; offset < unique.length; offset += MAX_REPLAY_PREFLIGHT_OIDS_PER_PAGE) {
    let remaining = unique.slice(offset, offset + MAX_REPLAY_PREFLIGHT_OIDS_PER_PAGE);
    while (remaining.length > 0) {
      const batch = repo.readObjects(remaining, { budgetBytes: MAX_BLOB_BATCH_BYTES });
      if (batch.objects.size === 0 || batch.remaining.length >= remaining.length) {
        throw new CorruptError("replay commit preflight made no progress");
      }
      for (const [oid, object] of batch.objects) {
        if (
          object.type !== "commit" ||
          object.data.length > MAX_INDEXED_COMMIT_BYTES ||
          hashObject("commit", object.data) !== oid
        ) {
          throw new CorruptError(`commit ${oid} failed authoritative replay preflight`);
        }
        parseReplayCommit(object.data);
      }
      remaining = batch.remaining;
    }
  }
  return { bytes };
}

function peelCommit(repo: Repository, start: string, operation: string): string {
  let oid = start;
  const seen = new Set<string>();
  for (let hops = 0; ; hops++) {
    if (seen.has(oid)) throw new CorruptError(`tag chain from ${start} contains a cycle`);
    seen.add(oid);
    const metadata = repo.store.objectInfo([oid])[0];
    if (metadata === undefined) throw new ObjectNotFoundError(oid);
    if (metadata.type === "commit" || metadata.type !== "tag") return oid;
    if (metadata.size > MAX_INDEXED_COMMIT_BYTES) {
      throw new CorruptError(`tag ${oid} exceeds the ${operation} metadata size limit`);
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
  const next = readCommit(repo, commitOid).parent[which - 1];
  if (next === undefined) throw new RefNotFoundError(expression);
  if (traversal.commits.has(next)) {
    throw new CorruptError(`revision ${expression} traverses a commit cycle`);
  }
  traversal.hops++;
  traversal.commits.add(next);
  return next;
}

function resolveRevision(
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
  let start = 0;
  while (message.charCodeAt(start) === 0x0a) start++;
  const newline = message.indexOf("\n", start);
  return (newline < 0 ? message.slice(start) : message.slice(start, newline)).replace(/\r$/, "");
}

function incomingLabel(
  style: ReplayIncomingLabelStyle,
  kind: ReplayKind,
  sourceOid: string,
  selectedParentOid: string | null,
  sourceMessage: string,
): string {
  if (style === "source-subject") {
    return `${sourceOid.slice(0, 7)} (${sourceSubject(sourceMessage)})`;
  }
  if (style === "parent-of-source-subject") {
    return `parent of ${sourceOid.slice(0, 7)} (${sourceSubject(sourceMessage)})`;
  }
  return shortOid(kind === "cherry-pick" ? sourceOid : selectedParentOid);
}

/** Resolve one source commit and build its bounded integration delta without mutating state. */
export function planReplay(repo: Repository, input: ReplayInput): ReplayPlan {
  return planReplayInternal(repo, input, null);
}

function requireSnapshotTreesWithoutGitlinks(repo: Repository, plan: ReplayPlan): void {
  const trees = new Set([plan.selectedParentTreeOid, plan.sourceTreeOid, plan.currentTreeOid]);
  trees.delete(null);
  let rows = 0;
  for (const tree of trees) {
    if (tree === null) continue;
    for (const { path, entry } of repo.walkTree(tree)) {
      if (rows >= MAX_SNAPSHOT_REPLAY_SOURCE_ROWS) {
        throw new GitError(
          "E2BIG",
          `snapshot replay tree scan exceeds ${MAX_SNAPSHOT_REPLAY_SOURCE_ROWS} rows`,
        );
      }
      rows++;
      if (entry.mode === MODE_COMMIT) {
        throw new GitError("EUNSUPPORTED", `snapshot replay rejects gitlink ${path}`);
      }
    }
  }
}

function conflictStages(stagesBySide: IntegrationStages): ReplaySnapshotConflictStage[] {
  const stages: ReplaySnapshotConflictStage[] = [];
  if (stagesBySide.base !== null) {
    stages.push({ stage: 1, mode: stagesBySide.base.mode, oid: stagesBySide.base.oid });
  }
  if (stagesBySide.current !== null) {
    stages.push({ stage: 2, mode: stagesBySide.current.mode, oid: stagesBySide.current.oid });
  }
  if (stagesBySide.incoming !== null) {
    stages.push({ stage: 3, mode: stagesBySide.incoming.mode, oid: stagesBySide.incoming.oid });
  }
  return stages;
}

function snapshotConflicts(
  plan: IntegrationPlan,
  projected: readonly ProjectedMergeEntry[],
): ReplaySnapshotConflict[] {
  const kinds = new Map<string, IntegrationConflictKind>();
  for (const entry of plan.entries) {
    if (entry.kind === "conflict") kinds.set(entry.path, entry.conflict);
  }
  const conflicts: ReplaySnapshotConflict[] = [];
  for (const entry of projected) {
    if (entry.stages === null) continue;
    const kind = kinds.get(entry.logicalPath);
    if (kind === undefined) {
      throw new CorruptError(`projected conflict ${entry.path} lost its logical conflict kind`);
    }
    conflicts.push({ path: entry.path, kind, stages: conflictStages(entry.stages) });
  }
  return conflicts;
}

function* prospectiveSnapshotIndex(
  repo: Repository,
  currentTreeOid: string,
  projected: readonly ProjectedMergeEntry[],
): Generator<IndexEntry> {
  const owned = new Set(projectedTouchedShape(projected).map((entry) => entry.path));
  for (const row of joinSorted(indexFromTree(repo, currentTreeOid), projected, {
    left: (entry) => entry.path,
    right: (entry) => entry.path,
  })) {
    if (row.right !== undefined) {
      if (row.right.stages !== null) {
        throw new CorruptError("clean snapshot projection retained conflict stages");
      }
      const identity = row.right.stageZero;
      if (identity !== null) {
        yield {
          path: row.right.path,
          stage: 0,
          mode: Number.parseInt(identity.mode, 8),
          oid: identity.oid,
          size: null,
          mtime: null,
          ino: null,
          rev: null,
        };
      }
      continue;
    }
    if (row.left !== undefined && !owned.has(row.left.path)) yield row.left;
  }
}

function validateSnapshotResultObjects(
  repo: Repository,
  currentTreeOid: string,
  projected: readonly ProjectedMergeEntry[],
): void {
  const generated = new Set<string>();
  for (const entry of projected) {
    if (entry.content !== null && entry.stageZero !== null) generated.add(entry.stageZero.oid);
  }
  const required = new Set<string>();
  for (const entry of prospectiveSnapshotIndex(repo, currentTreeOid, projected)) {
    if (entry.mode === 0o160000) {
      throw new GitError("EUNSUPPORTED", `snapshot replay rejects gitlink ${entry.path}`);
    }
    required.add(entry.oid);
  }
  const missing = new Set(repo.store.missing(required));
  for (const oid of missing) {
    if (!generated.has(oid)) throw new ObjectNotFoundError(oid);
  }
  const present = [...required].filter((oid) => !missing.has(oid));
  for (let offset = 0; offset < present.length; offset += SNAPSHOT_OBJECT_INFO_PAGE) {
    for (const object of repo.store.objectInfo(
      present.slice(offset, offset + SNAPSHOT_OBJECT_INFO_PAGE),
    )) {
      if (object.type !== "blob") {
        throw new CorruptError(`snapshot replay result ${object.oid} is not a blob`);
      }
    }
  }
}

/** Replay one one-parent snapshot commit into a caller-owned transient index. */
export function replaySnapshot(
  repo: Repository,
  index: IndexStore,
  options: ReplaySnapshotOptions,
): ReplaySnapshotResult {
  const snapshot = requireBoundedRevision(Reflect.get(options, "snapshot"), {
    input: "snapshot",
    operation: "snapshot replay",
  });
  const onto = requireBoundedRevision(Reflect.get(options, "onto"), {
    input: "onto",
    operation: "snapshot replay",
  });
  const sourceOid = resolveBoundedCommitRevision(repo, snapshot, {
    input: "snapshot",
    operation: "snapshot replay",
  });
  if (readCommit(repo, sourceOid).parent.length !== 1) {
    throw new GitError("EINVAL", "snapshot replay requires exactly one parent");
  }
  const currentOid = repo.peel(repo.revParse(onto));
  const plan = planReplay(repo, {
    kind: "cherry-pick",
    source: sourceOid,
    currentOid,
    incomingLabelStyle: "source-subject",
  });
  if (plan.sourceCommit.parent.length !== 1 || plan.selectedParentOid === null) {
    throw new CorruptError("validated snapshot replay source lost its selected parent");
  }

  const reservation = reserveIntegrationPlan(repo, plan.integration, plan.retainedBytes);
  try {
    requireSnapshotTreesWithoutGitlinks(repo, plan);
    const projected = projectMergePlan(plan.integration, {
      currentLabel: plan.labels.current,
      incomingLabel: plan.labels.incoming,
    });
    validateProjectedIndexEntries(projected);
    const conflicts = snapshotConflicts(plan.integration, projected);
    if (conflicts.length > 0) return { outcome: "conflicted", conflicts };

    requireBoundedIntegrationTree(
      repo,
      prospectiveSnapshotIndex(repo, plan.currentTreeOid, projected),
    );
    validateSnapshotResultObjects(repo, plan.currentTreeOid, projected);
    return repo.store.runScratchAwareOperation(() =>
      repo.store.db.transactionSync(() => {
        index.indexReplace(indexFromTree(repo, plan.currentTreeOid));
        applyProjectedIndex(repo, index, projected);
        reservation.set(
          "other",
          checkedRetainedAdd(plan.retainedBytes, plan.integration.retainedBytes),
        );
        return { outcome: "clean", tree: writeTree(repo, index) };
      }),
    );
  } finally {
    reservation.dispose();
  }
}

function planReplayInternal(
  repo: Repository,
  input: ReplayInput,
  metadataReservation: MemoryReservation | null,
): ReplayPlan {
  const revisionLabels: BoundedRevisionLabels = {
    input: "replay source",
    operation: "replay",
  };
  const sourceRevision = requireBoundedRevision(input.source, revisionLabels);
  if (!isOid(input.currentOid)) {
    throw new GitError("EINVAL", "replay current commit must be a full object id");
  }

  const currentCommit = readCommit(repo, input.currentOid);
  const sourceOid = resolveRevision(repo, sourceRevision, revisionLabels);
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
      incomingLabel(
        input.incomingLabelStyle ?? "tree",
        input.kind,
        sourceOid,
        selectedParentOid,
        sourceCommit.message,
      ),
  };
  let retainedBytes = checkedRetainedAdd(
    commitRetainedBytes(currentCommit),
    commitRetainedBytes(sourceCommit),
  );
  for (const value of [
    sourceOid,
    selectedParentOid ?? "",
    input.currentOid,
    ...Object.values(labels),
  ]) {
    retainedBytes = checkedRetainedAdd(retainedBytes, retainedStringBytes(value));
  }
  if (retainedBytes > MAX_REPLAY_PLAN_METADATA_BYTES) {
    throw new GitError(
      "E2BIG",
      `replay metadata exceeds ${MAX_REPLAY_PLAN_METADATA_BYTES} retained bytes`,
    );
  }
  metadataReservation?.set("other", retainedBytes);
  const integration = planIntegration(repo, {
    baseTreeOid,
    currentTreeOid: currentCommit.tree,
    incomingTreeOid,
    text: {
      ...input.text,
      labels,
    },
    limits: input.limits,
    callerRetainedBytes: checkedRetainedAdd(
      input.integrationCallerRetainedBytes ?? 0,
      retainedBytes,
    ),
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
    retainedBytes,
  };
}

/** Build one cherry-pick plan from immutable sequencer OIDs and verify its parent selection. */
export function planFixedReplayStep(repo: Repository, input: FixedReplayStepInput): ReplayPlan {
  return planFixedReplayStepInternal(repo, input, null);
}

function planFixedReplayStepInternal(
  repo: Repository,
  input: FixedReplayStepInput,
  metadataReservation: MemoryReservation | null,
): ReplayPlan {
  if (!isOid(input.sourceOid) || !isOid(input.currentOid)) {
    throw new GitError("EINVAL", "rebase replay step requires full object ids");
  }
  if (input.selectedParentOid !== null && !isOid(input.selectedParentOid)) {
    throw new GitError("EINVAL", "rebase replay step selected parent is invalid");
  }
  const plan = planReplayInternal(
    repo,
    {
      kind: "cherry-pick",
      source: input.sourceOid,
      currentOid: input.currentOid,
      incomingLabelStyle: "source-subject",
      integrationCallerRetainedBytes: input.callerRetainedBytes,
      limits: input.limits,
    },
    metadataReservation,
  );
  if (
    plan.sourceOid !== input.sourceOid ||
    plan.selectedParentOid !== input.selectedParentOid ||
    plan.mainline !== null
  ) {
    throw new GitError("ECORRUPT", "rebase replay step differs from its authenticated queue");
  }
  return plan;
}

export interface RetainedReplayPlan {
  plan: ReplayPlan;
  release(): void;
}

/** Keep replay metadata coordinated from its first allocation through caller release. */
export function planRetainedFixedReplayStep(
  repo: Repository,
  input: FixedReplayStepInput,
): RetainedReplayPlan {
  const reservation = repo.store.reserveMemory();
  reservation.set("other", MAX_REPLAY_PLAN_METADATA_BYTES);
  try {
    const plan = planFixedReplayStepInternal(repo, input, reservation);
    let active = true;
    return {
      plan,
      release(): void {
        if (!active) throw new Error("retained replay plan was already released");
        active = false;
        reservation.dispose();
      },
    };
  } catch (error) {
    reservation.dispose();
    throw error;
  }
}
