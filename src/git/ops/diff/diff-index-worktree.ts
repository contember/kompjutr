import { utf8 } from "../../common/bytes.js";
import { CorruptError, GitError } from "../../common/errors.js";
import { joinPath } from "../../common/paths.js";
import { joinSorted } from "../../common/streams.js";
import type { BlobReadBatch, IndexEntry } from "../../store/index.js";
import { matchesPaths } from "../checkout/checkout.js";
import type { Repository } from "../repository/repository.js";
import { type StatusIndexGroup, statusIndexGroups } from "../status/status-rows.js";
import type { Worktree } from "../worktree/worktree.js";
import { type WorktreePath, walkWorktreeEntriesStream } from "../worktree/worktree-io.js";
import {
  contentDiffers,
  readWorktreeFileContents,
  repositoryOids,
  requiredWorktreeBytes,
} from "./diff-hydrate.js";
import {
  compareIdentities,
  type DiffOptions,
  type EndpointIdentity,
  type PendingChange,
  treeIdentity,
  type WorkingCandidate,
} from "./diff-internal.js";
import {
  DIFF_REPOSITORY_BYTES,
  DIFF_WINDOW_ROWS,
  DIFF_WORKTREE_BYTES,
  hydrateEndpoint,
  type PatchChange,
  type UnmergedPathChange,
} from "./diff-types.js";
import { indexTarget, resolveWorkingCandidateAfters } from "./diff-worktree.js";

type IndexPatchCandidate =
  | { kind: "tracked"; row: WorkingCandidate }
  | {
      kind: "combined";
      path: string;
      parents: readonly [IndexEntry, IndexEntry];
      worktree: WorktreePath | undefined;
    }
  | UnmergedPathChange;

interface PendingCombinedChange {
  kind: "combined";
  path: string;
  parents: readonly [EndpointIdentity, EndpointIdentity];
  after: EndpointIdentity | null;
}

type PendingIndexPatchChange = PendingChange | PendingCombinedChange | UnmergedPathChange;

function isPendingCombinedChange(change: PendingIndexPatchChange): change is PendingCombinedChange {
  return "kind" in change && change.kind === "combined";
}

function isPendingUnmergedChange(change: PendingIndexPatchChange): change is UnmergedPathChange {
  return "kind" in change && change.kind === "unmerged";
}

export function* indexWorktreePatchChanges(
  repo: Repository,
  worktree: Worktree,
  options: DiffOptions,
): Generator<PatchChange> {
  const candidates: IndexPatchCandidate[] = [];
  for (const row of joinSorted(
    statusIndexGroups(repo.checkout.indexScan()),
    walkWorktreeEntriesStream(
      worktree,
      repo.root,
      options.paths === undefined || options.paths.length === 0
        ? { filesOnly: true }
        : { paths: options.paths },
    ),
    { left: (group) => group.path, right: (entry) => entry.path },
  )) {
    const group = row.left;
    if (group === undefined || !matchesPaths(row.path, options.paths)) continue;
    if (group.kind === "tracked" && group.entry.mode === 0o160000) continue;
    candidates.push(indexPatchCandidate(group, row.right));
    if (candidates.length >= DIFF_WINDOW_ROWS) {
      yield* hydrateIndexPatchCandidates(repo, worktree, candidates);
    }
  }
  yield* hydrateIndexPatchCandidates(repo, worktree, candidates);
}

function indexPatchCandidate(
  group: StatusIndexGroup,
  worktree: WorktreePath | undefined,
): IndexPatchCandidate {
  if (group.kind === "tracked") {
    return {
      kind: "tracked",
      row: {
        path: group.path,
        before: indexTarget(group.entry),
        index: group.entry,
        worktree,
      },
    };
  }
  const current = group.current;
  const incoming = group.incoming;
  if (
    current === undefined ||
    incoming === undefined ||
    current.mode === 0o160000 ||
    incoming.mode === 0o160000
  ) {
    return { kind: "unmerged", path: group.path };
  }
  return { kind: "combined", path: group.path, parents: [current, incoming], worktree };
}

function* hydrateIndexPatchCandidates(
  repo: Repository,
  worktree: Worktree,
  candidates: IndexPatchCandidate[],
): Generator<PatchChange> {
  if (candidates.length === 0) return;
  const source = candidates.splice(0);
  const working: WorkingCandidate[] = [];
  for (const candidate of source) {
    if (candidate.kind === "tracked") {
      working.push(candidate.row);
    } else if (candidate.kind === "combined") {
      working.push({
        path: candidate.path,
        before: indexTarget(candidate.parents[0]),
        index: undefined,
        worktree: candidate.worktree,
      });
    }
  }
  const afters = resolveWorkingCandidateAfters(repo, worktree, working, true);
  const pending: PendingIndexPatchChange[] = [];
  for (const candidate of source) {
    if (candidate.kind === "unmerged") {
      pending.push(candidate);
      continue;
    }
    const after = afters.get(candidate.kind === "tracked" ? candidate.row.path : candidate.path);
    if (after === undefined) throw new CorruptError("diff lost a working-tree candidate");
    if (candidate.kind === "tracked") {
      const change = compareIdentities(
        candidate.row.path,
        treeIdentity(candidate.row.before),
        after,
      );
      if (change !== null) pending.push(change);
      continue;
    }
    pending.push({
      kind: "combined",
      path: candidate.path,
      parents: [
        treeIdentity(indexTarget(candidate.parents[0])) ?? missingConflictParent(candidate.path),
        treeIdentity(indexTarget(candidate.parents[1])) ?? missingConflictParent(candidate.path),
      ],
      after,
    });
  }
  yield* hydrateIndexPatchChanges(repo, worktree, pending);
}

function missingConflictParent(path: string): never {
  throw new CorruptError(`diff conflict parent disappeared at ${path}`);
}

function* hydrateIndexPatchChanges(
  repo: Repository,
  worktree: Worktree,
  changes: readonly PendingIndexPatchChange[],
): Generator<PatchChange> {
  if (changes.length === 0) return;
  const root = worktree.realpath(repo.root);
  let offset = 0;
  while (offset < changes.length) {
    let end = offset;
    let worktreeBytes = 0;
    while (end < changes.length && end - offset < DIFF_WINDOW_ROWS) {
      const change = changes[end]!;
      const size = indexPatchWorktreeBytes(change);
      if (size > DIFF_WORKTREE_BYTES) {
        throw new GitError("EFBIG", `diff path ${change.path} exceeds the working-tree byte limit`);
      }
      if (end > offset && worktreeBytes + size > DIFF_WORKTREE_BYTES) break;
      worktreeBytes += size;
      end++;
    }

    const proposed = changes.slice(offset, end);
    const wanted = indexPatchRepositoryOids(proposed);
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
      if (!indexPatchRepositoryOids([change]).every((oid) => stored.has(oid))) break;
      ready++;
    }
    if (ready === 0) {
      throw new GitError(
        "EFBIG",
        `diff path ${changes[offset]?.path ?? ""} exceeds the blob limit`,
      );
    }
    const group = proposed.slice(0, ready);
    const worktreeContents = readIndexPatchWorktreeContents(worktree, root, group);
    for (const change of group) {
      if (isPendingUnmergedChange(change)) {
        yield change;
      } else if (isPendingCombinedChange(change)) {
        yield {
          kind: "combined",
          path: change.path,
          parents: [
            hydrateEndpoint(change.parents[0], stored, worktreeContents) ??
              missingHydratedConflictParent(change.path),
            hydrateEndpoint(change.parents[1], stored, worktreeContents) ??
              missingHydratedConflictParent(change.path),
          ],
          after: hydrateEndpoint(change.after, stored, worktreeContents),
        };
      } else {
        yield {
          path: change.path,
          before: hydrateEndpoint(change.before, stored, worktreeContents),
          after: hydrateEndpoint(change.after, stored, worktreeContents),
        };
      }
    }
    offset += ready;
  }
}

function missingHydratedConflictParent(path: string): never {
  throw new CorruptError(`diff conflict parent bytes disappeared at ${path}`);
}

function indexPatchWorktreeBytes(change: PendingIndexPatchChange): number {
  if (isPendingUnmergedChange(change)) return 0;
  if (isPendingCombinedChange(change)) {
    if (change.after === null) return 0;
    return change.after.worktree?.stat.size ?? 0;
  }
  return requiredWorktreeBytes(change);
}

function indexPatchRepositoryOids(changes: readonly PendingIndexPatchChange[]): string[] {
  const oids = new Set<string>();
  for (const change of changes) {
    if (isPendingUnmergedChange(change)) continue;
    if (isPendingCombinedChange(change)) {
      for (const parent of change.parents) oids.add(parent.oid);
      continue;
    }
    for (const oid of repositoryOids([change])) oids.add(oid);
  }
  return [...oids];
}

function readIndexPatchWorktreeContents(
  worktree: Worktree,
  root: string,
  changes: readonly PendingIndexPatchChange[],
): Map<string, Uint8Array> {
  const contents = new Map<string, Uint8Array>();
  const files: string[] = [];
  for (const change of changes) {
    if (isPendingUnmergedChange(change)) continue;
    const endpoint = change.after;
    if (endpoint === null || endpoint.worktree === null) continue;
    if (!isPendingCombinedChange(change) && !contentDiffers(change)) continue;
    if (endpoint.worktree.stat.type === "symlink") {
      const target = endpoint.worktree.stat.target;
      if (target === null) throw new CorruptError(`symlink ${change.path} has no target`);
      contents.set(change.path, utf8.encode(target));
    } else {
      files.push(joinPath(root, change.path));
    }
  }
  readWorktreeFileContents(worktree, root, files, contents);
  return contents;
}
