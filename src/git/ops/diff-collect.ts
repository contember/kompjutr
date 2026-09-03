import { CorruptError, GitError } from "../common/errors.js";
import { joinSorted, joinSorted3 } from "../common/streams.js";
import { matchesPaths, stageZero } from "./checkout.js";
import { hydrateChanges } from "./diff-hydrate.js";
import { indexWorktreePatchChanges } from "./diff-index-worktree.js";
import {
  compareIdentities,
  type DiffOptions,
  type EndpointIdentity,
  type PendingChange,
  treeIdentity,
  type WorkingCandidate,
} from "./diff-internal.js";
import {
  DIFF_WINDOW_ROWS,
  type FileChange,
  type PatchChange,
  type TreeDiffOptions,
} from "./diff-types.js";
import { indexTarget, resolveWorkingCandidateIdentities } from "./diff-worktree.js";
import {
  type ExactRename,
  type ExactRenameClassification,
  ExactRenameClassifier,
  renameDetectionEnabled,
} from "./rename-detection.js";
import type { Repository } from "./repository.js";
import { sparseCommitPair, sparseWorkingCandidates } from "./sparse-diff.js";
import type { SparseWorkspaceSource } from "./sparse-workspace.js";
import { statusIndexGroups } from "./status-rows.js";
import { type TargetEntry, treeStream } from "./tree-stream.js";
import type { Worktree } from "./worktree.js";
import { createWorktreeHashCursor, walkWorktreeEntriesStream } from "./worktree-io.js";

export function* collect(
  repo: Repository,
  worktree: Worktree,
  options: DiffOptions,
  sparseWorkspace: SparseWorkspaceSource | undefined,
  indexBase = false,
): Generator<PatchChange> {
  if (indexBase) {
    if (options.staged === true || options.ref !== undefined || options.to !== undefined) {
      throw new GitError("EINVAL", "index-worktree diff does not accept tree endpoints");
    }
    yield* indexWorktreePatchChanges(repo, worktree, options);
    return;
  }
  if (options.staged === true) {
    if (options.to !== undefined) {
      throw new GitError("EINVAL", "staged diff accepts only one tree endpoint");
    }
    const classification = classifyDiffRenames(repo, options, stagedPendingChanges(repo, options));
    yield* collectPendingChanges(
      repo,
      worktree,
      stagedPendingChanges(repo, options),
      classification,
    );
    return;
  }
  const sparse = boundedSparsePendingChanges(repo, worktree, options, sparseWorkspace);
  if (sparse !== null) {
    yield* collectPendingChanges(
      repo,
      worktree,
      sparse,
      classifyDiffRenames(repo, options, sparse),
    );
    return;
  }
  const classification = classifyDiffRenames(
    repo,
    options,
    pendingChanges(repo, worktree, options, true),
  );
  yield* collectPendingChanges(
    repo,
    worktree,
    pendingChanges(repo, worktree, options, false),
    classification,
  );
}

function* stagedPendingChanges(repo: Repository, options: DiffOptions): Generator<PendingChange> {
  const from = treeStream(repo, resolveFrom(repo, options));
  for (const row of joinSorted(from, statusIndexGroups(repo.checkout.indexScan()), {
    left: (entry) => entry.path,
    right: (group) => group.path,
  })) {
    const group = row.right;
    if (group?.kind === "unmerged") {
      throw new GitError("EUNMERGED", `cannot diff staged contents with conflict at ${row.path}`);
    }
    if (!matchesPaths(row.path, options.paths)) continue;
    const after = group === undefined ? null : treeIdentity(indexTarget(group.entry));
    const change = compareIdentities(row.path, treeIdentity(row.left), after);
    if (change !== null) yield change;
  }
}

export function* collectPendingChanges(
  repo: Repository,
  worktree: Worktree | undefined,
  changes: Iterable<PendingChange>,
  classification: ExactRenameClassification | undefined,
): Generator<FileChange> {
  const sources =
    classification?.kind === "classified"
      ? new Set(classification.renames.map((rename) => rename.source.path))
      : new Set<string>();
  const destinations =
    classification?.kind === "classified"
      ? new Map(classification.renames.map((rename) => [rename.destination.path, rename]))
      : new Map<string, ExactRename>();
  const pending: PendingChange[] = [];
  for (const change of changes) {
    if (sources.has(change.path)) continue;
    const rename = destinations.get(change.path);
    if (rename !== undefined) {
      yield* hydrateChanges(repo, worktree, pending);
      yield exactRenameChange(rename, change);
      continue;
    }
    pending.push(change);
    if (pending.length >= DIFF_WINDOW_ROWS) yield* hydrateChanges(repo, worktree, pending);
  }
  yield* hydrateChanges(repo, worktree, pending);
}

export function classifyDiffRenames(
  repo: Repository,
  options: TreeDiffOptions,
  changes: Iterable<PendingChange>,
): ExactRenameClassification | undefined {
  if (!renameDetectionEnabled(repo, "diff", options.renames)) return undefined;
  const classifier = new ExactRenameClassifier();
  for (const change of changes) {
    let retained = true;
    if (change.before !== null && change.after === null) {
      retained = classifier.addSource({
        path: change.path,
        mode: change.before.mode,
        oid: change.before.oid,
      });
    } else if (change.before === null && change.after !== null) {
      retained = classifier.addDestination({
        path: change.path,
        mode: change.after.mode,
        oid: change.after.oid,
      });
    }
    if (!retained) break;
  }
  return classifier.finish();
}

export function* treePendingChanges(
  repo: Repository,
  beforeTree: string | null,
  afterTree: string | null,
  options: TreeDiffOptions,
): Generator<PendingChange> {
  for (const row of repo.walkTreeDiff(beforeTree, afterTree)) {
    if (!matchesPaths(row.path, options.paths)) continue;
    const before = treeDiffIdentity(row.beforeMode, row.beforeOid);
    const after = treeDiffIdentity(row.afterMode, row.afterOid);
    const change = compareIdentities(row.path, before, after);
    if (change !== null) yield change;
  }
}

function treeDiffIdentity(mode: string | null, oid: string | null): EndpointIdentity | null {
  if (mode === null || oid === null || mode === "160000") return null;
  return { mode, oid, worktree: null };
}

function boundedSparsePendingChanges(
  repo: Repository,
  worktree: Worktree,
  options: DiffOptions,
  sparseWorkspace: SparseWorkspaceSource | undefined,
): PendingChange[] | null {
  const fromTreeOid = resolveFrom(repo, options);
  if (options.to !== undefined) {
    return sparseCommitPair(repo, fromTreeOid, repo.resolveTreeRevision(options.to), options);
  }
  if (sparseWorkspace === undefined) return null;
  const candidates = sparseWorkingCandidates(repo, sparseWorkspace, fromTreeOid, options);
  if (candidates === null) return null;
  return [...resolveWorkingCandidateIdentities(repo, worktree, candidates, true)];
}

function* pendingChanges(
  repo: Repository,
  worktree: Worktree,
  options: DiffOptions,
  renameCandidatesOnly = false,
): Generator<PendingChange> {
  const fromTreeOid = resolveFrom(repo, options);
  const byPath = { left: (entry: TargetEntry) => entry.path };

  if (options.to !== undefined) {
    const toTreeOid = repo.resolveTreeRevision(options.to);
    const from = treeStream(repo, fromTreeOid);
    const to = treeStream(repo, toTreeOid);
    for (const row of joinSorted(from, to, { ...byPath, right: (entry) => entry.path })) {
      if (!matchesPaths(row.path, options.paths)) continue;
      const change = compareIdentities(row.path, treeIdentity(row.left), treeIdentity(row.right));
      if (
        change !== null &&
        (!renameCandidatesOnly || (change.before === null) !== (change.after === null))
      ) {
        yield change;
      }
    }
    return;
  }

  // The working-tree side covers only paths git would consider — those in
  // the "from" tree or in the index — so an untracked file stays out of the
  // patch, as it does in real `git diff`.
  const from = treeStream(repo, fromTreeOid);
  const candidates: WorkingCandidate[] = [];
  const hashCursor = createWorktreeHashCursor();
  for (const row of joinSorted3(
    from,
    stageZero(repo.checkout.indexScan()),
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
    const worktreePresent = row.c !== undefined && row.c.stat.type !== "dir";
    if (renameCandidatesOnly && (row.a === undefined) === !worktreePresent) continue;
    candidates.push({
      path: row.path,
      before: row.a,
      index: row.b !== undefined && row.b.mode !== 0o160000 ? row.b : undefined,
      worktree: row.c,
    });
    if (candidates.length >= DIFF_WINDOW_ROWS) {
      yield* resolveWorkingCandidateIdentities(
        repo,
        worktree,
        candidates,
        false,
        renameCandidatesOnly,
        hashCursor,
      );
    }
  }
  yield* resolveWorkingCandidateIdentities(
    repo,
    worktree,
    candidates,
    false,
    renameCandidatesOnly,
    hashCursor,
  );
}

function exactRenameChange(rename: ExactRename, destination: PendingChange): FileChange {
  if (
    destination.before !== null ||
    destination.after === null ||
    destination.path !== rename.destination.path ||
    destination.after.mode !== rename.destination.mode ||
    destination.after.oid !== rename.destination.oid
  ) {
    throw new CorruptError("diff rename destination does not match its addition");
  }
  return {
    path: rename.destination.path,
    originalPath: rename.source.path,
    similarity: rename.similarity,
    before: { mode: rename.source.mode, oid: rename.source.oid, bytes: null },
    after: { mode: rename.destination.mode, oid: rename.destination.oid, bytes: null },
  };
}

/** The "from" tree: an explicit ref, or HEAD — which may be unborn. */
function resolveFrom(repo: Repository, options: DiffOptions): string | null {
  if (options.ref === undefined) return repo.headTree();
  return repo.resolveTreeRevision(options.ref);
}
