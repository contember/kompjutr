import { createContextGitCliRunner } from "./cli/index.js";
import type { GitCliInput, GitCliRunOptions } from "./cli/types.js";
import { createGitClientCoreMethods } from "./client-core.js";
import { createGitClientNetworkMethods } from "./client-network.js";
import { createGitClientPlumbingMethods } from "./client-plumbing.js";
import { createGitClientRefMethods } from "./client-refs.js";
import { createGitClientReplayMethods } from "./client-replay.js";
import type { GitClientServices } from "./client-services.js";
import type { CreateGitOptions, Git, GitFactory, GitWorkspaceBinding } from "./client-types.js";
import { type GitContext, nestedRoots, openRepository } from "./ops/context.js";
import type { Repository } from "./ops/repository.js";
import { withGitMutationGuardOwned } from "./store/database.js";

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
  if (binding.exactRootStates !== undefined) context.exactRootStates = binding.exactRootStates;
  if (binding.http !== undefined) context.http = binding.http;
  if (binding.promisorAuth !== undefined) context.promisorAuth = binding.promisorAuth;
  if (binding.promisorHeaders !== undefined) context.promisorHeaders = binding.promisorHeaders;
  if (binding.cliNetwork !== undefined) context.cliNetwork = binding.cliNetwork;
  if (binding.initialWorktree !== undefined) context.initialWorktree = binding.initialWorktree;
  if (binding.indexTracker !== undefined) context.indexTracker = binding.indexTracker;
  if (binding.sparseWorkspace !== undefined) context.sparseWorkspace = binding.sparseWorkspace;
  if (binding.selectedPaths !== undefined) context.selectedPaths = binding.selectedPaths;
  if (binding.commitTrees !== undefined) context.commitTrees = binding.commitTrees;
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
