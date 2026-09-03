import { GitError } from "../../common/errors.js";
import { type GitContext, nestedRoots } from "../../ops/core/context.js";
import { mergeAbort, mergeContinue } from "../../ops/merge/merge.js";
import {
  rebaseAbortExcluding,
  rebaseContinueExcluding,
  rebaseExcluding,
  rebaseSkipExcluding,
} from "../../ops/rebase/rebase.js";
import { gitCliResult } from "../result.js";
import type { GitCliHandlers } from "../types.js";
import {
  environmentRecord,
  mapLocalMutationFailure,
  mapMergeFailure,
  mapRebaseContinueFailure,
  mapRebaseFailure,
} from "./write-errors.js";
import { outputContext, retainedStdoutCeiling } from "./write-output.js";
import { formatRebaseContinue, formatRebaseResult } from "./write-rebase-format.js";
import { requireTransactionalWorktree, runMutation, withRepository } from "./write-runtime.js";
import { formatCommitSummary } from "./write-summary.js";

type ReplayHandlers = Pick<GitCliHandlers, "rebase" | "merge">;

export function createGitCliReplayWriteHandlers(context: GitContext): ReplayHandlers {
  return {
    async rebase(invocation, options) {
      return withRepository(context, invocation.cwd, options, (repo) => {
        requireTransactionalWorktree(context, repo);
        if (invocation.command.action === "abort") {
          return runMutation(
            context,
            repo,
            options,
            () => rebaseAbortExcluding(repo, context.worktree, nestedRoots(context, repo.root)),
            () => gitCliResult("", "", 0),
            mapRebaseFailure,
          );
        }
        if (invocation.command.action === "start") {
          return runMutation(
            context,
            repo,
            options,
            () => {
              const upstream = invocation.command.upstream;
              if (upstream === undefined) throw new Error("parsed rebase start lost its upstream");
              return rebaseExcluding(
                context,
                repo,
                context.worktree,
                nestedRoots(context, repo.root),
                { upstream, env: environmentRecord(invocation.env) },
              );
            },
            (result) => formatRebaseResult(repo, result),
            (error) => mapLocalMutationFailure(error, outputContext(options)),
          );
        }
        if (invocation.command.action === "skip") {
          return runMutation(
            context,
            repo,
            options,
            () =>
              rebaseSkipExcluding(
                context,
                repo,
                context.worktree,
                nestedRoots(context, repo.root),
                { env: environmentRecord(invocation.env) },
              ),
            (result) => formatRebaseResult(repo, result),
            (error) => mapRebaseContinueFailure(repo, error, options),
          );
        }
        return runMutation(
          context,
          repo,
          options,
          () => {
            const before = repo.checkout.requireOperationState("rebase");
            const result = rebaseContinueExcluding(
              context,
              repo,
              context.worktree,
              nestedRoots(context, repo.root),
              { env: environmentRecord(invocation.env) },
            );
            return { before, result };
          },
          (mutation) => formatRebaseContinue(repo, context.worktree, mutation, options),
          (error) => mapRebaseContinueFailure(repo, error, options),
        );
      });
    },
    async merge(invocation, options) {
      return withRepository(context, invocation.cwd, options, (repo) => {
        requireTransactionalWorktree(context, repo);
        if (invocation.command.action === "abort") {
          return runMutation(
            context,
            repo,
            options,
            () => mergeAbort(repo, context.worktree),
            () => gitCliResult("", "", 0),
            (error) => mapMergeFailure(error, outputContext(options)),
          );
        }
        return runMutation(
          context,
          repo,
          options,
          () => {
            const previousHead = repo.head();
            const result = mergeContinue(context, repo, { env: environmentRecord(invocation.env) });
            if (result.oid === undefined) {
              throw new GitError("ECORRUPT", "merge continuation did not create a commit");
            }
            return { oid: result.oid, previousHead, amended: false };
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
          (error) => mapMergeFailure(error, outputContext(options)),
        );
      });
    },
  };
}
