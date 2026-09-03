import { CorruptError, hasErrorCode } from "../../common/errors.js";
import { comparePaths } from "../../common/streams.js";
import { checkoutStoreMutations } from "../../store/checkout/checkout.js";
import type { OperationJournal } from "../core/operation-state.js";
import type { Repository } from "../repository/repository.js";
import type { Worktree } from "../worktree/worktree.js";
import { collectBlobMetadata, restoreWorktree } from "./merge-apply-blobs.js";
import { abortDestructiveRoots, restoreIndex } from "./merge-apply-index.js";
import { worktreeSnapshotScan } from "./merge-apply-snapshot.js";
import type { BlobMetadata, TouchedSpec } from "./merge-apply-types.js";
import type { MergeJournal, MergeTouchedPath } from "./merge-state.js";

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
  checkoutStoreMutations(repo.checkout).clearMergeStateOwned();
}

/** Restore one authenticated operation snapshot; the caller owns state clearing. */
export function restoreProjectedOperation(
  repo: Repository,
  worktree: Worktree,
  journal: OperationJournal,
): void {
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
