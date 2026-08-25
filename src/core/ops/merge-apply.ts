// Atomic low-level application and restoration of one projected merge plan.

import type { WriteEntry } from "../../fs/types.js";
import { type IndexEntry, type IndexSink, MAX_BLOB_BATCH_BYTES } from "../../sqlite/store.js";
import { fromHex, isOid, utf8, utf8Decoder } from "../bytes.js";
import { CorruptError, GitError, hasErrorCode } from "../errors.js";
import { MODE_COMMIT, MODE_EXECUTABLE, MODE_FILE, MODE_SYMLINK } from "../objects.js";
import { joinPath, relativeTo } from "../paths.js";
import type { Repository } from "../repository.js";
import { comparePaths } from "../streams.js";
import { fileModeFor, type Worktree, type WorktreeStat } from "../worktree.js";
import type { ProjectedMergeEntry } from "./merge-projection.js";
import {
  MAX_MERGE_TOUCHED_PATHS,
  type MergeIndexSnapshot,
  type MergeJournal,
  type MergeStateMetadata,
  type MergeTouchedPath,
  type MergeWorktreeSnapshot,
  mergeJournalRetainedBytes,
  validateMergePath,
  validateMergeStateMetadata,
} from "./merge-state.js";
import {
  mergeOperationState,
  type OperationJournal,
  type OperationStateMetadata,
  type OperationStepMetadata,
  operationJournalIntegrityOid,
  operationJournalRetainedBytes,
  type RebaseStateMetadata,
} from "./operation-state.js";

const APPLY_SCAN_PAGE = 1_000;
export const MAX_MERGE_APPLY_SCAN_PAGES = 50;
export const MAX_MERGE_APPLY_SCAN_ROWS = APPLY_SCAN_PAGE * MAX_MERGE_APPLY_SCAN_PAGES;
export const MAX_MERGE_APPLY_SNAPSHOT_READ_CALLS = 4;
export const MAX_MERGE_APPLY_BLOB_READ_CALLS = 8;
export const MAX_MERGE_APPLY_CONTENT_BYTES = 32 * 1024 * 1024;
const MAX_SNAPSHOT_STATEMENTS_PER_READ = 4;
const MAX_OBJECT_STATEMENTS_PER_READ = 8;
// Covers 64 MiB of object writes, 80 MiB of worktree writes, and bounded index/journal batches.
const MAX_MERGE_APPLY_MUTATION_STATEMENTS = 650;
export const MAX_MERGE_APPLY_SQL_STATEMENTS =
  MAX_MERGE_APPLY_SCAN_PAGES +
  (MAX_MERGE_APPLY_SCAN_PAGES + 1) +
  MAX_MERGE_APPLY_SNAPSHOT_READ_CALLS * MAX_SNAPSHOT_STATEMENTS_PER_READ +
  MAX_MERGE_APPLY_BLOB_READ_CALLS * MAX_OBJECT_STATEMENTS_PER_READ +
  MAX_MERGE_APPLY_MUTATION_STATEMENTS;
export const MAX_MERGE_APPLY_PRIOR_SQL_STATEMENTS = 999 - MAX_MERGE_APPLY_SQL_STATEMENTS;
if (MAX_MERGE_APPLY_SQL_STATEMENTS >= 1_000) {
  throw new Error("merge apply SQL model exceeds the operation statement limit");
}

export type MergeApplyMetadata = Omit<MergeStateMetadata, "phase">;
export type MergeApplyOutcome = "clean" | "conflicted" | "ready";

export interface MergeApplyResult {
  outcome: MergeApplyOutcome;
  journal: MergeJournal | null;
  sqlStatements: number;
}

export interface MergeApplyOptions {
  /** Statements already reserved by merge-base selection and integration planning. */
  priorSqlStatements?: number;
}

export interface OperationApplyOptions {
  priorSqlStatements?: number;
  suspendedState: OperationStateMetadata | null;
}

interface ActiveRebaseApply {
  expectedIntegrityOid: string;
  conflictState: RebaseStateMetadata | null;
  steps: readonly OperationStepMetadata[];
}

export interface OperationApplyResult {
  touched: readonly MergeTouchedPath[] | null;
  sqlStatements: number;
}

export interface OperationRestoreOptions {
  /** Statements already reserved by journal verification and ownership reconstruction. */
  priorSqlStatements?: number;
  /** Include the caller's operation-state clear in the pre-write estimate. */
  clearState?: boolean;
}

export interface OperationRestoreSqlInput {
  worktreeScanPages: number;
  blobReadCalls: number;
  worktreeWriteCalls: number;
  worktreeWriteBytes: number;
  indexMutations: number;
  hasRemovals: boolean;
  clearState: boolean;
}

export interface MergeApplySqlInput {
  worktreeScanPages: number;
  indexScanRows: number;
  snapshotReadCalls: number;
  blobReadCalls: number;
  snapshotObjectSizes: readonly number[];
  contentObjectSizes: readonly number[];
  worktreeWriteCalls: number;
  worktreeWriteBytes: number;
  indexMutations: number;
  journalRetainedBytes: number;
  hasJournal: boolean;
  hasRemovals: boolean;
  objectInfoCalls: number;
}

export interface MergeApplySqlEstimate {
  applySqlStatements: number;
  totalSqlStatements: number;
}

interface TouchedSpec {
  path: string;
  logicalPath: string;
  purpose: MergeTouchedPath["purpose"];
}

interface SnapshotDraft {
  spec: TouchedSpec;
  index: MergeIndexSnapshot | null;
  stat: WorktreeStat | null;
}

interface ReadCallBudget {
  snapshot: number;
  blobs: number;
}

interface WorktreeSnapshotScan {
  entries: Map<string, WorktreeStat>;
  pages: number;
}

interface IndexSnapshots {
  entries: Map<string, MergeIndexSnapshot>;
  rows: number;
}

interface SourceBlobBudget {
  calls: number;
  bytes: number;
}

function useReadCall(budget: ReadCallBudget, kind: "snapshot" | "blobs"): void {
  const limit =
    kind === "snapshot" ? MAX_MERGE_APPLY_SNAPSHOT_READ_CALLS : MAX_MERGE_APPLY_BLOB_READ_CALLS;
  if (budget[kind] >= limit) {
    throw new GitError("E2BIG", `merge ${kind} reads exceed ${limit} bounded calls`);
  }
  budget[kind]++;
}

function requireCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new GitError("EINVAL", `merge ${label} must be a non-negative safe integer`);
  }
  return value;
}

function addStatements(total: number, additional: number): number {
  if (!Number.isSafeInteger(additional) || additional < 0 || additional > 999 - total) {
    return 1_000;
  }
  return total + additional;
}

function payloadPages(bytes: number): number {
  requireCount(bytes, "payload bytes");
  return bytes === 0 ? 0 : Math.ceil(bytes / (1024 * 1024));
}

function objectWriteStatements(sizes: readonly number[]): number {
  let statements = 0;
  for (const size of sizes) {
    requireCount(size, "object size");
    // One metadata insert, one stale-chunk delete, then bounded payload pages.
    statements = addStatements(statements, 2 + Math.max(1, payloadPages(size + 64 * 1024)));
  }
  return statements;
}

/** Compose the apply estimate with work already reserved by the caller. */
export function calculateMergeApplySqlStatements(
  priorSqlStatements: number,
  input: MergeApplySqlInput,
): MergeApplySqlEstimate {
  requireCount(priorSqlStatements, "prior SQL statements");
  const counts = [
    input.worktreeScanPages,
    input.indexScanRows,
    input.snapshotReadCalls,
    input.blobReadCalls,
    input.worktreeWriteCalls,
    input.worktreeWriteBytes,
    input.indexMutations,
    input.journalRetainedBytes,
    input.objectInfoCalls,
  ];
  for (const count of counts) requireCount(count, "SQL estimate input");

  let apply = 6; // state guard, roots, and bounded fixed probes
  apply = addStatements(apply, input.worktreeScanPages);
  apply = addStatements(
    apply,
    input.indexScanRows === 0
      ? input.hasJournal
        ? 1
        : 0
      : Math.ceil(input.indexScanRows / 1_000) + 1,
  );
  apply = addStatements(apply, input.snapshotReadCalls * MAX_SNAPSHOT_STATEMENTS_PER_READ);
  apply = addStatements(apply, input.blobReadCalls * MAX_OBJECT_STATEMENTS_PER_READ);
  apply = addStatements(apply, input.objectInfoCalls);
  apply = addStatements(apply, objectWriteStatements(input.snapshotObjectSizes));
  apply = addStatements(apply, objectWriteStatements(input.contentObjectSizes));
  if (input.worktreeWriteCalls > 0) {
    apply = addStatements(
      apply,
      input.worktreeWriteCalls * 10 + payloadPages(input.worktreeWriteBytes),
    );
  }
  if (input.hasRemovals) apply = addStatements(apply, 6);
  if (input.indexMutations > 0) {
    apply = addStatements(apply, Math.ceil(input.indexMutations / 512) * 2);
  }
  if (input.hasJournal) {
    apply = addStatements(apply, 9 + payloadPages(input.journalRetainedBytes));
  }
  return {
    applySqlStatements: apply,
    totalSqlStatements: addStatements(priorSqlStatements, apply),
  };
}

/** Compose a replay restore estimate before its first mutation. */
export function calculateOperationRestoreSqlStatements(
  priorSqlStatements: number,
  input: OperationRestoreSqlInput,
): MergeApplySqlEstimate {
  requireCount(priorSqlStatements, "prior SQL statements");
  for (const count of [
    input.worktreeScanPages,
    input.blobReadCalls,
    input.worktreeWriteCalls,
    input.worktreeWriteBytes,
    input.indexMutations,
  ]) {
    requireCount(count, "restore SQL estimate input");
  }
  let restore = 6; // authenticated journal, roots, and bounded fixed probes
  restore = addStatements(restore, input.worktreeScanPages);
  restore = addStatements(restore, input.blobReadCalls * MAX_OBJECT_STATEMENTS_PER_READ);
  restore = addStatements(restore, 1); // one bounded object-info probe for snapshot blobs
  if (input.hasRemovals) restore = addStatements(restore, 6);
  if (input.worktreeWriteCalls > 0) {
    restore = addStatements(
      restore,
      input.worktreeWriteCalls * 10 + payloadPages(input.worktreeWriteBytes),
    );
  }
  if (input.indexMutations > 0) {
    restore = addStatements(restore, Math.ceil(input.indexMutations / 512) * 2);
  }
  if (input.clearState) restore = addStatements(restore, 9);
  return {
    applySqlStatements: restore,
    totalSqlStatements: addStatements(priorSqlStatements, restore),
  };
}

function validMode(mode: string): boolean {
  return mode === MODE_FILE || mode === MODE_EXECUTABLE || mode === MODE_SYMLINK;
}

function requireIdentity(mode: string, oid: string, path: string): number {
  if (mode === MODE_COMMIT) {
    throw new GitError("EUNSUPPORTED", `merge cannot materialise gitlink ${path}`);
  }
  if (!validMode(mode)) throw new CorruptError(`merge entry ${path} has an invalid mode`);
  if (!isOid(oid)) throw new CorruptError(`merge entry ${path} has an invalid object id`);
  return Number.parseInt(mode, 8);
}

function validateEntries(entries: readonly ProjectedMergeEntry[]): void {
  if (entries.length > MAX_MERGE_TOUCHED_PATHS) {
    throw new GitError("E2BIG", `merge apply exceeds ${MAX_MERGE_TOUCHED_PATHS} projected paths`);
  }
  let previous: string | null = null;
  let contentBytes = 0;
  for (const entry of entries) {
    validateMergePath(entry.path, "projected path");
    validateMergePath(entry.logicalPath, "projected logical path");
    if (previous !== null && comparePaths(previous, entry.path) >= 0) {
      throw new CorruptError("projected merge entries are not in strict Git path order");
    }
    if (entry.purpose === "primary" && entry.path !== entry.logicalPath) {
      throw new CorruptError("projected merge primary path differs from its logical path");
    }
    if (entry.purpose !== "primary" && entry.path === entry.logicalPath) {
      throw new CorruptError("projected merge relocation equals its logical path");
    }
    if ((entry.stageZero === null) === (entry.stages === null)) {
      if (entry.stageZero !== null || entry.stages !== null) {
        throw new CorruptError(`projected merge entry ${entry.path} has conflicting index forms`);
      }
    }
    if (
      entry.purpose !== "primary" &&
      entry.purpose !== "current-relocation" &&
      entry.purpose !== "incoming-relocation"
    ) {
      throw new CorruptError("projected merge entry has an invalid purpose");
    }
    if (entry.stageZero !== null) {
      requireIdentity(entry.stageZero.mode, entry.stageZero.oid, entry.path);
    }
    if (entry.stages !== null) {
      if (
        entry.stages.base === null &&
        entry.stages.current === null &&
        entry.stages.incoming === null
      ) {
        throw new CorruptError(`projected merge entry ${entry.path} has no conflict stages`);
      }
      for (const identity of [entry.stages.base, entry.stages.current, entry.stages.incoming]) {
        if (identity !== null) requireIdentity(identity.mode, identity.oid, entry.path);
      }
    }
    if (entry.worktree !== null) {
      requireIdentity(entry.worktree.mode, entry.worktree.oid, entry.path);
    }
    if (entry.content !== null && entry.worktree === null) {
      throw new CorruptError(`projected merge entry ${entry.path} has orphaned content`);
    }
    if (
      entry.content !== null &&
      entry.worktree !== null &&
      entry.worktree.mode !== MODE_FILE &&
      entry.worktree.mode !== MODE_EXECUTABLE
    ) {
      throw new CorruptError(`projected merge entry ${entry.path} has non-file content`);
    }
    contentBytes += entry.content?.length ?? 0;
    if (!Number.isSafeInteger(contentBytes) || contentBytes > MAX_MERGE_APPLY_CONTENT_BYTES) {
      throw new GitError(
        "E2BIG",
        `merge apply content exceeds ${MAX_MERGE_APPLY_CONTENT_BYTES} bytes`,
      );
    }
    previous = entry.path;
  }
}

function boundedUtf8Length(value: string, limit: number, label: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) throw new CorruptError(`${label} is not canonical UTF-16`);
      index++;
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new CorruptError(`${label} is not canonical UTF-16`);
    } else {
      bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    }
    if (bytes > limit) throw new GitError("E2BIG", `${label} exceeds ${limit} bytes`);
  }
  return bytes;
}

function touchedSpecs(entries: readonly ProjectedMergeEntry[]): TouchedSpec[] {
  const byPath = new Map<string, TouchedSpec>();
  const retain = (spec: TouchedSpec): void => {
    if (byPath.has(spec.path)) return;
    if (byPath.size >= MAX_MERGE_TOUCHED_PATHS) {
      throw new GitError("E2BIG", `merge journal exceeds ${MAX_MERGE_TOUCHED_PATHS} touched paths`);
    }
    byPath.set(spec.path, spec);
  };
  const retainAncestor = (path: string): void => {
    let slash = path.lastIndexOf("/");
    while (slash > 0) {
      const ancestor = path.slice(0, slash);
      retain({ path: ancestor, logicalPath: ancestor, purpose: "primary" });
      slash = ancestor.lastIndexOf("/");
    }
  };
  for (const entry of entries) {
    retain({
      path: entry.path,
      logicalPath: entry.logicalPath,
      purpose: entry.purpose,
    });
    if (entry.purpose !== "primary" && !byPath.has(entry.logicalPath)) {
      retain({
        path: entry.logicalPath,
        logicalPath: entry.logicalPath,
        purpose: "primary",
      });
    }
    retainAncestor(entry.path);
    retainAncestor(entry.logicalPath);
  }
  const specs = [...byPath.values()].sort((left, right) => comparePaths(left.path, right.path));
  return specs;
}

function lowerBound(paths: readonly string[], wanted: string): number {
  let low = 0;
  let high = paths.length;
  while (low < high) {
    const middle = low + ((high - low) >> 1);
    const path = paths[middle];
    if (path !== undefined && comparePaths(path, wanted) < 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

function ownedPathOrAncestor(
  path: string,
  owned: readonly string[],
  exact: ReadonlySet<string>,
): boolean {
  if (exact.has(path)) return true;
  const index = lowerBound(owned, `${path}/`);
  return owned[index]?.startsWith(`${path}/`) === true;
}

function destructiveOwner(path: string, roots: readonly string[]): string | null {
  const index = lowerBound(roots, path);
  if (roots[index] === path) return path;
  const previous = roots[index - 1];
  return previous !== undefined && path.startsWith(`${previous}/`) ? previous : null;
}

function minimalRoots(paths: readonly string[]): string[] {
  const roots: string[] = [];
  for (const path of paths) {
    const previous = roots[roots.length - 1];
    if (previous === undefined || (path !== previous && !path.startsWith(`${previous}/`))) {
      roots.push(path);
    }
  }
  return roots;
}

function worktreeSnapshotScan(
  repo: Repository,
  worktree: Worktree,
  specs: readonly TouchedSpec[],
  destructiveRoots: readonly string[],
  ownedPaths: readonly string[],
): WorktreeSnapshotScan {
  const root = worktree.realpath(repo.root);
  const absoluteToRelative = new Map(specs.map((spec) => [joinPath(root, spec.path), spec.path]));
  const absoluteDestructive = minimalRoots(destructiveRoots)
    .map((path) => joinPath(root, path))
    .sort(comparePaths);
  const exactOwned = new Set(ownedPaths);
  const found = new Map<string, WorktreeStat>();
  const last = specs[specs.length - 1];
  if (last === undefined) return { entries: found, pages: 0 };
  const lastAbsolute = joinPath(root, last.path);
  let after: string | undefined;
  let pages = 0;
  while (true) {
    if (pages >= MAX_MERGE_APPLY_SCAN_PAGES) {
      throw new GitError("E2BIG", `merge apply scan exceeds ${MAX_MERGE_APPLY_SCAN_ROWS} rows`);
    }
    const page = worktree.scan(root, { after, limit: APPLY_SCAN_PAGE });
    pages++;
    if (page.length === 0) break;
    for (const entry of page) {
      const relative = relativeTo(root, entry.path);
      if (relative === null) throw new CorruptError("worktree scan escaped the repository root");
      const exact = absoluteToRelative.get(entry.path);
      if (exact !== undefined) found.set(exact, entry);
      const owner = destructiveOwner(entry.path, absoluteDestructive);
      if (
        owner !== null &&
        entry.path !== owner &&
        !ownedPathOrAncestor(relative, ownedPaths, exactOwned)
      ) {
        throw new GitError(
          "ECHECKOUTFAIL",
          `working tree path blocks merge restoration: ${relative}`,
        );
      }
      if (comparePaths(entry.path, lastAbsolute) > 0 && owner === null) break;
    }
    const tail = page[page.length - 1];
    if (tail === undefined || page.length < APPLY_SCAN_PAGE) break;
    if (
      comparePaths(tail.path, lastAbsolute) > 0 &&
      destructiveOwner(tail.path, absoluteDestructive) === null
    ) {
      break;
    }
    after = tail.path;
  }
  return { entries: found, pages };
}

function indexSnapshots(repo: Repository, specs: readonly TouchedSpec[]): IndexSnapshots {
  const wanted = new Set(specs.map((spec) => spec.path));
  const found = new Map<string, MergeIndexSnapshot>();
  const last = specs[specs.length - 1];
  if (last === undefined) return { entries: found, rows: 0 };
  let rows = 0;
  for (const entry of repo.store.indexScan()) {
    rows++;
    if (rows > MAX_MERGE_APPLY_SCAN_ROWS) {
      throw new GitError("E2BIG", `merge index scan exceeds ${MAX_MERGE_APPLY_SCAN_ROWS} rows`);
    }
    if (comparePaths(entry.path, last.path) > 0) break;
    if (!wanted.has(entry.path)) continue;
    if (entry.stage !== 0) {
      throw new GitError("EUNMERGED", "cannot apply a merge over unmerged index entries");
    }
    found.set(entry.path, {
      stage: 0,
      mode: entry.mode,
      oid: entry.oid,
      size: entry.size,
      mtime: entry.mtime,
      ino: entry.ino,
      rev: entry.rev ?? null,
    });
  }
  return { entries: found, rows };
}

function snapshotWorktreeObjects(
  repo: Repository,
  worktree: Worktree,
  root: string,
  drafts: readonly SnapshotDraft[],
  calls: ReadCallBudget,
): Map<string, string> {
  const oids = new Map<string, string>();
  const files: string[] = [];
  const snapshotLimit = MAX_MERGE_APPLY_SNAPSHOT_READ_CALLS * MAX_BLOB_BATCH_BYTES;
  let snapshotBytes = 0;
  for (const draft of drafts) {
    const stat = draft.stat;
    if (stat?.type === "file") {
      if (stat.size > MAX_BLOB_BATCH_BYTES) {
        throw new GitError(
          "E2BIG",
          `merge snapshot file ${draft.spec.path} exceeds ${MAX_BLOB_BATCH_BYTES} bytes`,
        );
      }
      snapshotBytes += stat.size;
    } else if (stat?.type === "symlink") {
      if (stat.target === null) {
        throw new CorruptError(`worktree symlink ${draft.spec.path} has no target`);
      }
      snapshotBytes += boundedUtf8Length(
        stat.target,
        MAX_BLOB_BATCH_BYTES,
        `merge snapshot symlink ${draft.spec.path}`,
      );
    }
    if (!Number.isSafeInteger(snapshotBytes) || snapshotBytes > snapshotLimit) {
      throw new GitError("E2BIG", `merge worktree snapshot exceeds ${snapshotLimit} bytes`);
    }
  }
  repo.store.writeObjects((batch) => {
    for (const draft of drafts) {
      if (draft.stat?.type === "symlink") {
        if (draft.stat.target === null) throw new CorruptError("validated symlink lost its target");
        oids.set(draft.spec.path, batch.write("blob", utf8.encode(draft.stat.target)));
      } else if (draft.stat?.type === "file") {
        files.push(joinPath(root, draft.spec.path));
      }
    }
    let remaining = files;
    while (remaining.length > 0) {
      useReadCall(calls, "snapshot");
      const read = worktree.readFiles(remaining, { budget: MAX_BLOB_BATCH_BYTES });
      for (const [absolute, bytes] of read.files) {
        const relative = relativeTo(root, absolute);
        if (relative === null) throw new CorruptError("merge snapshot read escaped repository");
        oids.set(relative, batch.write("blob", bytes));
      }
      if (read.remaining.length >= remaining.length) {
        throw new CorruptError("merge snapshot file batch made no progress");
      }
      remaining = read.remaining;
    }
  });
  for (const draft of drafts) {
    if (
      (draft.stat?.type === "file" || draft.stat?.type === "symlink") &&
      !oids.has(draft.spec.path)
    ) {
      throw new CorruptError(`merge snapshot lost worktree path ${draft.spec.path}`);
    }
  }
  return oids;
}

function worktreeSnapshot(draft: SnapshotDraft, oid: string | undefined): MergeWorktreeSnapshot {
  const stat = draft.stat;
  if (stat === null) return { kind: "absent" };
  if (stat.type === "dir") return { kind: "directory", mode: stat.mode, revision: stat.rev };
  if (oid === undefined) throw new CorruptError(`merge snapshot lacks object ${draft.spec.path}`);
  return { kind: stat.type, mode: stat.mode, oid, revision: stat.rev };
}

function touchedFromDrafts(
  drafts: readonly SnapshotDraft[],
  oids: ReadonlyMap<string, string> | null,
): MergeTouchedPath[] {
  return drafts.map((draft) => ({
    path: draft.spec.path,
    logicalPath: draft.spec.logicalPath,
    purpose: draft.spec.purpose,
    index: draft.index,
    worktree: worktreeSnapshot(draft, oids === null ? "0".repeat(40) : oids.get(draft.spec.path)),
  }));
}

function snapshotSizes(drafts: readonly SnapshotDraft[]): number[] {
  const sizes: number[] = [];
  for (const draft of drafts) {
    const stat = draft.stat;
    if (stat?.type === "file") sizes.push(stat.size);
    else if (stat?.type === "symlink" && stat.target !== null) {
      sizes.push(
        boundedUtf8Length(
          stat.target,
          MAX_BLOB_BATCH_BYTES,
          `merge snapshot symlink ${draft.spec.path}`,
        ),
      );
    }
  }
  return sizes;
}

function snapshotFileSizes(drafts: readonly SnapshotDraft[]): number[] {
  return drafts.flatMap((draft) => (draft.stat?.type === "file" ? [draft.stat.size] : []));
}

function boundedReadCalls(sizes: readonly number[], limit: number, label: string): number {
  let calls = 0;
  let bytes = 0;
  for (const size of sizes) {
    if (size > MAX_BLOB_BATCH_BYTES) {
      throw new GitError("E2BIG", `merge ${label} object exceeds ${MAX_BLOB_BATCH_BYTES} bytes`);
    }
    if (bytes > 0 && bytes + size > MAX_BLOB_BATCH_BYTES) {
      calls++;
      bytes = 0;
    }
    bytes += size;
  }
  if (bytes > 0 || sizes.length > 0) calls++;
  if (calls > limit) throw new GitError("E2BIG", `merge ${label} reads exceed ${limit} calls`);
  return calls;
}

function sourceBlobBudget(
  repo: Repository,
  entries: readonly ProjectedMergeEntry[],
): SourceBlobBudget {
  const seen = new Set<string>();
  const oids: string[] = [];
  for (const entry of entries) {
    const identity = entry.content === null ? entry.worktree : null;
    if (identity === null || seen.has(identity.oid)) continue;
    seen.add(identity.oid);
    oids.push(identity.oid);
  }
  if (oids.length === 0) return { calls: 0, bytes: 0 };
  const sizes: number[] = [];
  const sizeByOid = new Map<string, number>();
  for (const object of repo.store.objectInfo(oids)) {
    if (object.type !== "blob") {
      throw new CorruptError(`merge output object ${object.oid} is not a blob`);
    }
    sizes.push(object.size);
    sizeByOid.set(object.oid, object.size);
  }
  let bytes = 0;
  for (const entry of entries) {
    const identity = entry.content === null ? entry.worktree : null;
    if (identity === null) continue;
    const size = sizeByOid.get(identity.oid);
    if (size === undefined) throw new CorruptError(`merge output lost object ${identity.oid}`);
    bytes += size;
    if (!Number.isSafeInteger(bytes)) throw new GitError("E2BIG", "merge output size overflow");
  }
  return {
    calls: boundedReadCalls(sizes, MAX_MERGE_APPLY_BLOB_READ_CALLS, "blob"),
    bytes,
  };
}

function indexMutationCount(
  entries: readonly ProjectedMergeEntry[],
  specs: readonly TouchedSpec[],
): number {
  let mutations = specs.length;
  for (const entry of entries) {
    if (entry.stageZero !== null) mutations++;
    if (entry.stages?.base !== null && entry.stages?.base !== undefined) mutations++;
    if (entry.stages?.current !== null && entry.stages?.current !== undefined) mutations++;
    if (entry.stages?.incoming !== null && entry.stages?.incoming !== undefined) mutations++;
  }
  return mutations;
}

function outcomeOf(
  entries: readonly ProjectedMergeEntry[],
  mode: MergeApplyMetadata["mode"],
): MergeApplyOutcome {
  if (entries.some((entry) => entry.stages !== null)) return "conflicted";
  return mode === "no-commit" ? "ready" : "clean";
}

function metadataForOutcome(
  metadata: MergeApplyMetadata,
  outcome: Exclude<MergeApplyOutcome, "clean">,
): MergeStateMetadata {
  return { ...metadata, phase: outcome };
}

function contentObjects(
  repo: Repository,
  entries: readonly ProjectedMergeEntry[],
): Map<string, string> {
  const oids = new Map<string, string>();
  repo.store.writeObjects((batch) => {
    for (const entry of entries) {
      if (entry.content === null) continue;
      const oid = batch.write("blob", entry.content);
      if (entry.stageZero !== null && oid !== entry.stageZero.oid) {
        throw new CorruptError(`merged content identity does not match ${entry.path}`);
      }
      oids.set(entry.path, oid);
    }
  });
  return oids;
}

function materialiseWrites(
  repo: Repository,
  worktree: Worktree,
  entries: readonly ProjectedMergeEntry[],
  contentOids: ReadonlyMap<string, string>,
  calls: ReadCallBudget,
): void {
  const inline: WriteEntry[] = [];
  const pending: ProjectedMergeEntry[] = [];
  for (const entry of entries) {
    if (entry.worktree === null) continue;
    if (entry.content !== null) {
      const oid = contentOids.get(entry.path);
      if (oid === undefined) throw new CorruptError(`merge output lacks content ${entry.path}`);
      inline.push({
        path: joinPath(repo.root, entry.path),
        bytes: entry.content,
        mode: fileModeFor(entry.worktree.mode),
        contentId: fromHex(oid),
      });
    } else {
      pending.push(entry);
    }
  }
  if (inline.length > 0) worktree.writeFiles(inline);

  let remaining = pending;
  while (remaining.length > 0) {
    useReadCall(calls, "blobs");
    const read = repo.readBlobs(
      remaining.map((entry) => entry.worktree?.oid ?? ""),
      { budgetBytes: MAX_BLOB_BATCH_BYTES },
    );
    const writes: WriteEntry[] = [];
    const deferred: ProjectedMergeEntry[] = [];
    for (const entry of remaining) {
      const identity = entry.worktree;
      if (identity === null) continue;
      const bytes = read.blobs.get(identity.oid);
      if (bytes === undefined) {
        deferred.push(entry);
        continue;
      }
      const path = joinPath(repo.root, entry.path);
      const contentId = fromHex(identity.oid);
      writes.push(
        identity.mode === MODE_SYMLINK
          ? { path, target: utf8Decoder.decode(bytes), contentId }
          : { path, bytes, mode: fileModeFor(identity.mode), contentId },
      );
    }
    if (writes.length > 0) worktree.writeFiles(writes);
    if (deferred.length >= remaining.length) {
      throw new CorruptError("merge output blob batch made no progress");
    }
    remaining = deferred;
  }
}

function putIdentity(
  sink: IndexSink,
  path: string,
  stage: number,
  mode: string,
  oid: string,
): void {
  sink.put({
    path,
    stage,
    mode: requireIdentity(mode, oid, path),
    oid,
    size: null,
    mtime: null,
    ino: null,
    rev: null,
  });
}

function applyIndex(
  repo: Repository,
  entries: readonly ProjectedMergeEntry[],
  specs: readonly TouchedSpec[],
): void {
  const projected = new Set(entries.map((entry) => entry.path));
  repo.store.indexApply((sink) => {
    for (const spec of specs) {
      if (!projected.has(spec.path)) sink.remove(spec.path);
    }
    for (const entry of entries) {
      sink.remove(entry.path);
      if (entry.stageZero !== null) {
        putIdentity(sink, entry.path, 0, entry.stageZero.mode, entry.stageZero.oid);
      }
      if (entry.stages !== null) {
        if (entry.stages.base !== null) {
          putIdentity(sink, entry.path, 1, entry.stages.base.mode, entry.stages.base.oid);
        }
        if (entry.stages.current !== null) {
          putIdentity(sink, entry.path, 2, entry.stages.current.mode, entry.stages.current.oid);
        }
        if (entry.stages.incoming !== null) {
          putIdentity(sink, entry.path, 3, entry.stages.incoming.mode, entry.stages.incoming.oid);
        }
      }
    }
  });
}

function applyDestructiveRoots(entries: readonly ProjectedMergeEntry[]): string[] {
  return entries
    .filter((entry) => entry.worktree === null || entry.worktree.mode !== MODE_COMMIT)
    .map((entry) => entry.path)
    .sort(comparePaths);
}

function structuralRemovals(
  entries: readonly ProjectedMergeEntry[],
  snapshots: ReadonlyMap<string, WorktreeStat>,
): string[] {
  const removals = new Set<string>();
  for (const entry of entries) {
    if (entry.worktree === null || snapshots.get(entry.path)?.type === "dir") {
      removals.add(entry.path);
    }
    if (entry.worktree === null) continue;
    let slash = entry.path.lastIndexOf("/");
    while (slash > 0) {
      const ancestor = entry.path.slice(0, slash);
      const stat = snapshots.get(ancestor);
      if (stat !== undefined && stat.type !== "dir") removals.add(ancestor);
      slash = ancestor.lastIndexOf("/");
    }
  }
  return [...removals].sort(comparePaths);
}

/** Apply inside the caller's transaction so journal and mutations commit together. */
function applyProjectedOperationInternal(
  repo: Repository,
  worktree: Worktree,
  entries: readonly ProjectedMergeEntry[],
  options: OperationApplyOptions,
  activeRebase: ActiveRebaseApply | null,
): OperationApplyResult {
  validateEntries(entries);
  if (activeRebase === null) {
    repo.store.requireNoOperationState();
  } else {
    if (options.suspendedState !== null) {
      throw new CorruptError("rebase apply supplied two journal transitions");
    }
    const current = repo.store.requireOperationState("rebase");
    if (current.integrityOid !== activeRebase.expectedIntegrityOid) {
      throw new GitError("EOPMISMATCH", "rebase operation changed before apply");
    }
    if (
      current.steps.length !== activeRebase.steps.length ||
      current.steps.some((step, ordinal) => {
        const supplied = activeRebase.steps[ordinal];
        return (
          supplied === undefined ||
          step.sourceOid !== supplied.sourceOid ||
          step.selectedParentOid !== supplied.selectedParentOid ||
          step.mainline !== supplied.mainline ||
          step.outcome !== supplied.outcome ||
          step.resultOid !== supplied.resultOid
        );
      })
    ) {
      throw new GitError("EOPMISMATCH", "rebase apply queue differs from its active journal");
    }
  }
  const suspendedState = activeRebase?.conflictState ?? options.suspendedState;
  const suspendedSteps = activeRebase?.steps;

  const specs = touchedSpecs(entries);
  const owned = specs.map((spec) => spec.path);
  const destructive = applyDestructiveRoots(entries);
  const worktreeRows = worktreeSnapshotScan(repo, worktree, specs, destructive, owned);
  const calls: ReadCallBudget = { snapshot: 0, blobs: 0 };
  let drafts: SnapshotDraft[] = [];
  let previewTouched: MergeTouchedPath[] = [];
  let indexRows = 0;
  if (suspendedState !== null) {
    const index = indexSnapshots(repo, specs);
    indexRows = index.rows;
    drafts = specs.map((spec) => ({
      spec,
      index: index.entries.get(spec.path) ?? null,
      stat: worktreeRows.entries.get(spec.path) ?? null,
    }));
    previewTouched = touchedFromDrafts(drafts, null);
  }

  const source = sourceBlobBudget(repo, entries);
  const snapshotObjectSizes = snapshotSizes(drafts);
  const snapshotReadCalls = boundedReadCalls(
    snapshotFileSizes(drafts),
    MAX_MERGE_APPLY_SNAPSHOT_READ_CALLS,
    "snapshot",
  );
  const contentObjectSizes = entries.flatMap((entry) =>
    entry.content === null ? [] : [entry.content.length],
  );
  const contentBytes = contentObjectSizes.reduce((total, size) => total + size, 0);
  const removals = structuralRemovals(entries, worktreeRows.entries);
  const journalRetainedBytes =
    suspendedState === null
      ? 0
      : operationJournalRetainedBytes(suspendedState, previewTouched, suspendedSteps);
  const estimate = calculateMergeApplySqlStatements(options.priorSqlStatements ?? 0, {
    worktreeScanPages: worktreeRows.pages,
    indexScanRows: indexRows,
    snapshotReadCalls,
    blobReadCalls: source.calls,
    snapshotObjectSizes,
    contentObjectSizes,
    worktreeWriteCalls: source.calls + (contentObjectSizes.length > 0 ? 1 : 0),
    worktreeWriteBytes: source.bytes + contentBytes,
    indexMutations: indexMutationCount(entries, specs),
    journalRetainedBytes,
    hasJournal: suspendedState !== null,
    hasRemovals: removals.length > 0,
    objectInfoCalls: (source.calls > 0 ? 1 : 0) + (suspendedState === null ? 0 : 1),
  });
  if (
    estimate.applySqlStatements > MAX_MERGE_APPLY_SQL_STATEMENTS ||
    estimate.totalSqlStatements >= 1_000
  ) {
    throw new GitError(
      "E2BIG",
      `merge SQL model requires ${estimate.totalSqlStatements} statements`,
    );
  }

  let touched: readonly MergeTouchedPath[] | null = null;
  if (suspendedState !== null) {
    const root = worktree.realpath(repo.root);
    const snapshotOids = snapshotWorktreeObjects(repo, worktree, root, drafts, calls);
    touched = touchedFromDrafts(drafts, snapshotOids);
    operationJournalRetainedBytes(suspendedState, touched, suspendedSteps);
  }

  const contentOids = contentObjects(repo, entries);
  if (removals.length > 0) {
    worktree.removeFiles(
      removals.map((path) => joinPath(repo.root, path)),
      {
        recursive: true,
      },
    );
  }
  materialiseWrites(repo, worktree, entries, contentOids, calls);
  applyIndex(repo, entries, specs);
  if (touched !== null) {
    if (suspendedState === null) throw new CorruptError("operation snapshot lost its state");
    if (activeRebase === null) {
      repo.store.writeOperationState(suspendedState, touched);
    } else {
      repo.store.replaceOperationJournal(
        activeRebase.expectedIntegrityOid,
        suspendedState,
        activeRebase.steps,
        touched,
      );
    }
  }
  return { touched, sqlStatements: estimate.applySqlStatements };
}

/** Apply a normal operation inside its caller-owned transaction. */
export function applyProjectedOperation(
  repo: Repository,
  worktree: Worktree,
  entries: readonly ProjectedMergeEntry[],
  options: OperationApplyOptions,
): OperationApplyResult {
  return applyProjectedOperationInternal(repo, worktree, entries, options, null);
}

export interface ProjectedRebaseTransitionOptions<T> extends ActiveRebaseApply {
  priorSqlStatements?: number;
  onClean: (applied: OperationApplyResult) => T;
}

export type ProjectedRebaseTransitionResult<T> =
  | { outcome: "clean"; value: T }
  | { outcome: "conflicted" };

/** Own the transaction that couples active-rebase mutation to its journal transition. */
export function applyProjectedRebaseTransition<T>(
  repo: Repository,
  worktree: Worktree,
  entries: readonly ProjectedMergeEntry[],
  options: ProjectedRebaseTransitionOptions<T>,
): ProjectedRebaseTransitionResult<T> {
  return repo.store.db.transactionSync(() => {
    const applied = applyProjectedOperationInternal(
      repo,
      worktree,
      entries,
      { priorSqlStatements: options.priorSqlStatements, suspendedState: null },
      options,
    );
    if (options.conflictState !== null) {
      if (applied.touched === null) {
        throw new CorruptError("conflicted rebase apply omitted its ownership snapshot");
      }
      return { outcome: "conflicted" };
    }
    if (applied.touched !== null) {
      throw new CorruptError("clean rebase apply unexpectedly retained ownership snapshots");
    }
    return { outcome: "clean", value: options.onClean(applied) };
  });
}

export function applyProjectedMerge(
  repo: Repository,
  worktree: Worktree,
  entries: readonly ProjectedMergeEntry[],
  metadata: MergeApplyMetadata,
  options: MergeApplyOptions = {},
): MergeApplyResult {
  const outcome = outcomeOf(entries, metadata.mode);
  if (outcome === "clean") {
    validateMergeStateMetadata({ ...metadata, phase: "conflicted" });
  }
  const state = outcome === "clean" ? null : metadataForOutcome(metadata, outcome);
  const applied = applyProjectedOperation(repo, worktree, entries, {
    priorSqlStatements: options.priorSqlStatements,
    suspendedState: state === null ? null : mergeOperationState(state),
  });
  const journal =
    state === null || applied.touched === null
      ? null
      : {
          state,
          touched: applied.touched,
          retainedBytes: mergeJournalRetainedBytes(state, applied.touched),
        };
  return { outcome, journal, sqlStatements: applied.sqlStatements };
}

function validateJournal(journal: MergeJournal): void {
  if (mergeJournalRetainedBytes(journal.state, journal.touched) !== journal.retainedBytes) {
    throw new CorruptError("merge journal retained-byte count is stale");
  }
  let previous: string | null = null;
  for (const entry of journal.touched) {
    if (previous !== null && comparePaths(previous, entry.path) >= 0) {
      throw new CorruptError("merge journal paths are not in strict Git path order");
    }
    previous = entry.path;
  }
}

function expectedJournalObjects(journal: MergeJournal): Map<string, "blob" | "commit"> {
  const expected = new Map<string, "blob" | "commit">();
  const add = (oid: string, type: "blob" | "commit"): void => {
    const previous = expected.get(oid);
    if (previous !== undefined && previous !== type) {
      throw new CorruptError(`merge journal object ${oid} has conflicting expected types`);
    }
    expected.set(oid, type);
  };
  add(journal.state.originalHeadOid, "commit");
  add(journal.state.currentParentOid, "commit");
  add(journal.state.incomingParentOid, "commit");
  for (const entry of journal.touched) {
    if (entry.index !== null) {
      add(entry.index.oid, entry.index.mode === 0o160000 ? "commit" : "blob");
    }
    if (entry.worktree.kind === "file" || entry.worktree.kind === "symlink") {
      add(entry.worktree.oid, "blob");
    }
  }
  return expected;
}

function validateJournalObjects(repo: Repository, journal: MergeJournal): void {
  const expected = expectedJournalObjects(journal);
  let objects: ReturnType<Repository["store"]["objectInfo"]>;
  try {
    objects = repo.store.objectInfo([...expected.keys()]);
  } catch (error) {
    if (hasErrorCode(error, "ENOTFOUND")) {
      throw new CorruptError("merge journal references a missing object", { cause: error });
    }
    throw error;
  }
  for (const object of objects) {
    if (expected.get(object.oid) !== object.type) {
      throw new CorruptError(`merge journal object ${object.oid} has an unexpected type`);
    }
  }
}

function abortDestructiveRoots(touched: readonly MergeTouchedPath[]): string[] {
  return touched
    .filter((entry) => entry.worktree.kind !== "directory")
    .map((entry) => entry.path)
    .sort(comparePaths);
}

function restoreIndex(repo: Repository, touched: readonly MergeTouchedPath[]): void {
  repo.store.indexApply((sink) => {
    for (const entry of touched) {
      sink.remove(entry.path);
      if (entry.index !== null) {
        const restored: IndexEntry = { path: entry.path, ...entry.index };
        sink.put(restored);
      }
    }
  });
}

function restoreWorktree(
  repo: Repository,
  worktree: Worktree,
  touched: readonly MergeTouchedPath[],
  current: ReadonlyMap<string, WorktreeStat>,
  calls: ReadCallBudget,
): void {
  const removals = new Set<string>();
  const directories: WriteEntry[] = [];
  const pending: MergeTouchedPath[] = [];
  for (const entry of touched) {
    if (entry.worktree.kind === "absent") {
      removals.add(entry.path);
    } else if (entry.worktree.kind === "directory") {
      const found = current.get(entry.path);
      if (found !== undefined && found.type !== "dir") removals.add(entry.path);
      directories.push({
        path: joinPath(repo.root, entry.path),
        mode: entry.worktree.mode & 0o7777,
      });
    } else {
      if (current.get(entry.path)?.type === "dir") removals.add(entry.path);
      pending.push(entry);
    }
  }
  if (removals.size > 0) {
    worktree.removeFiles(
      [...removals].sort(comparePaths).map((path) => joinPath(repo.root, path)),
      { recursive: true },
    );
  }
  if (directories.length > 0) worktree.writeFiles(directories);

  let remaining = pending;
  while (remaining.length > 0) {
    useReadCall(calls, "blobs");
    const read = repo.readBlobs(
      remaining.flatMap((entry) =>
        entry.worktree.kind === "file" || entry.worktree.kind === "symlink"
          ? [entry.worktree.oid]
          : [],
      ),
      { budgetBytes: MAX_BLOB_BATCH_BYTES },
    );
    const writes: WriteEntry[] = [];
    const deferred: MergeTouchedPath[] = [];
    for (const entry of remaining) {
      const snapshot = entry.worktree;
      if (snapshot.kind !== "file" && snapshot.kind !== "symlink") continue;
      const bytes = read.blobs.get(snapshot.oid);
      if (bytes === undefined) {
        deferred.push(entry);
        continue;
      }
      const path = joinPath(repo.root, entry.path);
      writes.push(
        snapshot.kind === "symlink"
          ? { path, target: utf8Decoder.decode(bytes), contentId: fromHex(snapshot.oid) }
          : {
              path,
              bytes,
              mode: snapshot.mode & 0o7777,
              contentId: fromHex(snapshot.oid),
            },
      );
    }
    if (writes.length > 0) worktree.writeFiles(writes);
    if (deferred.length >= remaining.length) {
      throw new CorruptError("merge abort blob batch made no progress");
    }
    remaining = deferred;
  }
}

function restoreSqlInput(
  repo: Repository,
  touched: readonly MergeTouchedPath[],
  current: ReadonlyMap<string, WorktreeStat>,
  worktreeScanPages: number,
  clearState: boolean,
): OperationRestoreSqlInput {
  const oids: string[] = [];
  const seen = new Set<string>();
  let directories = 0;
  let hasRemovals = false;
  for (const entry of touched) {
    const snapshot = entry.worktree;
    if (snapshot.kind === "absent") {
      hasRemovals = true;
      continue;
    }
    if (snapshot.kind === "directory") {
      directories++;
      if (current.get(entry.path)?.type !== "dir") hasRemovals = true;
      continue;
    }
    if (current.get(entry.path)?.type === "dir") hasRemovals = true;
    if (!seen.has(snapshot.oid)) {
      seen.add(snapshot.oid);
      oids.push(snapshot.oid);
    }
  }
  const sizes: number[] = [];
  const sizeByOid = new Map<string, number>();
  for (const object of repo.store.objectInfo(oids)) {
    if (object.type !== "blob") {
      throw new CorruptError(`merge abort object ${object.oid} is not a blob`);
    }
    sizes.push(object.size);
    sizeByOid.set(object.oid, object.size);
  }
  let bytes = 0;
  for (const entry of touched) {
    const snapshot = entry.worktree;
    if (snapshot.kind !== "file" && snapshot.kind !== "symlink") continue;
    const size = sizeByOid.get(snapshot.oid);
    if (size === undefined) throw new CorruptError(`merge abort lost object ${snapshot.oid}`);
    bytes += size;
    if (!Number.isSafeInteger(bytes)) throw new GitError("E2BIG", "merge abort size overflow");
  }
  const blobReadCalls = boundedReadCalls(sizes, MAX_MERGE_APPLY_BLOB_READ_CALLS, "blob");
  return {
    worktreeScanPages,
    blobReadCalls,
    worktreeWriteCalls: blobReadCalls + (directories > 0 ? 1 : 0),
    worktreeWriteBytes: bytes,
    indexMutations: touched.length * 2,
    hasRemovals,
    clearState,
  };
}

/** Restore only journal-owned paths; the caller supplies the atomic transaction. */
export function abortProjectedMerge(
  repo: Repository,
  worktree: Worktree,
  journal: MergeJournal,
): void {
  validateJournal(journal);
  const calls: ReadCallBudget = { snapshot: 0, blobs: 0 };
  validateJournalObjects(repo, journal);
  const specs = journal.touched.map((entry) => ({
    path: entry.path,
    logicalPath: entry.logicalPath,
    purpose: entry.purpose,
  }));
  const owned = journal.touched
    .filter((entry) => entry.worktree.kind === "absent")
    .map((entry) => entry.path);
  const current = worktreeSnapshotScan(
    repo,
    worktree,
    specs,
    abortDestructiveRoots(journal.touched),
    owned,
  );
  restoreWorktree(repo, worktree, journal.touched, current.entries, calls);
  restoreIndex(repo, journal.touched);
  repo.store.clearMergeState();
}

/** Restore one authenticated operation snapshot; the caller owns state clearing. */
export function restoreProjectedOperation(
  repo: Repository,
  worktree: Worktree,
  journal: OperationJournal,
  options: OperationRestoreOptions = {},
): void {
  const retainedBytes = operationJournalRetainedBytes(
    journal.state,
    journal.touched,
    journal.steps,
  );
  if (retainedBytes !== journal.retainedBytes) {
    throw new CorruptError("operation journal retained-byte count is stale");
  }
  if (
    operationJournalIntegrityOid(journal.state, journal.touched, journal.steps) !==
    journal.integrityOid
  ) {
    throw new CorruptError("operation journal integrity identity is stale");
  }
  let previous: string | null = null;
  for (const entry of journal.touched) {
    if (previous !== null && comparePaths(previous, entry.path) >= 0) {
      throw new CorruptError("operation journal paths are not in strict Git path order");
    }
    previous = entry.path;
  }
  const calls: ReadCallBudget = { snapshot: 0, blobs: 0 };
  const specs = journal.touched.map((entry) => ({
    path: entry.path,
    logicalPath: entry.logicalPath,
    purpose: entry.purpose,
  }));
  const owned = journal.touched
    .filter((entry) => entry.worktree.kind === "absent")
    .map((entry) => entry.path);
  const current = worktreeSnapshotScan(
    repo,
    worktree,
    specs,
    abortDestructiveRoots(journal.touched),
    owned,
  );
  const estimate = calculateOperationRestoreSqlStatements(
    options.priorSqlStatements ?? 0,
    restoreSqlInput(
      repo,
      journal.touched,
      current.entries,
      current.pages,
      options.clearState ?? false,
    ),
  );
  if (estimate.totalSqlStatements >= 1_000) {
    throw new GitError(
      "E2BIG",
      `merge restore SQL model requires ${estimate.totalSqlStatements} statements`,
    );
  }
  restoreWorktree(repo, worktree, journal.touched, current.entries, calls);
  restoreIndex(repo, journal.touched);
}
