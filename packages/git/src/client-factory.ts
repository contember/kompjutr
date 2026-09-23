import { createContextGitCliRunner } from "./cli/index.js";
import type { GitCliInput, GitCliRunOptions } from "./cli/types.js";
import { createGitClientCoreMethods } from "./client-core.js";
import { createGitClientNetworkMethods } from "./client-network.js";
import { createGitClientPlumbingMethods } from "./client-plumbing.js";
import { createGitClientRefMethods } from "./client-refs.js";
import { createGitClientReplayMethods } from "./client-replay.js";
import type { GitClientServices } from "./client-services.js";
import type { CreateGitOptions, Git, GitFactory, GitWorkspaceBinding } from "./client-types.js";
import { GitError } from "./common/errors.js";
import { type GitContext, nestedRoots, openRepository } from "./ops/core/context.js";
import type { Repository } from "./ops/repository/repository.js";
import { withGitMutationGuardOwned } from "./store/database/database.js";

/** Create a Git factory that binds lazily to one Workspace database. */
export function createGit(options: CreateGitOptions = {}): GitFactory {
  return (binding) => createGitClient(binding, options);
}

function createGitClient(binding: GitWorkspaceBinding, options: CreateGitOptions): Git {
  const context: GitContext = {
    database: binding.database,
    worktree: binding.worktree,
    now: options.now ?? binding.now,
    timezoneOffset: options.timezoneOffset ?? binding.timezoneOffset,
  };
  if (binding.defaultIdentity !== undefined) context.defaultIdentity = binding.defaultIdentity;
  if (binding.http !== undefined) context.http = binding.http;
  if (binding.promisorAuth !== undefined) context.promisorAuth = binding.promisorAuth;
  if (binding.promisorHeaders !== undefined) context.promisorHeaders = binding.promisorHeaders;
  if (binding.cliNetwork !== undefined) context.cliNetwork = binding.cliNetwork;
  if (binding.initialWorktree !== undefined) context.initialWorktree = binding.initialWorktree;
  const sparse = binding.sparse;
  if (sparse !== undefined) {
    // Sparse sources are trusted like stored rows, so they must read this store.
    if (sparse.database !== binding.database.db) {
      throw new GitError("EINVAL", "sparse capability reads a different database");
    }
    context.indexTracker = sparse.tracker;
    context.sparseWorkspace = sparse.workspace;
    context.selectedPaths = sparse.selected;
    context.commitTrees = sparse.commitTrees;
  }
  const yieldNow = options.yieldNow ?? binding.yieldNow;
  if (yieldNow !== undefined) context.yieldNow = yieldNow;
  const cliRunner = createContextGitCliRunner(context);

  const at = (dir?: string): Repository => openRepository(context, dir ?? "/");
  const excludeRoots = (repo: Repository): string[] => nestedRoots(context, repo.root);
  const mutate = <T>(body: () => T): T => withGitMutationGuardOwned(binding.database, body);
  const services: GitClientServices = { context, at, excludeRoots, mutate };

  return {
    ...createGitClientCoreMethods(services),
    ...createGitClientRefMethods(services),
    ...createGitClientPlumbingMethods(services),
    ...createGitClientNetworkMethods(services),
    ...createGitClientReplayMethods(services),
    async runCli(input: GitCliInput, runOptions?: GitCliRunOptions) {
      return cliRunner.runCli(input, runOptions);
    },
    async cli(input) {
      return cliRunner.runCli(input);
    },
  };
}
