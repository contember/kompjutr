import { CorruptError, GitError } from "../../common/errors.js";
import { joinSorted, joinSorted3 } from "../../common/streams.js";
import type { SparseWorkspaceSource } from "../../store/core/contracts.js";
import { stageZero } from "../checkout/checkout.js";
import type { Repository } from "../repository/repository.js";
import {
  type ExactRename,
  type ExactRenameClassification,
  ExactRenameClassifier,
  renameDetectionEnabled,
} from "../status/rename-detection.js";
import { statusIndexGroups } from "../status/status-rows.js";
import { type TargetEntry, treeStream } from "../tree/tree-stream.js";
import { sparseCommitPair, sparseWorkingCandidates } from "../worktree/sparse-diff.js";
import type { Worktree } from "../worktree/worktree.js";
import {
  compilePathspecs,
  createWorktreeHashCursor,
  hasGlobSyntax,
  walkWorktreeEntriesStream,
} from "../worktree/worktree-io.js";
import { hydrateChanges } from "./diff-hydrate.js";
import { indexWorktreePatchChanges } from "./diff-index-worktree.js";
import {
  compareIdentities,
  type DiffOptions,
  type EndpointIdentity,
  matchesDiffPath,
  type PendingChange,
  type SelectedDiffOptions,
  treeIdentity,
  type WorkingCandidate,
} from "./diff-internal.js";
import {
  DIFF_WINDOW_ROWS,
  type FileChange,
  nameOnlyEndpoint,
  type PatchChange,
  type TreeDiffOptions,
} from "./diff-types.js";
import { indexTarget, resolveWorkingCandidateIdentities } from "./diff-worktree.js";

export function* collect(
  repo: Repository,
  worktree: Worktree,
  options: DiffOptions,
  sparseWorkspace: SparseWorkspaceSource | undefined,
  indexBase = false,
  namesOnly = false,
): Generator<PatchChange> {
  const selected: SelectedDiffOptions = { ...options, pathspec: compilePathspecs(options.paths) };
  if (indexBase) {
    if (options.staged === true || options.ref !== undefined || options.to !== undefined) {
      throw new GitError("EINVAL", "index-worktree diff does not accept tree endpoints");
    }
    yield* indexWorktreePatchChanges(repo, worktree, selected, namesOnly);
    return;
  }
  if (options.staged === true) {
    if (options.to !== undefined) {
      throw new GitError("EINVAL", "staged diff accepts only one tree endpoint");
    }
    const classification = classifyDiffRenames(
      repo,
      selected,
      stagedPendingChanges(repo, selected),
    );
    yield* collectPendingChanges(
      repo,
      worktree,
      stagedPendingChanges(repo, selected),
      classification,
      namesOnly,
    );
    return;
  }
  const sparse = boundedSparsePendingChanges(repo, worktree, selected, sparseWorkspace);
  if (sparse !== null) {
    yield* collectPendingChanges(
      repo,
      worktree,
      sparse,
      classifyDiffRenames(repo, selected, sparse),
      namesOnly,
    );
    return;
  }
  const classification = classifyDiffRenames(
    repo,
    selected,
    pendingChanges(repo, worktree, selected, true),
  );
  yield* collectPendingChanges(
    repo,
    worktree,
    pendingChanges(repo, worktree, selected, false),
    classification,
    namesOnly,
  );
}

function* stagedPendingChanges(
  repo: Repository,
  options: SelectedDiffOptions,
): Generator<PendingChange> {
  const from = treeStream(repo, resolveFrom(repo, options));
  for (const row of joinSorted(from, statusIndexGroups(repo.checkout.indexScan()), {
    left: (entry) => entry.path,
    right: (group) => group.path,
  })) {
    const group = row.right;
    if (group?.kind === "unmerged") {
      throw new GitError("EUNMERGED", `cannot diff staged contents with conflict at ${row.path}`);
    }
    if (!matchesDiffPath(row.path, options)) continue;
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
  namesOnly = false,
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
      yield* renderPendingChanges(repo, worktree, pending, namesOnly);
      yield exactRenameChange(rename, change);
      continue;
    }
    pending.push(change);
    if (pending.length >= DIFF_WINDOW_ROWS)
      yield* renderPendingChanges(repo, worktree, pending, namesOnly);
  }
  yield* renderPendingChanges(repo, worktree, pending, namesOnly);
}

function* renderPendingChanges(
  repo: Repository,
  worktree: Worktree | undefined,
  pending: PendingChange[],
  namesOnly: boolean,
): Generator<FileChange> {
  if (!namesOnly) {
    yield* hydrateChanges(repo, worktree, pending);
    return;
  }
  for (const change of pending.splice(0)) {
    yield {
      path: change.path,
      before: nameOnlyEndpoint(change.before),
      after: nameOnlyEndpoint(change.after),
    };
  }
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
  const pathspec = compilePathspecs(options.paths);
  for (const row of repo.walkTreeDiff(beforeTree, afterTree)) {
    if (!pathspec.matches(row.path)) continue;
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
  options: SelectedDiffOptions,
  sparseWorkspace: SparseWorkspaceSource | undefined,
): PendingChange[] | null {
  if (options.paths?.some(hasGlobSyntax)) return null;
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
  options: SelectedDiffOptions,
  renameCandidatesOnly = false,
): Generator<PendingChange> {
  const fromTreeOid = resolveFrom(repo, options);
  const byPath = { left: (entry: TargetEntry) => entry.path };

  if (options.to !== undefined) {
    const toTreeOid = repo.resolveTreeRevision(options.to);
    const from = treeStream(repo, fromTreeOid);
    const to = treeStream(repo, toTreeOid);
    for (const row of joinSorted(from, to, { ...byPath, right: (entry) => entry.path })) {
      if (!matchesDiffPath(row.path, options)) continue;
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
        : { pathspec: options.pathspec },
    ),
    {
      a: (entry) => entry.path,
      b: (entry) => entry.path,
      c: (entry) => entry.path,
    },
  )) {
    if (!matchesDiffPath(row.path, options)) continue;
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
