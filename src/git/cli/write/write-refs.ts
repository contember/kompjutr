import { GitError } from "../../common/errors.js";
import {
  checkoutIndexPathsExcluding,
  checkoutWorktreePathsExcluding,
} from "../../ops/checkout/checkout.js";
import { type GitContext, nestedRoots } from "../../ops/core/context.js";
import {
  branch,
  branchDelete,
  branchRename,
  checkoutExcluding,
  switchBranchExcluding,
} from "../../ops/refs/refs.js";
import { reset } from "../../ops/staging/staging.js";
import { checkoutStoreMutations } from "../../store/checkout/checkout.js";
import { gitCliResult } from "../result.js";
import type { GitCliHandlers } from "../types.js";
import { mapLocalMutationFailure, mapPathMutationFailure } from "./write-errors.js";
import { outputContext } from "./write-output.js";
import {
  moveResetHead,
  requireIndexPaths,
  requireResetPaths,
  requireTransactionalWorktree,
  requireTreePaths,
  resolveMutationPaths,
  runMutation,
  withRepository,
} from "./write-runtime.js";
import { abbreviate, subject } from "./write-summary.js";

const HEADS = "refs/heads/";

type RefHandlers = Pick<GitCliHandlers, "branch" | "reset" | "checkout" | "switch" | "restore">;

export function createGitCliRefWriteHandlers(context: GitContext): RefHandlers {
  return {
    async branch(invocation, options) {
      return withRepository(context, invocation.cwd, options, (repo) =>
        runMutation(
          context,
          repo,
          options,
          () => {
            repo.checkout.requireNoOperationState();
            const command = invocation.command;
            if (command.action === "create") {
              if (command.name === undefined)
                throw new Error("parsed branch creation lost its name");
              branch(context, repo, {
                name: command.name,
                ...(command.startPoint === undefined ? {} : { startPoint: command.startPoint }),
              });
              return "";
            }
            if (command.action === "delete") {
              if (command.name === undefined)
                throw new Error("parsed branch deletion lost its name");
              const oid = repo.peel(repo.revParse(command.name));
              branchDelete(context, repo, {
                name: command.name,
                ...(command.force ? { force: true } : {}),
              });
              return `Deleted branch ${command.name} (was ${abbreviate(repo, oid)}).\n`;
            }
            if (command.action === "rename") {
              if (command.newName === undefined)
                throw new Error("parsed branch rename lost its name");
              branchRename(context, repo, {
                newName: command.newName,
                ...(command.oldName === undefined ? {} : { oldName: command.oldName }),
              });
              return "";
            }
            throw new Error(`write handler received branch ${command.action}`);
          },
          (stdout) => gitCliResult(stdout, "", 0),
          (error) => mapLocalMutationFailure(error, outputContext(options)),
        ),
      );
    },
    async reset(invocation, options) {
      return withRepository(context, invocation.cwd, options, (repo) => {
        const command = invocation.command;
        const paths = resolveMutationPaths(repo, invocation.cwd, command.paths ?? []);
        return runMutation(
          context,
          repo,
          options,
          () => {
            const exclusions = nestedRoots(context, repo.root);
            if (command.mode === "hard") {
              requireTransactionalWorktree(context, repo);
              reset(context, repo, context.worktree, {
                hard: true,
                ...(command.ref === undefined ? {} : { ref: command.ref }),
                excludeRoots: exclusions,
              });
              checkoutStoreMutations(repo.checkout).clearOperationStateOwned();
            } else {
              repo.checkout.requireNoOperationState();
              if (paths.length > 0) requireResetPaths(repo, command.ref, paths);
              if (paths.length === 0 && command.ref !== undefined)
                moveResetHead(context, repo, command.ref);
              reset(context, repo, context.worktree, {
                ...(command.ref === undefined ? {} : { ref: command.ref }),
                ...(paths.length === 0 ? {} : { paths: paths.map((path) => path.path) }),
              });
            }
            return command.mode === "hard" ? repo.head().oid : null;
          },
          (oid) => {
            if (oid === null) return gitCliResult("", "", 0);
            const commit = repo.readCommit(oid);
            return gitCliResult(
              `HEAD is now at ${abbreviate(repo, oid)} ${subject(commit.message)}\n`,
              "",
              0,
            );
          },
          (error) => mapPathMutationFailure(error, paths, outputContext(options)),
        );
      });
    },
    async checkout(invocation, options) {
      return withRepository(context, invocation.cwd, options, (repo) => {
        requireTransactionalWorktree(context, repo);
        const command = invocation.command;
        const paths = resolveMutationPaths(repo, invocation.cwd, command.paths ?? []);
        return runMutation(
          context,
          repo,
          options,
          () => {
            repo.checkout.requireNoOperationState();
            const exclusions = nestedRoots(context, repo.root);
            if (command.action === "create") {
              if (command.name === undefined)
                throw new Error("parsed checkout creation lost its name");
              switchBranchExcluding(
                context,
                repo,
                context.worktree,
                {
                  name: command.name,
                  create: true,
                  ...(command.startPoint === undefined ? {} : { startPoint: command.startPoint }),
                },
                exclusions,
              );
              return `Switched to a new branch '${command.name}'\n`;
            }
            if (command.ref === undefined) throw new Error("parsed checkout lost its ref");
            if (paths.length > 0) requireTreePaths(repo, command.ref, paths);
            checkoutExcluding(
              context,
              repo,
              context.worktree,
              {
                ref: command.ref,
                ...(paths.length === 0 ? {} : { paths: paths.map((path) => path.path) }),
                ...(command.force ? { force: true } : {}),
              },
              exclusions,
            );
            if (paths.length > 0) return "";
            const head = repo.head();
            return head.ref === null
              ? `HEAD is now at ${head.oid === null ? "unknown" : abbreviate(repo, head.oid)}\n`
              : `Switched to branch '${head.ref.slice("refs/heads/".length)}'\n`;
          },
          (stderr) => gitCliResult("", stderr, 0),
          (error) => mapPathMutationFailure(error, paths, outputContext(options)),
        );
      });
    },
    async switch(invocation, options) {
      return withRepository(context, invocation.cwd, options, (repo) => {
        requireTransactionalWorktree(context, repo);
        return runMutation(
          context,
          repo,
          options,
          () => {
            repo.checkout.requireNoOperationState();
            if (
              invocation.command.action === "switch" &&
              repo.store.getRef(`${HEADS}${invocation.command.name}`) === null
            ) {
              throw new GitError("EBRANCHFAIL", `invalid reference: ${invocation.command.name}`);
            }
            switchBranchExcluding(
              context,
              repo,
              context.worktree,
              {
                name: invocation.command.name,
                ...(invocation.command.action === "create" ? { create: true } : {}),
              },
              nestedRoots(context, repo.root),
            );
            return invocation.command.action === "create"
              ? `Switched to a new branch '${invocation.command.name}'\n`
              : `Switched to branch '${invocation.command.name}'\n`;
          },
          (stderr) => gitCliResult("", stderr, 0),
          (error) => mapLocalMutationFailure(error, outputContext(options)),
        );
      });
    },
    async restore(invocation, options) {
      return withRepository(context, invocation.cwd, options, (repo) => {
        requireTransactionalWorktree(context, repo);
        const paths = resolveMutationPaths(repo, invocation.cwd, invocation.command.paths);
        return runMutation(
          context,
          repo,
          options,
          () => {
            repo.checkout.requireNoOperationState();
            const selected = paths.map((path) => path.path);
            const exclusions = nestedRoots(context, repo.root);
            if (invocation.command.source === undefined) {
              requireIndexPaths(repo, paths);
              checkoutIndexPathsExcluding(repo, context.worktree, selected, exclusions);
            } else {
              const tree = requireTreePaths(repo, invocation.command.source, paths);
              checkoutWorktreePathsExcluding(repo, context.worktree, tree, selected, exclusions);
            }
          },
          () => gitCliResult("", "", 0),
          (error) => mapPathMutationFailure(error, paths, outputContext(options)),
        );
      });
    },
  };
}
