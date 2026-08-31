// Atomic low-level application and restoration of one projected merge plan.

import { nativeRealpathOwned, nativeScanOwned } from "../../fs/store/owned-read.js";
import type { RealPath, ScanEntry, WriteEntry } from "../../fs/types.js";
import {
  type IndexEntry,
  type IndexSink,
  type IndexStore,
  indexScanOwned,
  PACK_BLOB_BATCH_TARGET_BYTES,
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
  validateMergePath,
  validateMergeStateMetadata,
} from "./merge-state.js";
import {
  mergeOperationState,
  type OperationJournal,
  type OperationStateMetadata,
  type OperationStepMetadata,
  operationJournalIntegrityOid,
  operationKindMismatch,
  operationNotActive,
  operationStepsForState,
  type RebaseStateMetadata,
} from "./operation-state.js";
import { type HashedPath, hashExactWorktreePathsOwned } from "./worktree-io.js";

const APPLY_SCAN_PAGE = 1_000;
const OBJECT_INFO_PAGE = 4_096;

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

interface TouchedSpecs {
  entries: TouchedSpec[];
}

interface WorktreeSnapshotScan {
  entries: Map<string, WorktreeStat>;
}

interface IndexSnapshots {
  entries: Map<string, MergeIndexSnapshot>;
}

interface SnapshotObjects {
  entries: Map<string, HashedPath>;
}

interface ContentObjects {
  entries: Map<string, string>;
}

interface BlobMetadata {
  sizes: ReadonlyMap<string, number>;
}

interface AdmittedBlobBatch {
  end: number;
  blobs: ReadonlyMap<string, Uint8Array>;
}

interface OwnedPaths {
  entries: string[];
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

function validateCanonicalUtf16(value: string, label: string): void {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) throw new CorruptError(`${label} is not canonical UTF-16`);
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new CorruptError(`${label} is not canonical UTF-16`);
    }
  }
}

function touchedSpecs(entries: readonly ProjectedMergeEntry[]): TouchedSpecs {
  const byPath = new Map<string, TouchedSpec>();
  const retain = (
    path: string,
    logicalPath: string,
    purpose: MergeTouchedPath["purpose"],
  ): void => {
    if (byPath.has(path)) return;
    if (byPath.size >= MAX_MERGE_TOUCHED_PATHS) {
      throw new GitError("E2BIG", `merge journal exceeds ${MAX_MERGE_TOUCHED_PATHS} touched paths`);
    }
    const spec: TouchedSpec = { path, logicalPath, purpose };
    byPath.set(spec.path, spec);
  };
  const retainAncestor = (path: string): void => {
    let slash = path.lastIndexOf("/");
    while (slash > 0) {
      const ancestor = path.slice(0, slash);
      retain(ancestor, ancestor, "primary");
      slash = ancestor.lastIndexOf("/");
    }
  };
  for (const entry of entries) {
    retain(entry.path, entry.logicalPath, entry.purpose);
    if (entry.purpose !== "primary" && !byPath.has(entry.logicalPath)) {
      retain(entry.logicalPath, entry.logicalPath, "primary");
    }
    retainAncestor(entry.path);
    retainAncestor(entry.logicalPath);
  }
  const specs = [...byPath.values()].sort((left, right) => comparePaths(left.path, right.path));
  return { entries: specs };
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

function worktreeRealpathOwned(worktree: Worktree, path: string): RealPath {
  const native = nativeRealpathOwned(worktree, path);
  if (native !== null) return native;
  return worktree.realpath(path);
}

function worktreeScanPageOwned(
  worktree: Worktree,
  root: RealPath,
  after: string | undefined,
): ScanEntry[] {
  const native = nativeScanOwned(worktree, root, { after, limit: APPLY_SCAN_PAGE });
  if (native !== null) return native;
  return worktree.scan(root, { after, limit: APPLY_SCAN_PAGE });
}

function worktreeSnapshotScan(
  repo: Repository,
  worktree: Worktree,
  specs: readonly TouchedSpec[],
  destructiveRoots: readonly string[],
  ownedPaths: readonly string[],
): WorktreeSnapshotScan {
  const root = worktreeRealpathOwned(worktree, repo.root);
  let previousDestructive: string | null = null;
  for (const path of destructiveRoots) {
    if (previousDestructive !== null && pathDescendsFrom(path, previousDestructive)) continue;
    previousDestructive = path;
  }
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
  for (const path of ownedPaths) exactOwned.add(path);
  const found = new Map<string, WorktreeStat>();
  if (lastAbsolute === null) {
    return { entries: found };
  }
  let after: string | undefined;
  while (true) {
    const page = worktreeScanPageOwned(worktree, root, after);
    if (page.length === 0) {
      break;
    }
    for (const entry of page) {
      const relative = relativeTo(root, entry.path);
      if (relative === null) throw new CorruptError("worktree scan escaped the repository root");
      const exact = absoluteToRelative.get(entry.path);
      if (exact !== undefined && !found.has(exact)) {
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
      after = tail.path;
    }
    if (finished || beyondOwned) break;
  }
  return { entries: found };
}

function indexSnapshots(repo: Repository, specs: readonly TouchedSpec[]): IndexSnapshots {
  const wanted = new Set<string>();
  const found = new Map<string, MergeIndexSnapshot>();
  for (const spec of specs) wanted.add(spec.path);
  const last = specs[specs.length - 1];
  if (last === undefined) return { entries: found };
  for (const entry of indexScanOwned(repo.checkout)) {
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
  drafts: readonly SnapshotDraft[],
): SnapshotObjects {
  const paths: { path: string; stat: WorktreeStat }[] = [];
  for (const draft of drafts) {
    const stat = draft.stat;
    if (stat?.type === "symlink") {
      if (stat.target === null) {
        throw new CorruptError(`worktree symlink ${draft.spec.path} has no target`);
      }
      validateCanonicalUtf16(stat.target, `merge snapshot symlink ${draft.spec.path}`);
    }
    if (stat?.type === "file" || stat?.type === "symlink") {
      paths.push({ path: draft.spec.path, stat });
    }
  }
  const hashed = hashExactWorktreePathsOwned(repo, worktree, paths, {
    write: true,
  });
  for (const draft of drafts) {
    if (
      (draft.stat?.type === "file" || draft.stat?.type === "symlink") &&
      !hashed.has(draft.spec.path)
    ) {
      throw new CorruptError(`merge snapshot lost worktree path ${draft.spec.path}`);
    }
  }
  return { entries: hashed };
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
): BlobMetadata {
  const seen = new Set<string>();
  const oids: string[] = [];
  for (const entry of entries) {
    const oid = oidOf(entry);
    if (oid === null || seen.has(oid)) continue;
    seen.add(oid);
    oids.push(oid);
  }

  const sizes = new Map<string, number>();
  for (let offset = 0; offset < oids.length; offset += OBJECT_INFO_PAGE) {
    const page = oids.slice(offset, offset + OBJECT_INFO_PAGE);
    for (const object of repo.store.objectInfo(page)) {
      if (object.type !== "blob") {
        throw new CorruptError(`${label} object ${object.oid} is not a blob`);
      }
      sizes.set(object.oid, object.size);
    }
  }
  for (const oid of oids) {
    if (!sizes.has(oid)) throw new CorruptError(`${label} lost object ${oid}`);
  }
  return { sizes };
}

function validateSourceBlobs(
  repo: Repository,
  entries: readonly ProjectedMergeEntry[],
): BlobMetadata {
  return collectBlobMetadata(
    repo,
    entries,
    (entry) => (entry.content === null ? (entry.worktree?.oid ?? null) : null),
    "merge output",
  );
}

function readAdmittedBlobBatch<T>(
  repo: Repository,
  entries: readonly T[],
  start: number,
  metadata: BlobMetadata,
  oidOf: (entry: T) => string,
  label: string,
): AdmittedBlobBatch {
  let end = start;
  let payloadBytes = 0;
  const selected = new Set<string>();
  while (end < entries.length) {
    const entry = entries[end];
    if (entry === undefined) throw new CorruptError(`${label} selection is incomplete`);
    const oid = oidOf(entry);
    const size = metadata.sizes.get(oid);
    if (size === undefined) throw new CorruptError(`${label} lost object ${oid}`);
    const nextPayload = selected.has(oid) ? payloadBytes : payloadBytes + size;
    if (!Number.isSafeInteger(nextPayload)) throw new CorruptError(`${label} payload is invalid`);
    if (nextPayload > PACK_BLOB_BATCH_TARGET_BYTES && end > start) break;
    const nextOids = selected.has(oid) ? selected.size : selected.size + 1;
    if (nextOids > OBJECT_INFO_PAGE && end > start) break;
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
    actualPayloadBytes += bytes.byteLength;
    returnedOids++;
  }
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
  return { end: actualEnd, blobs: read.blobs };
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

function contentObjects(repo: Repository, entries: readonly ProjectedMergeEntry[]): ContentObjects {
  const oids = new Map<string, string>();
  writeObjectsOwned(repo.store, (batch) => {
    for (const entry of entries) {
      if (entry.content === null) continue;
      const oid = batch.write("blob", entry.content);
      if (entry.stageZero !== null && oid !== entry.stageZero.oid) {
        throw new CorruptError(`merged content identity does not match ${entry.path}`);
      }
      oids.set(entry.path, oid);
    }
  });
  return { entries: oids };
}

function materialiseWrites(
  repo: Repository,
  worktree: Worktree,
  entries: readonly ProjectedMergeEntry[],
  contentOids: ReadonlyMap<string, string>,
  metadata: BlobMetadata,
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
      (entry) => entry.worktree?.oid ?? "",
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
    if (writes.length > 0) worktree.writeFiles(writes);
    offset = batch.end;
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
  const projected = new Set<string>();
  for (const entry of entries) projected.add(entry.path);
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
      applyIndex(index, entries, specs.entries);
    }),
  );
}

function applyDestructiveRoots(entries: readonly ProjectedMergeEntry[]): OwnedPaths {
  const roots: string[] = [];
  for (const entry of entries) {
    if (entry.worktree === null || entry.worktree.mode !== MODE_COMMIT) roots.push(entry.path);
  }
  roots.sort(comparePaths);
  return { entries: roots };
}

function structuralRemovals(
  entries: readonly ProjectedMergeEntry[],
  snapshots: ReadonlyMap<string, WorktreeStat>,
): OwnedPaths {
  const removals = new Set<string>();
  const add = (path: string): void => {
    if (removals.has(path)) return;
    removals.add(path);
  };
  for (const entry of entries) {
    if (entry.worktree === null || snapshots.get(entry.path)?.type === "dir") {
      add(entry.path);
    }
    if (entry.worktree === null) continue;
    let slash = entry.path.lastIndexOf("/");
    while (slash > 0) {
      const ancestor = entry.path.slice(0, slash);
      const stat = snapshots.get(ancestor);
      if (stat !== undefined && stat.type !== "dir") {
        add(ancestor);
      }
      slash = ancestor.lastIndexOf("/");
    }
  }
  const paths = [...removals].sort(comparePaths);
  return { entries: paths };
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
    const current = readOperationStateOwned(repo.checkout);
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
  }
  const suspendedState = activeRebase?.conflictState ?? options.suspendedState;

  const retainedSpecs = touchedSpecs(entries);
  const specs = retainedSpecs.entries;
  const owned = specs.map((spec) => spec.path);
  const destructive = applyDestructiveRoots(entries);
  const worktreeRows = worktreeSnapshotScan(repo, worktree, specs, destructive.entries, owned);
  let drafts: SnapshotDraft[] = [];
  if (suspendedState !== null) {
    const snapshots = indexSnapshots(repo, specs);
    drafts = specs.map((spec) => ({
      spec,
      index: snapshots.entries.get(spec.path) ?? null,
      stat: worktreeRows.entries.get(spec.path) ?? null,
    }));
  }

  const sourceBlobs = validateSourceBlobs(repo, entries);
  const removals = structuralRemovals(entries, worktreeRows.entries);

  let touched: readonly MergeTouchedPath[] | null = null;
  if (suspendedState !== null) {
    const snapshots = snapshotWorktreeObjects(repo, worktree, drafts);
    touched = touchedFromDrafts(drafts, snapshots.entries);
  }

  const content = contentObjects(repo, entries);
  if (removals.entries.length > 0) {
    const absolute = removals.entries.map((path) => joinPath(repo.root, path));
    worktree.removeFiles(absolute, { recursive: true });
  }
  materialiseWrites(repo, worktree, entries, content.entries, sourceBlobs);
  applyIndex(repo.checkout, entries, specs);
  if (touched !== null) {
    if (suspendedState === null) throw new CorruptError("operation snapshot lost its state");
    if (activeRebase === null) {
      if (suspendedState.kind === "rebase") {
        throw new CorruptError("rebase apply omitted its active journal");
      }
      writeOperationJournalOwned(
        repo.checkout,
        suspendedState,
        operationStepsForState(suspendedState),
        touched,
      );
    } else {
      replaceOperationJournalOwned(
        repo.checkout,
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
  {
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
    );
    const journal =
      state === null || applied.touched === null
        ? null
        : {
            state,
            touched: applied.touched,
          };
    return { outcome, journal };
  }
}

function validateJournal(journal: MergeJournal): void {
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

function abortDestructiveRoots(touched: readonly MergeTouchedPath[]): OwnedPaths {
  const roots: string[] = [];
  for (const entry of touched) {
    if (entry.worktree.kind !== "directory") roots.push(entry.path);
  }
  roots.sort(comparePaths);
  return { entries: roots };
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
): void {
  const removals = new Set<string>();
  const directories: WriteEntry[] = [];
  const pending: MergeTouchedPath[] = [];
  const addRemoval = (path: string): void => {
    if (removals.has(path)) return;
    removals.add(path);
  };
  for (const entry of touched) {
    if (entry.worktree.kind === "absent") {
      addRemoval(entry.path);
    } else if (entry.worktree.kind === "directory") {
      const found = current.get(entry.path);
      if (found !== undefined && found.type !== "dir") addRemoval(entry.path);
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
      (entry) =>
        entry.worktree.kind === "file" || entry.worktree.kind === "symlink"
          ? entry.worktree.oid
          : "",
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
    if (writes.length > 0) worktree.writeFiles(writes);
    offset = batch.end;
  }
}

function validateRestoreBlobs(
  repo: Repository,
  touched: readonly MergeTouchedPath[],
): BlobMetadata {
  return collectBlobMetadata(
    repo,
    touched,
    (entry) =>
      entry.worktree.kind === "file" || entry.worktree.kind === "symlink"
        ? entry.worktree.oid
        : null,
    "merge abort",
  );
}

/** Restore only journal-owned paths; the caller supplies the atomic transaction. */
export function abortProjectedMerge(
  repo: Repository,
  worktree: Worktree,
  journal: MergeJournal,
): void {
  validateJournal(journal);
  validateJournalObjects(repo, journal);
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
  const destructive = abortDestructiveRoots(journal.touched);
  const current = worktreeSnapshotScan(repo, worktree, specs, destructive.entries, owned);
  const restoreBlobs = validateRestoreBlobs(repo, journal.touched);
  restoreWorktree(repo, worktree, journal.touched, current.entries, restoreBlobs);
  restoreIndex(repo, journal.touched);
  repo.checkout.clearMergeState();
}

/** Restore one authenticated operation snapshot; the caller owns state clearing. */
export function restoreProjectedOperation(
  repo: Repository,
  worktree: Worktree,
  journal: OperationJournal,
): void {
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
  const destructive = abortDestructiveRoots(journal.touched);
  const current = worktreeSnapshotScan(repo, worktree, specs, destructive.entries, owned);
  const restoreBlobs = validateRestoreBlobs(repo, journal.touched);
  restoreWorktree(repo, worktree, journal.touched, current.entries, restoreBlobs);
  restoreIndex(repo, journal.touched);
}
