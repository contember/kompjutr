import { utf8 } from "../../common/bytes.js";
import { CorruptError, GitError } from "../../common/errors.js";
import { joinPath } from "../../common/paths.js";
import type { BlobReadBatch } from "../../store/index.js";
import type { Repository } from "../repository/repository.js";
import type { Worktree } from "../worktree/worktree.js";
import type { PendingChange } from "./diff-internal.js";
import {
  DIFF_REPOSITORY_BYTES,
  DIFF_WINDOW_ROWS,
  DIFF_WORKTREE_BYTES,
  type FileChange,
  hydrateEndpoint,
} from "./diff-types.js";

export function* hydrateChanges(
  repo: Repository,
  worktree: Worktree | undefined,
  changes: PendingChange[],
): Generator<FileChange> {
  if (changes.length === 0) return;
  const pending = changes.splice(0);
  const root = worktree?.realpath(repo.root);
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
    const worktreeContents =
      worktree === undefined || root === undefined
        ? new Map<string, Uint8Array>()
        : readWorktreeContents(worktree, root, group);
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

export function requiredWorktreeBytes(change: PendingChange): number {
  if (!contentDiffers(change) || change.after === null || change.after.worktree === null) return 0;
  return change.after.worktree.stat.size;
}

export function repositoryOids(changes: readonly PendingChange[]): string[] {
  const oids = new Set<string>();
  for (const change of changes) {
    if (!contentDiffers(change)) continue;
    if (change.before !== null && change.before.worktree === null) oids.add(change.before.oid);
    if (change.after !== null && change.after.worktree === null) oids.add(change.after.oid);
  }
  return [...oids];
}

export function contentDiffers(change: PendingChange): boolean {
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

  readWorktreeFileContents(worktree, root, files, contents);
  return contents;
}

export function readWorktreeFileContents(
  worktree: Worktree,
  root: string,
  files: string[],
  contents: Map<string, Uint8Array>,
): void {
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
}
