import { GitError, hasErrorCode } from "../common/errors.js";
import { joinPath, normalizePath, relativeTo } from "../common/paths.js";
import { matchesPaths, stageZero } from "../ops/checkout.js";
import { type GitContext, openRepository } from "../ops/context.js";
import { operationRefLogMetadata } from "../ops/ref-log.js";
import type { Repository } from "../ops/repository.js";
import { repositoryMutations } from "../ops/repository.js";
import { treeStream } from "../ops/tree-stream.js";
import { withGitMutationGuardOwned } from "../store/database.js";
import { boundedGitCliResult, gitCliResult } from "./result.js";
import type { GitCliResult, ResolvedGitCliRunOptions } from "./types.js";

export type MutationPhase = "native-operation" | "format-success" | "preflight";

export interface ResolvedAddPath {
  input: string;
  path: string;
}

export function runMutation<Outcome>(
  context: GitContext,
  repo: Repository,
  options: ResolvedGitCliRunOptions,
  operation: () => Outcome,
  formatSuccess: (outcome: Outcome) => GitCliResult,
  mapOperationFailure: (error: unknown) => GitCliResult | undefined,
): GitCliResult {
  let phase: MutationPhase = "native-operation";
  // Map native refusals only after the guard transaction has rolled every staged write back.
  try {
    return withGitMutationGuardOwned(context.database, () => {
      phase = "native-operation";
      const outcome = operation();
      phase = "format-success";
      const result = formatSuccess(outcome);
      phase = "preflight";
      return boundedGitCliResult(result, options);
    });
  } catch (error) {
    repo.store.revalidateStorageCaches();
    if (phase !== "native-operation") throw error;
    const mapped = mapOperationFailure(error);
    if (mapped === undefined) throw error;
    return boundedGitCliResult(mapped, options);
  }
}

export function withRepository(
  context: GitContext,
  cwd: string,
  options: ResolvedGitCliRunOptions,
  body: (repo: Repository) => GitCliResult,
): GitCliResult {
  let repo: Repository;
  try {
    repo = openRepository(context, cwd);
  } catch (error) {
    if (!hasErrorCode(error, "ENOTAREPO")) throw error;
    return boundedGitCliResult(
      gitCliResult(
        "",
        "fatal: not a git repository (or any of the parent directories): .git\n",
        128,
      ),
      options,
    );
  }
  return body(repo);
}

export function requireTransactionalWorktree(context: GitContext, repo: Repository): void {
  if (context.worktree.db !== repo.store.db) {
    throw new GitError(
      "EUNSUPPORTED",
      "git CLI worktree mutation requires the worktree and repository to share one database",
    );
  }
}

export function resolveMutationPaths(
  repo: Repository,
  cwd: string,
  inputs: readonly string[],
): ResolvedAddPath[] {
  const paths: ResolvedAddPath[] = [];
  for (const input of inputs) {
    const absolute = input.startsWith("/") ? normalizePath(input) : joinPath(cwd, input);
    const path = relativeTo(repo.root, absolute);
    if (path === null) {
      throw new GitError(
        "EPATHOUTSIDE",
        `${input}: '${input}' is outside repository at '${repo.root}'`,
      );
    }
    paths.push({ input, path });
  }
  return paths;
}

export function requireTreePaths(
  repo: Repository,
  ref: string,
  paths: readonly ResolvedAddPath[],
): string {
  const commit = repo.peel(repo.revParse(ref));
  const tree = repo.readCommit(commit).tree;
  requirePathsInSources(paths, treeStream(repo, tree), repo.checkout.indexScan());
  return tree;
}

export function requireIndexPaths(repo: Repository, paths: readonly ResolvedAddPath[]): void {
  requirePathsInSources(paths, stageZero(repo.checkout.indexScan()), []);
}

export function requireResetPaths(
  repo: Repository,
  ref: string | undefined,
  paths: readonly ResolvedAddPath[],
): void {
  const head =
    ref === undefined || ref === "HEAD" ? repo.head().oid : repo.peel(repo.revParse(ref));
  const tree = head === null ? null : repo.readCommit(repo.peel(head)).tree;
  requirePathsInSources(paths, treeStream(repo, tree), repo.checkout.indexScan());
}

function requirePathsInSources(
  paths: readonly ResolvedAddPath[],
  first: Iterable<{ path: string }>,
  second: Iterable<{ path: string }>,
): void {
  const matched = paths.map(() => false);
  const visit = (path: string): void => {
    for (let index = 0; index < paths.length; index++) {
      const requested = paths[index];
      if (requested !== undefined && matchesPaths(path, [requested.path])) matched[index] = true;
    }
  };
  for (const entry of first) visit(entry.path);
  for (const entry of second) visit(entry.path);
  for (let index = 0; index < paths.length; index++) {
    const requested = paths[index];
    if (requested !== undefined && matched[index] !== true) {
      throw new GitError("EPATHSPEC", `pathspec '${requested.path}' did not match any files`);
    }
  }
}

export function moveResetHead(context: GitContext, repo: Repository, ref: string): void {
  const commit = repo.peel(repo.revParse(ref));
  const head = repo.head();
  repositoryMutations(repo).mutateRefsOwned(
    head.ref === null ? { head: commit } : { puts: [{ name: head.ref, target: commit }] },
    operationRefLogMetadata(context, repo, "reset: hard"),
  );
}
