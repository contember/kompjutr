import { GitError } from "../common/errors.js";
import { commit as commitOp } from "../ops/commit.js";
import { type GitContext, nestedRoots } from "../ops/context.js";
import { mergeContinue } from "../ops/merge.js";
import { type AddLiteralPathsResult, addLiteralPaths, add as addOp } from "../ops/staging.js";
import { gitCliResult } from "./result.js";
import type { GitCliHandlers } from "./types.js";
import {
  environmentRecord,
  formatAddResult,
  mapAddFailure,
  mapCommitFailure,
} from "./write-errors.js";
import { outputContext, retainedStdoutCeiling } from "./write-output.js";
import {
  type ResolvedAddPath,
  resolveMutationPaths,
  runMutation,
  withRepository,
} from "./write-runtime.js";
import { formatCommitSummary } from "./write-summary.js";

type AddCommitHandlers = Pick<GitCliHandlers, "add" | "commit">;

export function createGitCliAddCommitHandlers(context: GitContext): AddCommitHandlers {
  return {
    async add(invocation, options) {
      const output = outputContext(options);
      return withRepository(context, invocation.cwd, options, (repo) => {
        let paths: ResolvedAddPath[] = [];
        return runMutation(
          context,
          repo,
          options,
          () => {
            if (invocation.command.all || invocation.command.update) {
              addOp(
                repo,
                context.worktree,
                {
                  paths: [],
                  all: true,
                  ...(invocation.command.update ? { trackedOnly: true } : {}),
                  ...(invocation.command.force ? { force: true } : {}),
                  excludeRoots: nestedRoots(context, repo.root),
                },
                context,
              );
              const result: AddLiteralPathsResult = { outcome: "staged" };
              return result;
            }
            paths = resolveMutationPaths(repo, invocation.cwd, invocation.command.paths);
            return addLiteralPaths(
              repo,
              context.worktree,
              {
                paths: paths.map((path) => path.path),
                ...(invocation.command.force ? { force: true } : {}),
                excludeRoots: nestedRoots(context, repo.root),
              },
              context,
            );
          },
          (outcome) => formatAddResult(outcome, options),
          (error) => mapAddFailure(error, paths, output),
        );
      });
    },
    async commit(invocation, options) {
      return withRepository(context, invocation.cwd, options, (repo) =>
        runMutation(
          context,
          repo,
          options,
          () => {
            const operation = repo.checkout.readOperationState();
            if (operation?.kind === "merge") {
              if (invocation.command.amend === true) {
                throw new GitError("EINVAL", "cannot amend while continuing a merge");
              }
              const previousHead = repo.head();
              const result = mergeContinue(context, repo, {
                message: invocation.command.message,
                env: environmentRecord(invocation.env),
              });
              if (result.oid === undefined) {
                throw new GitError("ECORRUPT", "merge continuation did not create a commit");
              }
              return { oid: result.oid, previousHead, amended: false };
            }
            const hasConflicts = repo.checkout.hasConflicts();
            if (!hasConflicts) repo.checkout.requireNoOperationState();
            if (invocation.command.all && !hasConflicts) {
              addOp(
                repo,
                context.worktree,
                {
                  paths: [],
                  all: true,
                  trackedOnly: true,
                  excludeRoots: nestedRoots(context, repo.root),
                },
                context,
              );
            }
            const previousHead = repo.head();
            const result = commitOp(context, repo, {
              message: invocation.command.message,
              env: environmentRecord(invocation.env),
              ...(invocation.command.amend ? { amend: true } : {}),
              ...(invocation.command.allowEmpty ? { allowEmpty: true } : {}),
            });
            return { oid: result.oid, previousHead, amended: invocation.command.amend === true };
          },
          (mutation) =>
            gitCliResult(
              formatCommitSummary(
                repo,
                context.worktree,
                mutation,
                retainedStdoutCeiling(options, 0),
              ),
              "",
              0,
            ),
          (error) => mapCommitFailure(context, repo, error, options),
        ),
      );
    },
  };
}
