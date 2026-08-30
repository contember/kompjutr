// Atomic low-level application and restoration of one projected merge plan.

import { nativeRealpathOwned, nativeScanOwned } from "../../fs/store/owned-read.js";
import { scanPageRetainedBytes } from "../../fs/store/scan.js";
import type { RealPath, ScanEntry, WriteEntry } from "../../fs/types.js";
import type { MemoryReservation } from "../../memory.js";
import {
  type IndexEntry,
  type IndexSink,
  type IndexStore,
  indexScanOwned,
  MAX_BLOB_BATCH_BYTES,
  readOperationStateOwned,
  replaceOperationJournalOwned,
  writeObjectsOwned,
  writeOperationJournalOwned,
} from "../../sqlite/store.js";
import { fromHex, isOid, utf8Decoder } from "../bytes.js";
import { CorruptError, GitError, hasErrorCode } from "../errors.js";
import { hashObject, MODE_COMMIT, MODE_EXECUTABLE, MODE_FILE, MODE_SYMLINK } from "../objects.js";
import { joinPath, relativeTo } from "../paths.js";
import type { Repository } from "../repository.js";
import { retainedStringBytes } from "../retained.js";
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
  operationKindMismatch,
  operationNotActive,
  operationStepsForState,
  type RebaseStateMetadata,
  validateOperationStepMetadata,
} from "./operation-state.js";
import { type HashedPath, hashExactWorktreePathsOwned } from "./worktree-io.js";

const APPLY_SCAN_PAGE = 1_000;
const COLLECTION_BASE_BYTES = 128;
const COLLECTION_ENTRY_BYTES = 96;
const OBJECT_BYTES = 192;
const ARRAY_SLOT_BYTES = 8;
const OBJECT_INFO_PAGE = 4_096;
const OPERATION_STATE_FIXED_BYTES = 2 * 1024;
const TOUCHED_DRAFT_FIXED_BYTES = 1024;

export type MergeApplyMetadata = Omit<MergeStateMetadata, "phase">;
export type MergeApplyOutcome = "clean" | "conflicted" | "ready";

export interface MergeApplyResult {
  outcome: MergeApplyOutcome;
  journal: MergeJournal | null;
}

export interface OperationApplyOptions {
  suspendedState: OperationStateMetadata | null;
}

type ApplyMemoryOwner = MemoryReservation | undefined;

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

interface TouchedSpecs {
  entries: TouchedSpec[];
  dispose(): void;
}

interface WorktreeSnapshotScan {
  entries: Map<string, WorktreeStat>;
  dispose(): void;
}

interface IndexSnapshots {
  entries: Map<string, MergeIndexSnapshot>;
  dispose(): void;
}

interface SnapshotObjects {
  entries: Map<string, HashedPath>;
  dispose(): void;
}

interface ContentObjects {
  entries: Map<string, string>;
  dispose(): void;
}

interface BlobMetadata {
  sizes: ReadonlyMap<string, number>;
  dispose(): void;
}

interface AdmittedBlobBatch {
  end: number;
  blobs: ReadonlyMap<string, Uint8Array>;
  dispose(): void;
}

interface OwnedPaths {
  entries: string[];
  dispose(): void;
}

function checkedMemoryBytes(current: number, added: number, label: string): number {
  if (
    !Number.isSafeInteger(current) ||
    current < 0 ||
    !Number.isSafeInteger(added) ||
    added < 0 ||
    added > Number.MAX_SAFE_INTEGER - current
  ) {
    throw new GitError("E2BIG", `${label} memory accounting overflow`);
  }
  return current + added;
}

function retainedArrayBytes(length: number): number {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new GitError("E2BIG", "merge apply array memory accounting overflow");
  }
  return checkedMemoryBytes(COLLECTION_BASE_BYTES, length * ARRAY_SLOT_BYTES, "merge apply array");
}

function retainedIdentityBytes(identity: { mode: string; oid: string }): number {
  return checkedMemoryBytes(
    OBJECT_BYTES,
    retainedStringBytes(identity.mode) + retainedStringBytes(identity.oid),
    "projected merge identity",
  );
}

function projectedEntriesRetainedBytes(entries: readonly ProjectedMergeEntry[]): number {
  let bytes = retainedArrayBytes(entries.length);
  for (const entry of entries) {
    bytes = checkedMemoryBytes(
      bytes,
      OBJECT_BYTES + retainedStringBytes(entry.path) + retainedStringBytes(entry.logicalPath),
      "projected merge entries",
    );
    if (entry.stageZero !== null) {
      bytes = checkedMemoryBytes(
        bytes,
        retainedIdentityBytes(entry.stageZero),
        "projected merge entries",
      );
    }
    if (entry.stages !== null) {
      bytes = checkedMemoryBytes(bytes, OBJECT_BYTES, "projected merge entries");
      for (const identity of [entry.stages.base, entry.stages.current, entry.stages.incoming]) {
        if (identity !== null) {
          bytes = checkedMemoryBytes(
            bytes,
            retainedIdentityBytes(identity),
            "projected merge entries",
          );
        }
      }
    }
    if (entry.worktree !== null) {
      bytes = checkedMemoryBytes(
        bytes,
        retainedIdentityBytes(entry.worktree),
        "projected merge entries",
      );
    }
    if (entry.content !== null) {
      bytes = checkedMemoryBytes(
        bytes,
        OBJECT_BYTES + entry.content.byteLength,
        "projected merge entries",
      );
    }
  }
  return bytes;
}

function withApplyMemory<T>(
  repo: Repository,
  owner: ApplyMemoryOwner,
  localCallerRetainedBytes: number,
  body: (reservation: MemoryReservation) => T,
  retainsResult: (result: T) => boolean,
): T {
  const reservation =
    owner === undefined ? repo.store.reserveMemory() : repo.store.scopeMemoryReservation(owner);
  let keep = false;
  try {
    if (owner === undefined) reservation.set("other", localCallerRetainedBytes);
    const result = body(reservation);
    keep = owner !== undefined && retainsResult(result);
    return result;
  } finally {
    if (!keep) reservation.dispose();
  }
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
    previous = entry.path;
  }
}

function canonicalUtf8Length(value: string, label: string): number {
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
    if (!Number.isSafeInteger(bytes)) {
      throw new GitError("E2BIG", `${label} memory accounting overflow`);
    }
  }
  return bytes;
}

function operationIdentityRetainedBytes(identity: { name: string; email: string } | null): number {
  if (identity === null) return 0;
  return checkedMemoryBytes(
    canonicalUtf8Length(identity.name, "operation identity name"),
    canonicalUtf8Length(identity.email, "operation identity email"),
    "operation identity",
  );
}

function operationHeaderDraftRetainedBytes(state: OperationStateMetadata): number {
  let bytes = OPERATION_STATE_FIXED_BYTES;
  for (const value of [
    state.originalHeadRef,
    state.currentLabel,
    state.incomingLabel,
    state.message,
  ]) {
    bytes = checkedMemoryBytes(
      bytes,
      canonicalUtf8Length(value, "operation journal text"),
      "operation journal header",
    );
  }
  bytes = checkedMemoryBytes(bytes, 40, "operation journal header");
  bytes = checkedMemoryBytes(
    bytes,
    operationIdentityRetainedBytes(state.author),
    "operation journal header",
  );
  bytes = checkedMemoryBytes(
    bytes,
    operationIdentityRetainedBytes(state.committer),
    "operation journal header",
  );
  if (state.kind === "merge") {
    return checkedMemoryBytes(bytes, 80 + state.mergeOrigin.length, "operation journal header");
  }
  return state.kind === "rebase"
    ? checkedMemoryBytes(bytes, 120, "operation journal header")
    : bytes;
}

function operationJournalDraftRetainedBytes(
  state: OperationStateMetadata,
  drafts: readonly SnapshotDraft[],
  steps: readonly OperationStepMetadata[] | undefined,
): number {
  let bytes = operationHeaderDraftRetainedBytes(state);
  const sequence = steps ?? (state.kind === "rebase" ? [] : operationStepsForState(state));
  for (const step of sequence) {
    bytes = checkedMemoryBytes(
      bytes,
      validateOperationStepMetadata(step),
      "operation journal steps",
    );
  }
  for (const draft of drafts) {
    let touchedBytes = TOUCHED_DRAFT_FIXED_BYTES;
    touchedBytes = checkedMemoryBytes(
      touchedBytes,
      canonicalUtf8Length(draft.spec.path, "operation touched path") * 2,
      "operation touched draft",
    );
    touchedBytes = checkedMemoryBytes(
      touchedBytes,
      canonicalUtf8Length(draft.spec.logicalPath, "operation logical path") * 2,
      "operation touched draft",
    );
    if (draft.index !== null) {
      touchedBytes = checkedMemoryBytes(touchedBytes, 256, "operation touched draft");
    }
    if (draft.stat !== null) {
      touchedBytes = checkedMemoryBytes(
        touchedBytes,
        draft.stat.type === "dir" ? 128 : 256,
        "operation touched draft",
      );
    }
    bytes = checkedMemoryBytes(bytes, touchedBytes, "operation journal touched drafts");
  }
  return bytes;
}

function touchedSpecs(
  entries: readonly ProjectedMergeEntry[],
  reservation: MemoryReservation,
): TouchedSpecs {
  const memory = reservation.scope();
  let retainedBytes = COLLECTION_BASE_BYTES;
  memory.set("other", retainedBytes);
  const byPath = new Map<string, TouchedSpec>();
  const retain = (
    path: string,
    logicalPath: string,
    purpose: MergeTouchedPath["purpose"],
    ownedStringBytes: number,
  ): void => {
    if (byPath.has(path)) return;
    if (byPath.size >= MAX_MERGE_TOUCHED_PATHS) {
      throw new GitError("E2BIG", `merge journal exceeds ${MAX_MERGE_TOUCHED_PATHS} touched paths`);
    }
    retainedBytes = checkedMemoryBytes(
      retainedBytes,
      COLLECTION_ENTRY_BYTES + OBJECT_BYTES + ownedStringBytes,
      "merge touched paths",
    );
    memory.set("other", retainedBytes);
    const spec: TouchedSpec = { path, logicalPath, purpose };
    byPath.set(spec.path, spec);
  };
  const retainAncestor = (path: string): void => {
    let slash = path.lastIndexOf("/");
    while (slash > 0) {
      const sliceMemory = reservation.scope();
      sliceMemory.set("other", 48 + slash * 2);
      try {
        const ancestor = path.slice(0, slash);
        retain(ancestor, ancestor, "primary", retainedStringBytes(ancestor));
        slash = ancestor.lastIndexOf("/");
      } finally {
        sliceMemory.dispose();
      }
    }
  };
  for (const entry of entries) {
    retain(entry.path, entry.logicalPath, entry.purpose, 0);
    if (entry.purpose !== "primary" && !byPath.has(entry.logicalPath)) {
      retain(entry.logicalPath, entry.logicalPath, "primary", 0);
    }
    retainAncestor(entry.path);
    retainAncestor(entry.logicalPath);
  }
  retainedBytes = checkedMemoryBytes(
    retainedBytes,
    retainedArrayBytes(byPath.size),
    "merge touched paths",
  );
  memory.set("other", retainedBytes);
  const specs = [...byPath.values()].sort((left, right) => comparePaths(left.path, right.path));
  return { entries: specs, dispose: () => memory.dispose() };
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

function pathDescendsFrom(path: string, root: string): boolean {
  return path.length > root.length && path.startsWith(root) && path.charCodeAt(root.length) === 47;
}

function worktreeRealpathOwned(
  worktree: Worktree,
  path: string,
  reservation: MemoryReservation,
): RealPath {
  const native = nativeRealpathOwned(worktree, path, reservation);
  if (native !== null) return native;
  const resolved = worktree.realpath(path);
  reservation.set("other", retainedStringBytes(resolved));
  return resolved;
}

function worktreeScanPageOwned(
  worktree: Worktree,
  root: RealPath,
  after: string | undefined,
  reservation: MemoryReservation,
): ScanEntry[] {
  const native = nativeScanOwned(worktree, root, { after, limit: APPLY_SCAN_PAGE }, reservation);
  if (native !== null) return native;
  const page = worktree.scan(root, { after, limit: APPLY_SCAN_PAGE });
  reservation.set("other", scanPageRetainedBytes(page));
  return page;
}

function retainedScanEntryBytes(entry: ScanEntry): number {
  return scanPageRetainedBytes([entry]) - scanPageRetainedBytes([]);
}

function worktreeSnapshotScan(
  repo: Repository,
  worktree: Worktree,
  specs: readonly TouchedSpec[],
  destructiveRoots: readonly string[],
  ownedPaths: readonly string[],
  reservation: MemoryReservation,
): WorktreeSnapshotScan {
  const memory = reservation.scope();
  const rootMemory = memory.scope();
  const root = worktreeRealpathOwned(worktree, repo.root, rootMemory);
  let destructiveCount = 0;
  let previousDestructive: string | null = null;
  let structureBytes = COLLECTION_BASE_BYTES * 2;
  for (const spec of specs) {
    structureBytes = checkedMemoryBytes(
      structureBytes,
      COLLECTION_ENTRY_BYTES + retainedJoinedPathBytes(root, spec.path),
      "merge worktree scan",
    );
  }
  for (const path of destructiveRoots) {
    if (previousDestructive !== null && pathDescendsFrom(path, previousDestructive)) continue;
    previousDestructive = path;
    destructiveCount++;
    structureBytes = checkedMemoryBytes(
      structureBytes,
      ARRAY_SLOT_BYTES + retainedJoinedPathBytes(root, path),
      "merge worktree scan",
    );
  }
  structureBytes = checkedMemoryBytes(
    structureBytes,
    COLLECTION_BASE_BYTES + ownedPaths.length * COLLECTION_ENTRY_BYTES,
    "merge worktree scan",
  );
  memory.set("other", structureBytes);
  const absoluteToRelative = new Map<string, string>();
  const absoluteDestructive: string[] = [];
  const exactOwned = new Set<string>();
  let lastAbsolute: string | null = null;
  for (const spec of specs) {
    const absolute = joinPath(root, spec.path);
    absoluteToRelative.set(absolute, spec.path);
    lastAbsolute = absolute;
  }
  previousDestructive = null;
  for (const path of destructiveRoots) {
    if (previousDestructive !== null && pathDescendsFrom(path, previousDestructive)) continue;
    previousDestructive = path;
    absoluteDestructive.push(joinPath(root, path));
  }
  absoluteDestructive.sort(comparePaths);
  if (absoluteDestructive.length !== destructiveCount) {
    throw new CorruptError("merge destructive root accounting differs from its selection");
  }
  for (const path of ownedPaths) exactOwned.add(path);
  let foundBytes = COLLECTION_BASE_BYTES;
  const foundMemory = reservation.scope();
  foundMemory.set("other", foundBytes);
  const found = new Map<string, WorktreeStat>();
  if (lastAbsolute === null) {
    rootMemory.dispose();
    memory.dispose();
    return { entries: found, dispose: () => foundMemory.dispose() };
  }
  const cursorMemory = memory.scope();
  let after: string | undefined;
  while (true) {
    const pageMemory = memory.scope();
    const page = worktreeScanPageOwned(worktree, root, after, pageMemory);
    if (page.length === 0) {
      pageMemory.dispose();
      break;
    }
    let transferredBytes = 0;
    for (const entry of page) {
      const relative = relativeTo(root, entry.path);
      if (relative === null) throw new CorruptError("worktree scan escaped the repository root");
      const exact = absoluteToRelative.get(entry.path);
      if (exact !== undefined && !found.has(exact)) {
        foundBytes = checkedMemoryBytes(
          foundBytes,
          COLLECTION_ENTRY_BYTES,
          "merge worktree snapshots",
        );
        foundMemory.set("other", foundBytes);
        transferredBytes = checkedMemoryBytes(
          transferredBytes,
          retainedScanEntryBytes(entry),
          "merge worktree snapshots",
        );
        found.set(exact, entry);
      }
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
    const finished = tail === undefined || page.length < APPLY_SCAN_PAGE;
    if (tail !== undefined && after !== undefined && comparePaths(tail.path, after) <= 0) {
      throw new CorruptError("merge worktree scan cursor made no progress");
    }
    const beyondOwned =
      tail !== undefined &&
      comparePaths(tail.path, lastAbsolute) > 0 &&
      destructiveOwner(tail.path, absoluteDestructive) === null;
    if (!finished && !beyondOwned && tail !== undefined) {
      cursorMemory.set("other", retainedStringBytes(tail.path));
      after = tail.path;
    }
    pageMemory.dispose();
    foundBytes = checkedMemoryBytes(foundBytes, transferredBytes, "merge worktree snapshots");
    foundMemory.set("other", foundBytes);
    if (finished || beyondOwned) break;
  }
  rootMemory.dispose();
  memory.dispose();
  return { entries: found, dispose: () => foundMemory.dispose() };
}

function indexSnapshots(
  repo: Repository,
  specs: readonly TouchedSpec[],
  reservation: MemoryReservation,
): IndexSnapshots {
  const memory = reservation.scope();
  let retainedBytes =
    COLLECTION_BASE_BYTES + COLLECTION_BASE_BYTES + specs.length * COLLECTION_ENTRY_BYTES;
  memory.set("other", retainedBytes);
  const wanted = new Set<string>();
  const found = new Map<string, MergeIndexSnapshot>();
  for (const spec of specs) wanted.add(spec.path);
  const last = specs[specs.length - 1];
  if (last === undefined) return { entries: found, dispose: () => memory.dispose() };
  for (const entry of indexScanOwned(repo.checkout, memory)) {
    if (comparePaths(entry.path, last.path) > 0) break;
    if (!wanted.has(entry.path)) continue;
    if (entry.stage !== 0) {
      throw new GitError("EUNMERGED", "cannot apply a merge over unmerged index entries");
    }
    retainedBytes = checkedMemoryBytes(
      retainedBytes,
      COLLECTION_ENTRY_BYTES +
        OBJECT_BYTES +
        retainedStringBytes(entry.path) +
        retainedStringBytes(entry.oid),
      "merge index snapshots",
    );
    memory.set("other", retainedBytes);
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
  return { entries: found, dispose: () => memory.dispose() };
}

function snapshotWorktreeObjects(
  repo: Repository,
  worktree: Worktree,
  drafts: readonly SnapshotDraft[],
  reservation: MemoryReservation,
): SnapshotObjects {
  const snapshotMemory = reservation.scope();
  const pathsMemory = reservation.scope();
  let retainedBytes = retainedArrayBytes(drafts.length);
  pathsMemory.set("other", retainedBytes);
  const paths: { path: string; stat: WorktreeStat }[] = [];
  for (const draft of drafts) {
    const stat = draft.stat;
    if (stat?.type === "symlink") {
      if (stat.target === null) {
        throw new CorruptError(`worktree symlink ${draft.spec.path} has no target`);
      }
      canonicalUtf8Length(stat.target, `merge snapshot symlink ${draft.spec.path}`);
    }
    if (stat?.type === "file" || stat?.type === "symlink") {
      retainedBytes = checkedMemoryBytes(retainedBytes, OBJECT_BYTES, "merge snapshot inputs");
      pathsMemory.set("other", retainedBytes);
      paths.push({ path: draft.spec.path, stat });
    }
  }
  const hashed = hashExactWorktreePathsOwned(repo, worktree, paths, snapshotMemory, {
    write: true,
  });
  pathsMemory.dispose();
  for (const draft of drafts) {
    if (
      (draft.stat?.type === "file" || draft.stat?.type === "symlink") &&
      !hashed.has(draft.spec.path)
    ) {
      throw new CorruptError(`merge snapshot lost worktree path ${draft.spec.path}`);
    }
  }
  return { entries: hashed, dispose: () => snapshotMemory.dispose() };
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
  snapshots: ReadonlyMap<string, HashedPath> | null,
): MergeTouchedPath[] {
  return drafts.map((draft) => ({
    path: draft.spec.path,
    logicalPath: draft.spec.logicalPath,
    purpose: draft.spec.purpose,
    index: draft.index,
    worktree: worktreeSnapshot(
      draft,
      snapshots === null ? "0".repeat(40) : snapshots.get(draft.spec.path)?.oid,
    ),
  }));
}

function collectBlobMetadata<T>(
  repo: Repository,
  entries: readonly T[],
  oidOf: (entry: T) => string | null,
  label: "merge output" | "merge abort",
  reservation: MemoryReservation,
): BlobMetadata {
  const retainedMemory = reservation.scope();
  const buildMemory = reservation.scope();
  let buildBytes = COLLECTION_BASE_BYTES * 2;
  buildMemory.set("other", buildBytes);
  const seen = new Set<string>();
  const oids: string[] = [];
  try {
    for (const entry of entries) {
      const oid = oidOf(entry);
      if (oid === null || seen.has(oid)) continue;
      buildBytes = checkedMemoryBytes(
        buildBytes,
        COLLECTION_ENTRY_BYTES + ARRAY_SLOT_BYTES,
        `${label} metadata inputs`,
      );
      buildMemory.set("other", buildBytes);
      seen.add(oid);
      oids.push(oid);
    }

    let retainedBytes = COLLECTION_BASE_BYTES;
    retainedMemory.set("other", retainedBytes);
    const sizes = new Map<string, number>();
    for (let offset = 0; offset < oids.length; offset += OBJECT_INFO_PAGE) {
      const length = Math.min(OBJECT_INFO_PAGE, oids.length - offset);
      const pageMemory = reservation.scope();
      let pageBytes = retainedArrayBytes(length);
      for (let ordinal = 0; ordinal < length; ordinal++) {
        const oid = oids[offset + ordinal];
        if (oid === undefined) throw new CorruptError(`${label} metadata input is incomplete`);
        pageBytes = checkedMemoryBytes(
          pageBytes,
          OBJECT_BYTES + retainedStringBytes(oid),
          `${label} metadata page`,
        );
      }
      pageMemory.set("other", pageBytes);
      try {
        const page = oids.slice(offset, offset + length);
        for (const object of repo.store.objectInfo(page)) {
          if (object.type !== "blob") {
            throw new CorruptError(`${label} object ${object.oid} is not a blob`);
          }
          if (object.size > MAX_BLOB_BATCH_BYTES) {
            throw new GitError("E2BIG", `merge blob object exceeds ${MAX_BLOB_BATCH_BYTES} bytes`);
          }
          retainedBytes = checkedMemoryBytes(
            retainedBytes,
            COLLECTION_ENTRY_BYTES + retainedStringBytes(object.oid),
            `${label} metadata`,
          );
          retainedMemory.set("other", retainedBytes);
          sizes.set(object.oid, object.size);
        }
      } finally {
        pageMemory.dispose();
      }
    }
    for (const oid of oids) {
      if (!sizes.has(oid)) throw new CorruptError(`${label} lost object ${oid}`);
    }
    return { sizes, dispose: () => retainedMemory.dispose() };
  } catch (error) {
    retainedMemory.dispose();
    throw error;
  } finally {
    buildMemory.dispose();
  }
}

function validateSourceBlobs(
  repo: Repository,
  entries: readonly ProjectedMergeEntry[],
  reservation: MemoryReservation,
): BlobMetadata {
  return collectBlobMetadata(
    repo,
    entries,
    (entry) => (entry.content === null ? (entry.worktree?.oid ?? null) : null),
    "merge output",
    reservation,
  );
}

function retainedJoinedPathBytes(root: string, path: string): number {
  return 48 + (root.length + path.length + 1) * 2;
}

function blobBatchRetainedBytes<T>(
  repo: Repository,
  entries: readonly T[],
  start: number,
  end: number,
  oidCount: number,
  resultCount: number,
  remainingCount: number,
  payloadBytes: number,
  pathOf: (entry: T) => string,
  symlinkOf: (entry: T) => boolean,
  sizeOf: (entry: T) => number,
  label: string,
): number {
  let bytes = COLLECTION_BASE_BYTES * 4;
  bytes = checkedMemoryBytes(bytes, retainedArrayBytes(oidCount), label);
  bytes = checkedMemoryBytes(bytes, retainedArrayBytes(end - start), label);
  bytes = checkedMemoryBytes(bytes, retainedArrayBytes(remainingCount), label);
  bytes = checkedMemoryBytes(
    bytes,
    (oidCount * 2 + resultCount * 2) * COLLECTION_ENTRY_BYTES,
    label,
  );
  bytes = checkedMemoryBytes(bytes, payloadBytes, label);
  for (let index = start; index < end; index++) {
    const entry = entries[index];
    if (entry === undefined) throw new CorruptError(`${label} selection is incomplete`);
    let writeBytes = OBJECT_BYTES + 20 + retainedJoinedPathBytes(repo.root, pathOf(entry));
    if (symlinkOf(entry)) {
      writeBytes = checkedMemoryBytes(writeBytes, 48 + sizeOf(entry) * 2, label);
    }
    bytes = checkedMemoryBytes(bytes, writeBytes, label);
  }
  return bytes;
}

function readAdmittedBlobBatch<T>(
  repo: Repository,
  entries: readonly T[],
  start: number,
  metadata: BlobMetadata,
  reservation: MemoryReservation,
  pathOf: (entry: T) => string,
  oidOf: (entry: T) => string,
  symlinkOf: (entry: T) => boolean,
  label: string,
): AdmittedBlobBatch {
  const memory = reservation.scope();
  let end = start;
  let payloadBytes = 0;
  memory.set(
    "other",
    blobBatchRetainedBytes(
      repo,
      entries,
      start,
      start,
      0,
      0,
      0,
      0,
      pathOf,
      symlinkOf,
      () => 0,
      label,
    ),
  );
  const selected = new Set<string>();
  try {
    while (end < entries.length) {
      const entry = entries[end];
      if (entry === undefined) throw new CorruptError(`${label} selection is incomplete`);
      const oid = oidOf(entry);
      const size = metadata.sizes.get(oid);
      if (size === undefined) throw new CorruptError(`${label} lost object ${oid}`);
      const nextPayload = selected.has(oid)
        ? payloadBytes
        : checkedMemoryBytes(payloadBytes, size, label);
      if (nextPayload > MAX_BLOB_BATCH_BYTES && end > start) break;
      const nextOids = selected.has(oid) ? selected.size : selected.size + 1;
      if (nextOids > OBJECT_INFO_PAGE && end > start) break;
      const nextBytes = blobBatchRetainedBytes(
        repo,
        entries,
        start,
        end + 1,
        nextOids,
        nextOids,
        0,
        nextPayload,
        pathOf,
        symlinkOf,
        (candidate) => {
          const candidateSize = metadata.sizes.get(oidOf(candidate));
          if (candidateSize === undefined) {
            throw new CorruptError(`${label} lost object ${oidOf(candidate)}`);
          }
          return candidateSize;
        },
        label,
      );
      const availableBytes = checkedMemoryBytes(
        memory.currentBytes,
        reservation.remainingBytes,
        label,
      );
      if (nextBytes > availableBytes) {
        if (end === start) memory.set("other", nextBytes);
        break;
      }
      memory.set("other", nextBytes);
      selected.add(oid);
      payloadBytes = nextPayload;
      end++;
    }
    if (end === start) throw new CorruptError(`${label} made no progress`);
    const oids = [...selected];
    const read = repo.readBlobs(oids, { budgetBytes: Math.max(1, payloadBytes) });
    let actualPayloadBytes = 0;
    let returnedOids = 0;
    for (let index = 0; index < oids.length; index++) {
      const oid = oids[index];
      if (oid === undefined) throw new CorruptError(`${label} admitted object list is incomplete`);
      const bytes = read.blobs.get(oid);
      if (bytes === undefined) break;
      const expectedSize = metadata.sizes.get(oid);
      if (expectedSize === undefined || bytes.byteLength !== expectedSize) {
        throw new CorruptError(`${label} object ${oid} differs from its admitted metadata`);
      }
      actualPayloadBytes = checkedMemoryBytes(actualPayloadBytes, bytes.byteLength, label);
      returnedOids++;
    }
    memory.set(
      "other",
      blobBatchRetainedBytes(
        repo,
        entries,
        start,
        end,
        oids.length,
        read.blobs.size,
        read.remaining.length,
        actualPayloadBytes,
        pathOf,
        symlinkOf,
        (entry) => {
          const size = metadata.sizes.get(oidOf(entry));
          if (size === undefined) throw new CorruptError(`${label} lost object ${oidOf(entry)}`);
          return size;
        },
        label,
      ),
    );
    if (
      returnedOids === 0 ||
      read.blobs.size !== returnedOids ||
      read.remaining.length !== oids.length - returnedOids ||
      read.bytes !== actualPayloadBytes
    ) {
      throw new CorruptError(`${label} did not match its admitted payload`);
    }
    for (let index = returnedOids; index < oids.length; index++) {
      if (read.remaining[index - returnedOids] !== oids[index]) {
        throw new CorruptError(`${label} deferred a non-prefix object`);
      }
    }
    let actualEnd = start;
    while (actualEnd < end) {
      const entry = entries[actualEnd];
      if (entry === undefined || !read.blobs.has(oidOf(entry))) break;
      actualEnd++;
    }
    if (actualEnd === start) throw new CorruptError(`${label} made no progress`);
    return { end: actualEnd, blobs: read.blobs, dispose: () => memory.dispose() };
  } catch (error) {
    memory.dispose();
    throw error;
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
  reservation: MemoryReservation,
): ContentObjects {
  const memory = reservation.scope();
  let retainedBytes = COLLECTION_BASE_BYTES;
  memory.set("other", retainedBytes);
  const oids = new Map<string, string>();
  writeObjectsOwned(repo.store, reservation, (batch) => {
    for (const entry of entries) {
      if (entry.content === null) continue;
      const oid = batch.write("blob", entry.content);
      if (entry.stageZero !== null && oid !== entry.stageZero.oid) {
        throw new CorruptError(`merged content identity does not match ${entry.path}`);
      }
      retainedBytes = checkedMemoryBytes(
        retainedBytes,
        COLLECTION_ENTRY_BYTES + retainedStringBytes(oid),
        "merge content objects",
      );
      memory.set("other", retainedBytes);
      oids.set(entry.path, oid);
    }
  });
  return { entries: oids, dispose: () => memory.dispose() };
}

function materialiseWrites(
  repo: Repository,
  worktree: Worktree,
  entries: readonly ProjectedMergeEntry[],
  contentOids: ReadonlyMap<string, string>,
  metadata: BlobMetadata,
  reservation: MemoryReservation,
): void {
  const pendingMemory = reservation.scope();
  let pendingBytes = retainedArrayBytes(entries.length) * 2;
  pendingMemory.set("other", pendingBytes);
  const inline: WriteEntry[] = [];
  const pending: ProjectedMergeEntry[] = [];
  for (const entry of entries) {
    if (entry.worktree === null) continue;
    if (entry.content !== null) {
      const oid = contentOids.get(entry.path);
      if (oid === undefined) throw new CorruptError(`merge output lacks content ${entry.path}`);
      pendingBytes = checkedMemoryBytes(
        pendingBytes,
        OBJECT_BYTES + retainedJoinedPathBytes(repo.root, entry.path) + 20,
        "merge inline writes",
      );
      pendingMemory.set("other", pendingBytes);
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
  if (inline.length > 0) {
    worktree.writeFiles(inline);
  }

  let offset = 0;
  while (offset < pending.length) {
    const batch = readAdmittedBlobBatch(
      repo,
      pending,
      offset,
      metadata,
      reservation,
      (entry) => entry.path,
      (entry) => entry.worktree?.oid ?? "",
      (entry) => entry.worktree?.mode === MODE_SYMLINK,
      "merge output batch",
    );
    const writes: WriteEntry[] = [];
    for (let index = offset; index < batch.end; index++) {
      const entry = pending[index];
      if (entry === undefined) throw new CorruptError("merge output batch selection is incomplete");
      const identity = entry.worktree;
      if (identity === null) continue;
      const bytes = batch.blobs.get(identity.oid);
      if (bytes === undefined) throw new CorruptError(`merge output lost object ${identity.oid}`);
      const path = joinPath(repo.root, entry.path);
      const contentId = fromHex(identity.oid);
      writes.push(
        identity.mode === MODE_SYMLINK
          ? { path, target: utf8Decoder.decode(bytes), contentId }
          : { path, bytes, mode: fileModeFor(identity.mode), contentId },
      );
    }
    try {
      if (writes.length > 0) worktree.writeFiles(writes);
      offset = batch.end;
    } finally {
      batch.dispose();
    }
  }
  pendingMemory.dispose();
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
  reservation: MemoryReservation,
): void {
  const memory = reservation.scope();
  memory.set(
    "other",
    checkedMemoryBytes(
      COLLECTION_BASE_BYTES,
      entries.length * COLLECTION_ENTRY_BYTES,
      "merge projected index paths",
    ),
  );
  const projected = new Set<string>();
  for (const entry of entries) projected.add(entry.path);
  try {
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
  } finally {
    memory.dispose();
  }
}

/** Write a validated clean projection to one caller-selected index. */
export function applyProjectedIndex(
  repo: Repository,
  index: IndexStore,
  entries: readonly ProjectedMergeEntry[],
  owner?: MemoryReservation,
): void {
  withApplyMemory(
    repo,
    owner,
    owner === undefined ? projectedEntriesRetainedBytes(entries) : 0,
    (reservation) => {
      validateProjectedIndexEntries(entries);
      if (entries.some((entry) => entry.stages !== null)) {
        throw new GitError("EUNMERGED", "cannot apply a conflicted projection to an index");
      }
      const specs = touchedSpecs(entries, reservation);
      try {
        repo.store.runScratchAwareOperation(() =>
          repo.store.db.transactionSync(() => {
            const content = contentObjects(repo, entries, reservation);
            try {
              applyIndex(index, entries, specs.entries, reservation);
            } finally {
              content.dispose();
            }
          }),
        );
      } finally {
        specs.dispose();
      }
    },
    () => false,
  );
}

function applyDestructiveRoots(
  entries: readonly ProjectedMergeEntry[],
  reservation: MemoryReservation,
): OwnedPaths {
  const memory = reservation.scope();
  memory.set("other", retainedArrayBytes(entries.length));
  const roots: string[] = [];
  for (const entry of entries) {
    if (entry.worktree === null || entry.worktree.mode !== MODE_COMMIT) roots.push(entry.path);
  }
  roots.sort(comparePaths);
  return { entries: roots, dispose: () => memory.dispose() };
}

function structuralRemovals(
  entries: readonly ProjectedMergeEntry[],
  snapshots: ReadonlyMap<string, WorktreeStat>,
  reservation: MemoryReservation,
): OwnedPaths {
  const memory = reservation.scope();
  let retainedBytes = COLLECTION_BASE_BYTES;
  memory.set("other", retainedBytes);
  const removals = new Set<string>();
  const add = (path: string, ownedStringBytes: number): void => {
    if (removals.has(path)) return;
    retainedBytes = checkedMemoryBytes(
      retainedBytes,
      COLLECTION_ENTRY_BYTES + ownedStringBytes,
      "merge structural removals",
    );
    memory.set("other", retainedBytes);
    removals.add(path);
  };
  for (const entry of entries) {
    if (entry.worktree === null || snapshots.get(entry.path)?.type === "dir") {
      add(entry.path, 0);
    }
    if (entry.worktree === null) continue;
    let slash = entry.path.lastIndexOf("/");
    while (slash > 0) {
      const sliceMemory = reservation.scope();
      sliceMemory.set("other", 48 + slash * 2);
      try {
        const ancestor = entry.path.slice(0, slash);
        const stat = snapshots.get(ancestor);
        if (stat !== undefined && stat.type !== "dir") {
          add(ancestor, retainedStringBytes(ancestor));
        }
        slash = ancestor.lastIndexOf("/");
      } finally {
        sliceMemory.dispose();
      }
    }
  }
  retainedBytes = checkedMemoryBytes(
    retainedBytes,
    retainedArrayBytes(removals.size),
    "merge structural removals",
  );
  memory.set("other", retainedBytes);
  const paths = [...removals].sort(comparePaths);
  return { entries: paths, dispose: () => memory.dispose() };
}

/** Apply inside the caller's transaction so journal and mutations commit together. */
function applyProjectedOperationInternal(
  repo: Repository,
  worktree: Worktree,
  entries: readonly ProjectedMergeEntry[],
  options: OperationApplyOptions,
  activeRebase: ActiveRebaseApply | null,
  reservation: MemoryReservation,
): OperationApplyResult {
  validateProjectedIndexEntries(entries);
  if (activeRebase === null) {
    repo.checkout.requireNoOperationState();
  } else {
    if (options.suspendedState !== null) {
      throw new CorruptError("rebase apply supplied two journal transitions");
    }
    const activeMemory = reservation.scope();
    try {
      const current = readOperationStateOwned(repo.checkout, activeMemory);
      if (current === null) throw operationNotActive("rebase");
      if (current.kind !== "rebase") throw operationKindMismatch("rebase", current.kind);
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
    } finally {
      activeMemory.dispose();
    }
  }
  const suspendedState = activeRebase?.conflictState ?? options.suspendedState;
  const suspendedSteps = activeRebase?.steps;

  const retainedSpecs = touchedSpecs(entries, reservation);
  const specs = retainedSpecs.entries;
  const setupMemory = reservation.scope();
  setupMemory.set("other", retainedArrayBytes(specs.length));
  const owned = specs.map((spec) => spec.path);
  const destructive = applyDestructiveRoots(entries, reservation);
  const worktreeRows = worktreeSnapshotScan(
    repo,
    worktree,
    specs,
    destructive.entries,
    owned,
    reservation,
  );
  destructive.dispose();
  setupMemory.dispose();
  const draftsMemory = reservation.scope();
  let drafts: SnapshotDraft[] = [];
  let index: IndexSnapshots | null = null;
  if (suspendedState !== null) {
    const snapshots = indexSnapshots(repo, specs, reservation);
    index = snapshots;
    draftsMemory.set(
      "other",
      checkedMemoryBytes(
        retainedArrayBytes(specs.length),
        specs.length * OBJECT_BYTES,
        "merge snapshot drafts",
      ),
    );
    drafts = specs.map((spec) => ({
      spec,
      index: snapshots.entries.get(spec.path) ?? null,
      stat: worktreeRows.entries.get(spec.path) ?? null,
    }));
  }

  const sourceBlobs = validateSourceBlobs(repo, entries, reservation);
  const removals = structuralRemovals(entries, worktreeRows.entries, reservation);

  let touched: readonly MergeTouchedPath[] | null = null;
  let journalMemory: MemoryReservation | null = null;
  if (suspendedState !== null) {
    journalMemory = reservation.scope();
    journalMemory.set(
      "other",
      operationJournalDraftRetainedBytes(suspendedState, drafts, suspendedSteps),
    );
    const snapshots = snapshotWorktreeObjects(repo, worktree, drafts, reservation);
    touched = touchedFromDrafts(drafts, snapshots.entries);
    journalMemory.set(
      "other",
      operationJournalRetainedBytes(suspendedState, touched, suspendedSteps),
    );
    snapshots.dispose();
    index?.dispose();
    index = null;
    worktreeRows.dispose();
    draftsMemory.dispose();
  }

  if (suspendedState === null) {
    worktreeRows.dispose();
    draftsMemory.dispose();
  }

  const content = contentObjects(repo, entries, reservation);
  try {
    if (removals.entries.length > 0) {
      const removalMemory = reservation.scope();
      let removalBytes = retainedArrayBytes(removals.entries.length);
      for (const path of removals.entries) {
        removalBytes = checkedMemoryBytes(
          removalBytes,
          retainedJoinedPathBytes(repo.root, path),
          "merge removal paths",
        );
      }
      removalMemory.set("other", removalBytes);
      try {
        const absolute = removals.entries.map((path) => joinPath(repo.root, path));
        worktree.removeFiles(absolute, { recursive: true });
      } finally {
        removalMemory.dispose();
      }
    }
    materialiseWrites(repo, worktree, entries, content.entries, sourceBlobs, reservation);
    applyIndex(repo.checkout, entries, specs, reservation);
    if (touched !== null) {
      if (suspendedState === null) throw new CorruptError("operation snapshot lost its state");
      if (journalMemory === null) throw new CorruptError("operation snapshot lost its owner");
      if (activeRebase === null) {
        if (suspendedState.kind === "rebase") {
          throw new CorruptError("rebase apply omitted its active journal");
        }
        writeOperationJournalOwned(
          repo.checkout,
          suspendedState,
          operationStepsForState(suspendedState),
          touched,
          journalMemory,
        );
      } else {
        replaceOperationJournalOwned(
          repo.checkout,
          activeRebase.expectedIntegrityOid,
          suspendedState,
          activeRebase.steps,
          touched,
          journalMemory,
        );
      }
    }
  } finally {
    content.dispose();
    sourceBlobs.dispose();
    removals.dispose();
    retainedSpecs.dispose();
  }
  return { touched };
}

/** Apply a normal operation inside its caller-owned transaction. */
export function applyProjectedOperation(
  repo: Repository,
  worktree: Worktree,
  entries: readonly ProjectedMergeEntry[],
  options: OperationApplyOptions,
  owner?: MemoryReservation,
): OperationApplyResult {
  return withApplyMemory(
    repo,
    owner,
    owner === undefined ? projectedEntriesRetainedBytes(entries) : 0,
    (reservation) =>
      applyProjectedOperationInternal(repo, worktree, entries, options, null, reservation),
    (result) => result.touched !== null,
  );
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
  owner?: MemoryReservation,
): ProjectedRebaseTransitionResult<T> {
  return withApplyMemory(
    repo,
    owner,
    owner === undefined ? projectedEntriesRetainedBytes(entries) : 0,
    (reservation) =>
      repo.store.db.transactionSync(() => {
        const applied = applyProjectedOperationInternal(
          repo,
          worktree,
          entries,
          { suspendedState: null },
          options,
          reservation,
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
      }),
    () => false,
  );
}

export function applyProjectedMerge(
  repo: Repository,
  worktree: Worktree,
  entries: readonly ProjectedMergeEntry[],
  metadata: MergeApplyMetadata,
  owner?: MemoryReservation,
): MergeApplyResult {
  return withApplyMemory(
    repo,
    owner,
    owner === undefined ? projectedEntriesRetainedBytes(entries) : 0,
    (reservation) => {
      const outcome = outcomeOf(entries, metadata.mode);
      if (outcome === "clean") {
        validateMergeStateMetadata({ ...metadata, phase: "conflicted" });
      }
      const state = outcome === "clean" ? null : metadataForOutcome(metadata, outcome);
      const applied = applyProjectedOperationInternal(
        repo,
        worktree,
        entries,
        { suspendedState: state === null ? null : mergeOperationState(state) },
        null,
        reservation,
      );
      const journal =
        state === null || applied.touched === null
          ? null
          : {
              state,
              touched: applied.touched,
              retainedBytes: mergeJournalRetainedBytes(state, applied.touched),
            };
      return { outcome, journal };
    },
    (result) => result.journal !== null,
  );
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

function abortDestructiveRoots(
  touched: readonly MergeTouchedPath[],
  reservation: MemoryReservation,
): OwnedPaths {
  const memory = reservation.scope();
  memory.set("other", retainedArrayBytes(touched.length));
  const roots: string[] = [];
  for (const entry of touched) {
    if (entry.worktree.kind !== "directory") roots.push(entry.path);
  }
  roots.sort(comparePaths);
  return { entries: roots, dispose: () => memory.dispose() };
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
  metadata: BlobMetadata,
  reservation: MemoryReservation,
): void {
  const retainedMemory = reservation.scope();
  let retainedBytes = checkedMemoryBytes(
    retainedArrayBytes(touched.length) * 3,
    COLLECTION_BASE_BYTES,
    "merge restore collections",
  );
  retainedMemory.set("other", retainedBytes);
  const removals = new Set<string>();
  const directories: WriteEntry[] = [];
  const pending: MergeTouchedPath[] = [];
  const addRemoval = (path: string): void => {
    if (removals.has(path)) return;
    retainedBytes = checkedMemoryBytes(
      retainedBytes,
      COLLECTION_ENTRY_BYTES,
      "merge restore removals",
    );
    retainedMemory.set("other", retainedBytes);
    removals.add(path);
  };
  for (const entry of touched) {
    if (entry.worktree.kind === "absent") {
      addRemoval(entry.path);
    } else if (entry.worktree.kind === "directory") {
      const found = current.get(entry.path);
      if (found !== undefined && found.type !== "dir") addRemoval(entry.path);
      retainedBytes = checkedMemoryBytes(
        retainedBytes,
        OBJECT_BYTES + retainedJoinedPathBytes(repo.root, entry.path),
        "merge restore directories",
      );
      retainedMemory.set("other", retainedBytes);
      directories.push({
        path: joinPath(repo.root, entry.path),
        mode: entry.worktree.mode & 0o7777,
      });
    } else {
      if (current.get(entry.path)?.type === "dir") addRemoval(entry.path);
      pending.push(entry);
    }
  }
  if (removals.size > 0) {
    let removeBytes = retainedArrayBytes(removals.size) * 2;
    for (const path of removals) {
      removeBytes = checkedMemoryBytes(
        removeBytes,
        retainedJoinedPathBytes(repo.root, path),
        "merge restore removal paths",
      );
    }
    retainedBytes = checkedMemoryBytes(retainedBytes, removeBytes, "merge restore removal paths");
    retainedMemory.set("other", retainedBytes);
    const ordered = [...removals].sort(comparePaths);
    const absolute = ordered.map((path) => joinPath(repo.root, path));
    worktree.removeFiles(absolute, { recursive: true });
  }
  if (directories.length > 0) worktree.writeFiles(directories);

  let offset = 0;
  while (offset < pending.length) {
    const batch = readAdmittedBlobBatch(
      repo,
      pending,
      offset,
      metadata,
      reservation,
      (entry) => entry.path,
      (entry) =>
        entry.worktree.kind === "file" || entry.worktree.kind === "symlink"
          ? entry.worktree.oid
          : "",
      (entry) => entry.worktree.kind === "symlink",
      "merge restore batch",
    );
    const writes: WriteEntry[] = [];
    for (let index = offset; index < batch.end; index++) {
      const entry = pending[index];
      if (entry === undefined) throw new CorruptError("merge restore selection is incomplete");
      const snapshot = entry.worktree;
      if (snapshot.kind !== "file" && snapshot.kind !== "symlink") continue;
      const bytes = batch.blobs.get(snapshot.oid);
      if (bytes === undefined) throw new CorruptError(`merge abort lost object ${snapshot.oid}`);
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
    try {
      if (writes.length > 0) worktree.writeFiles(writes);
      offset = batch.end;
    } finally {
      batch.dispose();
    }
  }
  retainedMemory.dispose();
}

function validateRestoreBlobs(
  repo: Repository,
  touched: readonly MergeTouchedPath[],
  reservation: MemoryReservation,
): BlobMetadata {
  return collectBlobMetadata(
    repo,
    touched,
    (entry) =>
      entry.worktree.kind === "file" || entry.worktree.kind === "symlink"
        ? entry.worktree.oid
        : null,
    "merge abort",
    reservation,
  );
}

/** Restore only journal-owned paths; the caller supplies the atomic transaction. */
export function abortProjectedMerge(
  repo: Repository,
  worktree: Worktree,
  journal: MergeJournal,
  owner?: MemoryReservation,
): void {
  withApplyMemory(
    repo,
    owner,
    0,
    (reservation) => {
      validateJournal(journal);
      validateJournalObjects(repo, journal);
      const setupMemory = reservation.scope();
      setupMemory.set(
        "other",
        checkedMemoryBytes(
          retainedArrayBytes(journal.touched.length) * 2,
          journal.touched.length * OBJECT_BYTES,
          "merge abort setup",
        ),
      );
      const specs: TouchedSpec[] = [];
      const owned: string[] = [];
      for (const entry of journal.touched) {
        specs.push({
          path: entry.path,
          logicalPath: entry.logicalPath,
          purpose: entry.purpose,
        });
        if (entry.worktree.kind === "absent") owned.push(entry.path);
      }
      const destructive = abortDestructiveRoots(journal.touched, reservation);
      const current = worktreeSnapshotScan(
        repo,
        worktree,
        specs,
        destructive.entries,
        owned,
        reservation,
      );
      destructive.dispose();
      setupMemory.dispose();
      try {
        const restoreBlobs = validateRestoreBlobs(repo, journal.touched, reservation);
        try {
          restoreWorktree(
            repo,
            worktree,
            journal.touched,
            current.entries,
            restoreBlobs,
            reservation,
          );
        } finally {
          restoreBlobs.dispose();
        }
        restoreIndex(repo, journal.touched);
        repo.checkout.clearMergeState();
      } finally {
        current.dispose();
      }
    },
    () => false,
  );
}

/** Restore one authenticated operation snapshot; the caller owns state clearing. */
export function restoreProjectedOperation(
  repo: Repository,
  worktree: Worktree,
  journal: OperationJournal,
  owner?: MemoryReservation,
): void {
  withApplyMemory(
    repo,
    owner,
    0,
    (reservation) => {
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
      const setupMemory = reservation.scope();
      setupMemory.set(
        "other",
        checkedMemoryBytes(
          retainedArrayBytes(journal.touched.length) * 2,
          journal.touched.length * OBJECT_BYTES,
          "operation restore setup",
        ),
      );
      const specs: TouchedSpec[] = [];
      const owned: string[] = [];
      for (const entry of journal.touched) {
        specs.push({
          path: entry.path,
          logicalPath: entry.logicalPath,
          purpose: entry.purpose,
        });
        if (entry.worktree.kind === "absent") owned.push(entry.path);
      }
      const destructive = abortDestructiveRoots(journal.touched, reservation);
      const current = worktreeSnapshotScan(
        repo,
        worktree,
        specs,
        destructive.entries,
        owned,
        reservation,
      );
      destructive.dispose();
      setupMemory.dispose();
      try {
        const restoreBlobs = validateRestoreBlobs(repo, journal.touched, reservation);
        try {
          restoreWorktree(
            repo,
            worktree,
            journal.touched,
            current.entries,
            restoreBlobs,
            reservation,
          );
        } finally {
          restoreBlobs.dispose();
        }
        restoreIndex(repo, journal.touched);
      } finally {
        current.dispose();
      }
    },
    () => false,
  );
}
