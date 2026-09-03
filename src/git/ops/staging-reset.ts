import { joinSorted } from "../common/streams.js";
import { applyIndexOwned, checkoutStoreMutations } from "../store/checkout.js";
import { checkoutTreeExcluding, indexFromTree, matchesPaths } from "./checkout.js";
import type { GitContext } from "./context.js";
import { operationRefLogMetadata } from "./ref-log.js";
import type { Repository } from "./repository.js";
import { repositoryMutations } from "./repository.js";
import type { Worktree } from "./worktree.js";

export interface ResetOptions {
  /** Unstage these paths back to `ref`, leaving the working tree alone. */
  paths?: string[];
  /** Move the current branch to `ref` and rewrite index and working tree. */
  hard?: boolean;
  /** Commit-ish to reset to. Defaults to HEAD. */
  ref?: string;
  excludeRoots?: readonly string[];
}

export function reset(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  options: ResetOptions = {},
): void {
  if (options.hard === true) {
    hardReset(context, repo, worktree, options);
    return;
  }

  const specs = normalizeSpecs(options.paths ?? []);
  const tree = targetTree(repo, options.ref);
  if (specs.length === 0) {
    // This one genuinely replaces the whole index, so the big hammer fits.
    checkoutStoreMutations(repo.checkout).indexReplaceOwned(indexFromTree(repo, tree));
    return;
  }

  // Tree and index are both path-ordered, so one merge decides each path.
  applyIndexOwned(repo.checkout, (sink) => {
    for (const row of joinSorted(indexFromTree(repo, tree), repo.checkout.indexScan(), {
      left: (entry) => entry.path,
      right: (entry) => entry.path,
    })) {
      if (!matchesPaths(row.path, specs)) continue;
      // A conflicted path repeats across stages; clearing it once is enough,
      // and indexPut only ever overwrites stage 0.
      if (row.right !== undefined && row.right.stage !== 0) sink.remove(row.path);
      if (row.left === undefined) {
        if (row.right !== undefined) sink.remove(row.path);
        continue;
      }
      sink.put(row.left);
    }
  });
}

function hardReset(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  options: ResetOptions,
): void {
  repo.store.db.transactionSync(() => {
    const commit = targetCommit(repo, options.ref);
    const tree = commit === null ? null : repo.readCommit(commit).tree;
    const head = repo.head();
    if (commit !== null) {
      const metadata = operationRefLogMetadata(context, repo, "reset: hard");
      const mutation =
        head.ref === null ? { head: commit } : { puts: [{ name: head.ref, target: commit }] };
      repositoryMutations(repo).mutateRefsOwned(mutation, metadata);
    }
    checkoutTreeExcluding(repo, worktree, tree, options.excludeRoots ?? [], {
      discardUnmerged: true,
      restoreStructure: true,
    });
  });
}

function targetCommit(repo: Repository, ref?: string): string | null {
  if (ref === undefined || ref === "HEAD") {
    const { oid } = repo.head();
    return oid === null ? null : repo.peel(oid);
  }
  return repo.peel(repo.revParse(ref));
}

function targetTree(repo: Repository, ref?: string): string | null {
  const commit = targetCommit(repo, ref);
  return commit === null ? null : repo.readCommit(commit).tree;
}

function normalizeSpecs(paths: string[]): string[] {
  const out: string[] = [];
  for (const raw of paths) {
    let spec = raw;
    while (spec.startsWith("./")) spec = spec.slice(2);
    spec = spec.replace(/\/+$/, "");
    if (spec === ".") spec = "";
    if (!out.includes(spec)) out.push(spec);
  }
  return out;
}
