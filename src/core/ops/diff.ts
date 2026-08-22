// `diff` and `diffSummary`.
//
// Three modes, matching Computer: working tree vs HEAD, working tree vs a
// ref, and a commit pair. The patch text itself comes from
// `src/core/diff/`; this file decides *what* is compared and writes the
// `diff --git` headers around it.

import type { BlobIdMapping, BlobReadBatch, IndexEntry } from "../../sqlite/store.js";
import { utf8, utf8Decoder, ZERO_OID } from "../bytes.js";
import { diffText } from "../diff/index.js";
import { isBinary } from "../diff/lines.js";
import { CorruptError, GitError } from "../errors.js";
import { joinPath } from "../paths.js";
import type { Repository } from "../repository.js";
import type { SparseWorkspaceRow, SparseWorkspaceSource } from "../sparse-workspace.js";
import { comparePaths, joinSorted, joinSorted3 } from "../streams.js";
import { gitModeFor, type Worktree } from "../worktree.js";
import { matchesPaths, stageZero } from "./checkout.js";
import type { DiffSummaryEntry } from "./kinds.js";
import { treeOf } from "./reads.js";
import { type TargetEntry, treeStream } from "./tree-stream.js";
import {
  hashExactWorktreePaths,
  hashWorktreePaths,
  indexMatchesStat,
  type WorktreePath,
  walkWorktreeEntriesStream,
} from "./worktree-io.js";

/** git's default abbreviation for `index` lines in a small repository. */
const DEFAULT_ABBREV = 7;
const DIFF_WINDOW_ROWS = 1000;
const DIFF_REPOSITORY_BYTES = 8 * 1024 * 1024;
const DIFF_WORKTREE_BYTES = 8 * 1024 * 1024;
const SPARSE_DIFF_PATHS = 1000;
const SPARSE_DIFF_RETAINED_BYTES = 16 * 1024 * 1024;
const SPARSE_DIFF_ROW_BYTES = 1024;

export interface DiffOptions {
  /** The "from" side. Defaults to HEAD. */
  ref?: string;
  /** The "to" side. Set it to diff two commits instead of the working tree. */
  to?: string;
  /** Exact-or-directory-prefix path filter. No globs. */
  paths?: string[];
  /** Context lines around each hunk. */
  context?: number;
  /** Length of the abbreviated oids on `index` lines. */
  abbrev?: number;
}

/** One side of a file's change; null means the file is absent there. */
interface Endpoint {
  mode: string;
  oid: string;
  bytes: Uint8Array | null;
}

interface FileChange {
  path: string;
  before: Endpoint | null;
  after: Endpoint | null;
}

interface EndpointIdentity {
  mode: string;
  oid: string;
  worktree: WorktreePath | null;
}

interface PendingChange {
  path: string;
  before: EndpointIdentity | null;
  after: EndpointIdentity | null;
}

interface WorkingCandidate {
  path: string;
  before: TargetEntry | undefined;
  index: IndexEntry | undefined;
  worktree: WorktreePath | undefined;
}

export function diff(
  repo: Repository,
  worktree: Worktree,
  options: DiffOptions = {},
  sparseWorkspace?: SparseWorkspaceSource,
): string {
  const abbrev = options.abbrev ?? DEFAULT_ABBREV;
  // Appended, not collected and joined: the parts array and the joined
  // result are alive at the same instant, so joining doubles the patch.
  let out = "";
  for (const change of collect(repo, worktree, options, sparseWorkspace)) {
    const before = change.before;
    const after = change.after;
    const left = before === null ? "/dev/null" : `a/${change.path}`;
    const right = after === null ? "/dev/null" : `b/${change.path}`;

    let header = `diff --git a/${change.path} b/${change.path}\n`;
    let headerLines = 1;
    if (before === null && after !== null) {
      header += `new file mode ${after.mode}\n`;
      headerLines++;
    } else if (after === null && before !== null) {
      header += `deleted file mode ${before.mode}\n`;
      headerLines++;
    } else if (before !== null && after !== null && before.mode !== after.mode) {
      header += `old mode ${before.mode}\nnew mode ${after.mode}\n`;
      headerLines += 2;
    }

    const oldOid = before?.oid ?? ZERO_OID;
    const newOid = after?.oid ?? ZERO_OID;
    if (oldOid !== newOid) {
      const sameMode = before !== null && after !== null && before.mode === after.mode;
      header +=
        `index ${oldOid.slice(0, abbrev)}..${newOid.slice(0, abbrev)}` +
        `${sameMode && before !== null ? ` ${before.mode}` : ""}\n`;
      headerLines++;
    }

    if (oldOid === newOid) {
      if (headerLines > 1) out += header;
      continue;
    }
    const oldBytes = before === null ? new Uint8Array(0) : endpointBytes(before);
    const newBytes = after === null ? new Uint8Array(0) : endpointBytes(after);
    if (isBinary(oldBytes) || isBinary(newBytes)) {
      out += `${header}Binary files ${left} and ${right} differ\n`;
      continue;
    }
    const text = diffText(utf8Decoder.decode(oldBytes), utf8Decoder.decode(newBytes), {
      context: options.context,
    });
    if (text.hunks === "") {
      continue;
    }
    out += `${header}--- ${left}\n+++ ${right}\n${text.hunks}`;
  }
  return out;
}

export function diffSummary(
  repo: Repository,
  worktree: Worktree,
  options: DiffOptions = {},
  sparseWorkspace?: SparseWorkspaceSource,
): DiffSummaryEntry[] {
  const out: DiffSummaryEntry[] = [];
  for (const change of collect(repo, worktree, options, sparseWorkspace)) {
    const status = change.before === null ? "A" : change.after === null ? "D" : "M";
    if (change.before?.oid === change.after?.oid) {
      out.push({ path: change.path, status, insertions: 0, deletions: 0 });
      continue;
    }
    const oldBytes = change.before === null ? new Uint8Array(0) : endpointBytes(change.before);
    const newBytes = change.after === null ? new Uint8Array(0) : endpointBytes(change.after);
    if (isBinary(oldBytes) || isBinary(newBytes)) {
      // git prints "-" for a binary file; there is no line count to give.
      out.push({ path: change.path, status, insertions: 0, deletions: 0 });
      continue;
    }
    const text = diffText(utf8Decoder.decode(oldBytes), utf8Decoder.decode(newBytes));
    out.push({
      path: change.path,
      status,
      insertions: text.insertions,
      deletions: text.deletions,
    });
  }
  return out;
}

/**
 * The changed paths, lazily. Both sides are path-ordered — a tree walk and
 * either another tree walk or the paged index — so a merge join replaces the
 * three maps and the sorted union this used to build.
 */
function* collect(
  repo: Repository,
  worktree: Worktree,
  options: DiffOptions,
  sparseWorkspace: SparseWorkspaceSource | undefined,
): Generator<FileChange> {
  const fromTreeOid = resolveFrom(repo, options);
  const byPath = { left: (entry: TargetEntry) => entry.path };

  if (options.to !== undefined) {
    const toTreeOid = treeOf(repo, repo.revParse(options.to));
    const sparse = sparseCommitPair(repo, fromTreeOid, toTreeOid, options);
    if (sparse !== null) {
      yield* hydrateChanges(repo, worktree, sparse);
      return;
    }
    const from = treeStream(repo, fromTreeOid);
    const to = treeStream(repo, toTreeOid);
    const pending: PendingChange[] = [];
    for (const row of joinSorted(from, to, { ...byPath, right: (entry) => entry.path })) {
      if (!matchesPaths(row.path, options.paths)) continue;
      const change = compareIdentities(row.path, treeIdentity(row.left), treeIdentity(row.right));
      if (change !== null) pending.push(change);
      if (pending.length >= DIFF_WINDOW_ROWS) yield* hydrateChanges(repo, worktree, pending);
    }
    yield* hydrateChanges(repo, worktree, pending);
    return;
  }

  if (sparseWorkspace !== undefined) {
    const sparse = sparseWorkingCandidates(repo, sparseWorkspace, fromTreeOid, options);
    if (sparse !== null) {
      yield* resolveWorkingCandidates(repo, worktree, sparse, true);
      return;
    }
  }

  // The working-tree side covers only paths git would consider — those in
  // the "from" tree or in the index — so an untracked file stays out of the
  // patch, as it does in real `git diff`.
  const from = treeStream(repo, fromTreeOid);
  const candidates: WorkingCandidate[] = [];
  for (const row of joinSorted3(
    from,
    stageZero(repo.store.indexScan()),
    walkWorktreeEntriesStream(
      worktree,
      repo.root,
      options.paths === undefined || options.paths.length === 0
        ? { filesOnly: true }
        : { paths: options.paths },
    ),
    {
      a: (entry) => entry.path,
      b: (entry) => entry.path,
      c: (entry) => entry.path,
    },
  )) {
    if (!matchesPaths(row.path, options.paths)) continue;
    if (row.a === undefined && row.b === undefined) continue;
    candidates.push({
      path: row.path,
      before: row.a,
      index: row.b !== undefined && row.b.mode !== 0o160000 ? row.b : undefined,
      worktree: row.c,
    });
    if (candidates.length >= DIFF_WINDOW_ROWS) {
      yield* resolveWorkingCandidates(repo, worktree, candidates);
    }
  }
  yield* resolveWorkingCandidates(repo, worktree, candidates);
}

function sparseCommitPair(
  repo: Repository,
  beforeTreeOid: string | null,
  afterTreeOid: string | null,
  options: DiffOptions,
): PendingChange[] | null {
  const changes: PendingChange[] = [];
  let matchingEntries = 0;
  let retainedBytes = 0;
  try {
    for (const entry of repo.walkTreeDiff(beforeTreeOid, afterTreeOid)) {
      if (!matchesPaths(entry.path, options.paths)) continue;
      if (matchingEntries >= SPARSE_DIFF_PATHS) return null;
      matchingEntries++;
      retainedBytes += SPARSE_DIFF_ROW_BYTES + utf8.encode(entry.path).length;
      if (retainedBytes > SPARSE_DIFF_RETAINED_BYTES) return null;
      const change = compareIdentities(
        entry.path,
        treePartsIdentity(entry.beforeMode, entry.beforeOid),
        treePartsIdentity(entry.afterMode, entry.afterOid),
      );
      if (change !== null) changes.push(change);
    }
  } catch (error) {
    if (hasErrorCode(error, "E2BIG")) return null;
    throw error;
  }
  return changes;
}

function sparseWorkingCandidates(
  repo: Repository,
  source: SparseWorkspaceSource,
  currentTreeOid: string | null,
  options: DiffOptions,
): WorkingCandidate[] | null {
  try {
    const state = source.readState(repo.store.repoId);
    if (!state.available) return null;
    const paths = sparseWorkingPaths(
      repo,
      source.dirtyPaths(repo.store.repoId),
      state.baselineTreeOid,
      currentTreeOid,
      options.paths,
    );
    if (paths === null) return null;
    if (paths.length === 0) return [];

    const hydrated = source.hydrate({
      repoId: repo.store.repoId,
      root: repo.root,
      baselineTreeOid: state.baselineTreeOid,
      currentTreeOid,
      paths,
    });
    if (!hydrated.available) return null;
    if (hydrated.rows.length !== paths.length) {
      throw new CorruptError("sparse diff hydration returned the wrong row count");
    }

    const candidates: WorkingCandidate[] = [];
    for (let ordinal = 0; ordinal < paths.length; ordinal++) {
      const path = paths[ordinal];
      const row = hydrated.rows[ordinal];
      if (path === undefined || row === undefined || row.path !== path) {
        throw new CorruptError("sparse diff hydration returned unordered rows");
      }
      const stage = row.index.find((entry) => entry.stage === 0);
      if (row.current === null && stage === undefined) continue;
      candidates.push({
        path,
        before: sparseTarget(path, row),
        index: stage !== undefined && stage.mode !== 0o160000 ? stage : undefined,
        worktree: sparseWorktreePath(row),
      });
    }
    return candidates;
  } catch (error) {
    if (hasErrorCode(error, "E2BIG")) return null;
    throw error;
  }
}

function sparseWorkingPaths(
  repo: Repository,
  dirty: Iterable<{ path: string }>,
  baselineTreeOid: string | null,
  currentTreeOid: string | null,
  pathspecs: string[] | undefined,
): string[] | null {
  const paths = new Set<string>();
  let retainedBytes = 0;
  const add = (path: string): boolean => {
    if (!matchesPaths(path, pathspecs) || paths.has(path)) return true;
    retainedBytes += SPARSE_DIFF_ROW_BYTES + utf8.encode(path).length;
    if (paths.size >= SPARSE_DIFF_PATHS || retainedBytes > SPARSE_DIFF_RETAINED_BYTES) return false;
    paths.add(path);
    return true;
  };
  for (const entry of dirty) {
    if (!add(entry.path)) return null;
  }
  for (const entry of repo.walkTreeDiff(baselineTreeOid, currentTreeOid)) {
    if (!add(entry.path)) return null;
  }
  return [...paths].sort(comparePaths);
}

function sparseTarget(path: string, row: SparseWorkspaceRow): TargetEntry | undefined {
  return row.current === null ? undefined : { path, mode: row.current.mode, oid: row.current.oid };
}

function sparseWorktreePath(row: SparseWorkspaceRow): WorktreePath | undefined {
  if (row.worktree === null || row.worktree.type === "dir") return undefined;
  return { path: row.path, stat: row.worktree };
}

function treePartsIdentity(mode: string | null, oid: string | null): EndpointIdentity | null {
  if (mode === null || oid === null || mode === "160000") return null;
  return { mode, oid, worktree: null };
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function* resolveWorkingCandidates(
  repo: Repository,
  worktree: Worktree,
  candidates: WorkingCandidate[],
  exact = false,
): Generator<FileChange> {
  if (candidates.length === 0) return;
  const rows = candidates.splice(0);
  const expected: BlobIdMapping[] = [];
  for (const row of rows) {
    const mapping = expectedWorktreeMapping(row);
    if (mapping !== null) expected.push(mapping);
  }
  const mismatches = repo.store.blobIdMismatches(expected);
  const unresolved: WorktreePath[] = [];
  const mapped = new Map<string, string>();
  let expectedOrdinal = 0;
  for (const row of rows) {
    if (cachedWorktreeOid(row.index, row.worktree) !== null) continue;
    const mapping = expectedWorktreeMapping(row);
    const mismatch = mapping === null ? null : mismatches.get(expectedOrdinal);
    const oid =
      mapping === null
        ? undefined
        : mismatches.has(expectedOrdinal)
          ? (mismatch ?? undefined)
          : mapping.oid;
    if (mapping !== null) expectedOrdinal++;
    if (oid !== undefined) mapped.set(row.path, oid);
    else if (row.worktree !== undefined && row.worktree.stat.type !== "dir") {
      unresolved.push(row.worktree);
    }
  }
  const hashes = exact
    ? hashExactWorktreePaths(repo, worktree, unresolved, { write: false })
    : hashWorktreePaths(repo, worktree, unresolved, { write: false });
  repo.store.upsertBlobIds(
    [...hashes.values()].flatMap((hashed) => {
      const contentId = hashed.stat.contentId;
      return contentId === null ? [] : [{ contentId, oid: hashed.oid }];
    }),
  );

  const changes: PendingChange[] = [];
  for (const row of rows) {
    const cached = cachedWorktreeOid(row.index, row.worktree);
    const hashed = hashes.get(row.path);
    const oid = cached ?? mapped.get(row.path) ?? hashed?.oid;
    const after =
      oid === undefined || row.worktree === undefined || row.worktree.stat.type === "dir"
        ? null
        : {
            mode: hashed?.mode ?? gitModeFor(row.worktree.stat),
            oid,
            worktree: row.worktree,
          };
    const change = compareIdentities(row.path, treeIdentity(row.before), after);
    if (change !== null) changes.push(change);
  }
  yield* hydrateChanges(repo, worktree, changes);
}

function expectedWorktreeOid(row: WorkingCandidate): string | undefined {
  return row.index?.oid ?? row.before?.oid;
}

function expectedWorktreeMapping(row: WorkingCandidate): BlobIdMapping | null {
  if (cachedWorktreeOid(row.index, row.worktree) !== null) return null;
  const contentId = row.worktree?.stat.contentId;
  const oid = expectedWorktreeOid(row);
  return contentId === null || contentId === undefined || oid === undefined
    ? null
    : { contentId, oid };
}

function cachedWorktreeOid(
  entry: IndexEntry | undefined,
  worktree: WorktreePath | undefined,
): string | null {
  if (entry === undefined || worktree === undefined || worktree.stat.type === "dir") return null;
  return indexMatchesStat(entry, worktree.stat) ? entry.oid : null;
}

/** A change, or null when the two identities agree or neither exists. */
function compareIdentities(
  path: string,
  before: EndpointIdentity | null,
  after: EndpointIdentity | null,
): PendingChange | null {
  if (before === null && after === null) return null;
  if (before !== null && after !== null && before.oid === after.oid && before.mode === after.mode) {
    return null;
  }
  return { path, before, after };
}

function treeIdentity(entry: TargetEntry | undefined): EndpointIdentity | null {
  // Submodules are out of scope.
  if (entry === undefined || entry.mode === "160000") return null;
  return { mode: entry.mode, oid: entry.oid, worktree: null };
}

function* hydrateChanges(
  repo: Repository,
  worktree: Worktree,
  changes: PendingChange[],
): Generator<FileChange> {
  if (changes.length === 0) return;
  const pending = changes.splice(0);
  const root = worktree.realpath(repo.root);
  let offset = 0;

  while (offset < pending.length) {
    let end = offset;
    let worktreeBytes = 0;
    while (end < pending.length && end - offset < DIFF_WINDOW_ROWS) {
      const change = pending[end]!;
      const size = requiredWorktreeBytes(change);
      if (size > DIFF_WORKTREE_BYTES) {
        throw new GitError("EFBIG", `diff path ${change.path} exceeds the working-tree byte limit`);
      }
      if (end > offset && worktreeBytes + size > DIFF_WORKTREE_BYTES) break;
      worktreeBytes += size;
      end++;
    }

    const proposed = pending.slice(offset, end);
    const wanted = repositoryOids(proposed);
    const stored = new Map<string, Uint8Array>();
    let remaining = wanted;
    let storedBytes = 0;
    while (remaining.length > 0 && storedBytes < DIFF_REPOSITORY_BYTES) {
      const budget = Math.min(4 * 1024 * 1024, DIFF_REPOSITORY_BYTES - storedBytes);
      let batch: BlobReadBatch;
      try {
        batch = repo.readBlobs(remaining, { budgetBytes: budget });
      } catch (error) {
        if (error instanceof GitError && error.code === "EFBIG") break;
        throw error;
      }
      for (const [oid, bytes] of batch.blobs) stored.set(oid, bytes);
      storedBytes += batch.bytes;
      if (batch.remaining.length >= remaining.length) {
        throw new CorruptError("bulk blob reader did not make progress");
      }
      remaining = batch.remaining;
    }

    let ready = 0;
    for (const change of proposed) {
      if (!repositoryOids([change]).every((oid) => stored.has(oid))) break;
      ready++;
    }
    if (ready === 0) {
      throw new GitError(
        "EFBIG",
        `diff path ${pending[offset]?.path ?? ""} exceeds the blob limit`,
      );
    }
    const group = proposed.slice(0, ready);
    const worktreeContents = readWorktreeContents(worktree, root, group);
    for (const change of group) {
      yield {
        path: change.path,
        before: hydrateEndpoint(change.before, stored, worktreeContents),
        after: hydrateEndpoint(change.after, stored, worktreeContents),
      };
    }
    offset += ready;
  }
}

function requiredWorktreeBytes(change: PendingChange): number {
  if (!contentDiffers(change) || change.after === null || change.after.worktree === null) return 0;
  return change.after.worktree.stat.size;
}

function repositoryOids(changes: readonly PendingChange[]): string[] {
  const oids = new Set<string>();
  for (const change of changes) {
    if (!contentDiffers(change)) continue;
    if (change.before !== null && change.before.worktree === null) oids.add(change.before.oid);
    if (change.after !== null && change.after.worktree === null) oids.add(change.after.oid);
  }
  return [...oids];
}

function contentDiffers(change: PendingChange): boolean {
  return change.before?.oid !== change.after?.oid;
}

function readWorktreeContents(
  worktree: Worktree,
  root: string,
  changes: readonly PendingChange[],
): Map<string, Uint8Array> {
  const contents = new Map<string, Uint8Array>();
  const files: string[] = [];
  for (const change of changes) {
    const endpoint = change.after;
    if (!contentDiffers(change) || endpoint === null || endpoint.worktree === null) continue;
    if (endpoint.worktree.stat.type === "symlink") {
      const target = endpoint.worktree.stat.target;
      if (target === null) throw new CorruptError(`symlink ${change.path} has no target`);
      contents.set(change.path, utf8.encode(target));
    } else {
      files.push(joinPath(root, change.path));
    }
  }

  let remaining = files;
  while (remaining.length > 0) {
    const batch = worktree.readFiles(remaining);
    for (const [absolute, bytes] of batch.files) {
      const prefix = root === "/" ? "/" : `${root}/`;
      if (!absolute.startsWith(prefix)) {
        throw new CorruptError(`worktree read returned a path outside ${root}`);
      }
      contents.set(absolute.slice(prefix.length), bytes);
    }
    if (batch.remaining.length >= remaining.length) {
      throw new CorruptError("bulk worktree reader did not make progress");
    }
    remaining = batch.remaining;
  }
  return contents;
}

function hydrateEndpoint(
  identity: EndpointIdentity | null,
  stored: ReadonlyMap<string, Uint8Array>,
  worktree: ReadonlyMap<string, Uint8Array>,
): Endpoint | null {
  if (identity === null) return null;
  const bytes =
    identity.worktree === null ? stored.get(identity.oid) : worktree.get(identity.worktree.path);
  return { mode: identity.mode, oid: identity.oid, bytes: bytes ?? null };
}

function endpointBytes(endpoint: Endpoint): Uint8Array {
  if (endpoint.bytes === null) throw new CorruptError(`diff bytes missing for ${endpoint.oid}`);
  return endpoint.bytes;
}

/** The "from" tree: an explicit ref, or HEAD — which may be unborn. */
function resolveFrom(repo: Repository, options: DiffOptions): string | null {
  if (options.ref === undefined) return repo.headTree();
  return treeOf(repo, repo.revParse(options.ref));
}
