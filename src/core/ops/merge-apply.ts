// Atomic low-level application and restoration of one projected merge plan.

import type { WriteEntry } from "../../fs/types.js";
import {
  type IndexEntry,
  type IndexSink,
  type IndexStore,
  MAX_BLOB_BATCH_BYTES,
} from "../../sqlite/store.js";
import { fromHex, isOid, utf8, utf8Decoder } from "../bytes.js";
import { CorruptError, GitError, hasErrorCode } from "../errors.js";
import { hashObject, MODE_COMMIT, MODE_EXECUTABLE, MODE_FILE, MODE_SYMLINK } from "../objects.js";
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
export const MAX_MERGE_APPLY_CONTENT_BYTES = 32 * 1024 * 1024;

export type MergeApplyMetadata = Omit<MergeStateMetadata, "phase">;
export type MergeApplyOutcome = "clean" | "conflicted" | "ready";

export interface MergeApplyResult {
  outcome: MergeApplyOutcome;
  journal: MergeJournal | null;
}

export interface OperationApplyOptions {
  suspendedState: OperationStateMetadata | null;
}

interface ActiveRebaseApply {
  expectedIntegrityOid: string;
  conflictState: RebaseStateMetadata | null;
  steps: readonly OperationStepMetadata[];
}

export interface OperationApplyResult {
  touched: readonly MergeTouchedPath[] | null;
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

interface WorktreeSnapshotScan {
  entries: Map<string, WorktreeStat>;
}

interface IndexSnapshots {
  entries: Map<string, MergeIndexSnapshot>;
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

export function validateProjectedIndexEntries(entries: readonly ProjectedMergeEntry[]): void {
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
    if (
      entry.content !== null &&
      entry.stageZero !== null &&
      hashObject("blob", entry.content) !== entry.stageZero.oid
    ) {
      throw new CorruptError(`merged content identity does not match ${entry.path}`);
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
  if (last === undefined) return { entries: found };
  const lastAbsolute = joinPath(root, last.path);
  let after: string | undefined;
  while (true) {
    const page = worktree.scan(root, { after, limit: APPLY_SCAN_PAGE });
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
    if (after !== undefined && comparePaths(tail.path, after) <= 0) {
      throw new CorruptError("merge worktree scan cursor made no progress");
    }
    if (
      comparePaths(tail.path, lastAbsolute) > 0 &&
      destructiveOwner(tail.path, absoluteDestructive) === null
    ) {
      break;
    }
    after = tail.path;
  }
  return { entries: found };
}

function indexSnapshots(repo: Repository, specs: readonly TouchedSpec[]): IndexSnapshots {
  const wanted = new Set(specs.map((spec) => spec.path));
  const found = new Map<string, MergeIndexSnapshot>();
  const last = specs[specs.length - 1];
  if (last === undefined) return { entries: found };
  for (const entry of repo.checkout.indexScan()) {
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
  return { entries: found };
}

function snapshotWorktreeObjects(
  repo: Repository,
  worktree: Worktree,
  root: string,
  drafts: readonly SnapshotDraft[],
): Map<string, string> {
  const oids = new Map<string, string>();
  const files: string[] = [];
  const snapshotLimit = 4 * MAX_BLOB_BATCH_BYTES;
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

function validateSourceBlobs(repo: Repository, entries: readonly ProjectedMergeEntry[]): void {
  const seen = new Set<string>();
  const oids: string[] = [];
  for (const entry of entries) {
    const identity = entry.content === null ? entry.worktree : null;
    if (identity === null || seen.has(identity.oid)) continue;
    seen.add(identity.oid);
    oids.push(identity.oid);
  }
  if (oids.length === 0) return;
  const sizeByOid = new Map<string, number>();
  for (const object of repo.store.objectInfo(oids)) {
    if (object.type !== "blob") {
      throw new CorruptError(`merge output object ${object.oid} is not a blob`);
    }
    if (object.size > MAX_BLOB_BATCH_BYTES) {
      throw new GitError("E2BIG", `merge blob object exceeds ${MAX_BLOB_BATCH_BYTES} bytes`);
    }
    sizeByOid.set(object.oid, object.size);
  }
  for (const entry of entries) {
    const identity = entry.content === null ? entry.worktree : null;
    if (identity === null) continue;
    const size = sizeByOid.get(identity.oid);
    if (size === undefined) throw new CorruptError(`merge output lost object ${identity.oid}`);
  }
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
  index: IndexStore,
  entries: readonly ProjectedMergeEntry[],
  specs: readonly TouchedSpec[],
): void {
  const projected = new Set(entries.map((entry) => entry.path));
  index.indexApply((sink) => {
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

/** Write a validated clean projection to one caller-selected index. */
export function applyProjectedIndex(
  repo: Repository,
  index: IndexStore,
  entries: readonly ProjectedMergeEntry[],
): void {
  validateProjectedIndexEntries(entries);
  if (entries.some((entry) => entry.stages !== null)) {
    throw new GitError("EUNMERGED", "cannot apply a conflicted projection to an index");
  }
  const specs = touchedSpecs(entries);
  repo.store.runScratchAwareOperation(() =>
    repo.store.db.transactionSync(() => {
      contentObjects(repo, entries);
      applyIndex(index, entries, specs);
    }),
  );
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
  validateProjectedIndexEntries(entries);
  if (activeRebase === null) {
    repo.checkout.requireNoOperationState();
  } else {
    if (options.suspendedState !== null) {
      throw new CorruptError("rebase apply supplied two journal transitions");
    }
    const current = repo.checkout.requireOperationState("rebase");
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
  let drafts: SnapshotDraft[] = [];
  let previewTouched: MergeTouchedPath[] = [];
  if (suspendedState !== null) {
    const index = indexSnapshots(repo, specs);
    drafts = specs.map((spec) => ({
      spec,
      index: index.entries.get(spec.path) ?? null,
      stat: worktreeRows.entries.get(spec.path) ?? null,
    }));
    previewTouched = touchedFromDrafts(drafts, null);
  }

  validateSourceBlobs(repo, entries);
  const removals = structuralRemovals(entries, worktreeRows.entries);
  if (suspendedState !== null) {
    operationJournalRetainedBytes(suspendedState, previewTouched, suspendedSteps);
  }

  let touched: readonly MergeTouchedPath[] | null = null;
  if (suspendedState !== null) {
    const root = worktree.realpath(repo.root);
    const snapshotOids = snapshotWorktreeObjects(repo, worktree, root, drafts);
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
  materialiseWrites(repo, worktree, entries, contentOids);
  applyIndex(repo.checkout, entries, specs);
  if (touched !== null) {
    if (suspendedState === null) throw new CorruptError("operation snapshot lost its state");
    if (activeRebase === null) {
      repo.checkout.writeOperationState(suspendedState, touched);
    } else {
      repo.checkout.replaceOperationJournal(
        activeRebase.expectedIntegrityOid,
        suspendedState,
        activeRebase.steps,
        touched,
      );
    }
  }
  return { touched };
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
      { suspendedState: null },
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
): MergeApplyResult {
  const outcome = outcomeOf(entries, metadata.mode);
  if (outcome === "clean") {
    validateMergeStateMetadata({ ...metadata, phase: "conflicted" });
  }
  const state = outcome === "clean" ? null : metadataForOutcome(metadata, outcome);
  const applied = applyProjectedOperation(repo, worktree, entries, {
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
  return { outcome, journal };
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
  repo.checkout.indexApply((sink) => {
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

function validateRestoreBlobs(repo: Repository, touched: readonly MergeTouchedPath[]): void {
  const oids: string[] = [];
  const seen = new Set<string>();
  for (const entry of touched) {
    const snapshot = entry.worktree;
    if (snapshot.kind !== "file" && snapshot.kind !== "symlink") continue;
    if (!seen.has(snapshot.oid)) {
      seen.add(snapshot.oid);
      oids.push(snapshot.oid);
    }
  }
  const found = new Set<string>();
  for (const object of repo.store.objectInfo(oids)) {
    if (object.type !== "blob") {
      throw new CorruptError(`merge abort object ${object.oid} is not a blob`);
    }
    if (object.size > MAX_BLOB_BATCH_BYTES) {
      throw new GitError("E2BIG", `merge blob object exceeds ${MAX_BLOB_BATCH_BYTES} bytes`);
    }
    found.add(object.oid);
  }
  for (const oid of oids) {
    if (!found.has(oid)) throw new CorruptError(`merge abort lost object ${oid}`);
  }
}

/** Restore only journal-owned paths; the caller supplies the atomic transaction. */
export function abortProjectedMerge(
  repo: Repository,
  worktree: Worktree,
  journal: MergeJournal,
): void {
  validateJournal(journal);
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
  restoreWorktree(repo, worktree, journal.touched, current.entries);
  restoreIndex(repo, journal.touched);
  repo.checkout.clearMergeState();
}

/** Restore one authenticated operation snapshot; the caller owns state clearing. */
export function restoreProjectedOperation(
  repo: Repository,
  worktree: Worktree,
  journal: OperationJournal,
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
  validateRestoreBlobs(repo, journal.touched);
  restoreWorktree(repo, worktree, journal.touched, current.entries);
  restoreIndex(repo, journal.touched);
}
