import { GitError, hasErrorCode } from "../common/errors.js";
import { normalizePath } from "../common/paths.js";
import { joinSorted } from "../common/streams.js";
import { normalizeRemoteUrl } from "../protocol/remote.js";
import { throwIfAborted } from "../protocol/stream.js";
import { sqliteGitDatabaseMutations, withGitMutationGuardOwned } from "../store/database.js";
import {
  type CheckoutStore,
  PROVISIONAL_CLONE_LEASE_MS,
  PROVISIONAL_CLONE_RENEW_WINDOW_MS,
} from "../store/index.js";
import { sharedRepoStoreMutations } from "../store/shared.js";
import { checkoutTree, matchesPaths, type TargetEntry } from "./checkout.js";
import type { GitContext } from "./context.js";
import { isInitialCheckoutFallback, tryInitialCheckout } from "./initial-checkout.js";
import { fetchInto } from "./network-fetch.js";
import { validateAbortableNetworkOptions, validateRemoteAuthOptions } from "./network-options.js";
import { hydrateTreeBlobs } from "./network-promisor.js";
import type { CloneOptions } from "./network-types.js";
import { operationRefLogMetadata } from "./ref-log.js";
import { Repository, repositoryMutations } from "./repository.js";
import { treeStream } from "./tree-stream.js";
import { walkWorktreeEntriesStream } from "./worktree-io.js";

function tryInitialClone(context: GitContext, repo: Repository, treeOid: string): boolean {
  return tryInitialCheckout(context, repo, treeOid, { requireSharedDatabase: true });
}

function* cloneTargetEntries(
  repo: Repository,
  treeOid: string,
  paths: string[] | undefined,
): Generator<TargetEntry> {
  for (const entry of treeStream(repo, treeOid)) {
    if (entry.mode !== "160000" && matchesPaths(entry.path, paths)) yield entry;
  }
}

function requireCloneTargetsAbsent(
  context: GitContext,
  repo: Repository,
  treeOid: string,
  paths: string[] | undefined,
): void {
  let existingLeafAncestor: string | null = null;
  for (const row of joinSorted(
    cloneTargetEntries(repo, treeOid, paths),
    walkWorktreeEntriesStream(context.worktree, repo.root, {
      includeDirectories: true,
      includeIgnored: true,
    }),
    { left: (entry) => entry.path, right: (entry) => entry.path },
  )) {
    if (
      existingLeafAncestor !== null &&
      row.path !== existingLeafAncestor &&
      !row.path.startsWith(`${existingLeafAncestor}/`)
    ) {
      existingLeafAncestor = null;
    }
    if (row.left !== undefined && (row.right !== undefined || existingLeafAncestor !== null)) {
      throw new GitError("EEXIST", `clone target path already exists: ${row.left.path}`);
    }
    if (row.right !== undefined && row.right.stat.type !== "dir") {
      existingLeafAncestor = row.right.path;
    }
  }
}

export async function clone(context: GitContext, options: CloneOptions): Promise<void> {
  validateRemoteAuthOptions(options);
  validateAbortableNetworkOptions(options);
  throwIfAborted(options.signal);
  const root = normalizePath(options.dir ?? "/");
  if (options.filter !== undefined && options.filter !== "blob:none") {
    throw new GitError("EUNSUPPORTED", "clone filter is not supported");
  }
  if (context.worktree.db !== context.database.db) {
    throw new GitError(
      "EUNSUPPORTED",
      "clone requires the working tree and Git store to share one database",
    );
  }
  const url = normalizeRemoteUrl(options.url);
  const remote = options.remote ?? "origin";
  const cleanup = (store: CheckoutStore): undefined => {
    checkoutTree(new Repository(store), context.worktree, null);
    return undefined;
  };
  const cloneStartedAt = context.now();
  const owner = withGitMutationGuardOwned(context.database, () =>
    sqliteGitDatabaseMutations(context.database).beginProvisionalCloneOwned(
      root,
      "ref: refs/heads/main",
      cloneStartedAt,
      cleanup,
    ),
  );
  const repo = new Repository(owner.store);
  let leaseExpiresAt = cloneStartedAt + PROVISIONAL_CLONE_LEASE_MS;
  const heartbeatOwned = (): void => {
    const now = context.now();
    if (leaseExpiresAt - now > PROVISIONAL_CLONE_RENEW_WINDOW_MS) return;
    leaseExpiresAt = sqliteGitDatabaseMutations(context.database).renewProvisionalCloneOwned(
      owner,
      now,
    );
  };
  const heartbeat = (): void => {
    withGitMutationGuardOwned(context.database, heartbeatOwned);
  };
  const checkpoint = (): Promise<void> | undefined => {
    throwIfAborted(options.signal);
    heartbeat();
    const yieldNow = context.yieldNow;
    if (yieldNow === undefined) return;
    return (async () => {
      await yieldNow();
      throwIfAborted(options.signal);
      heartbeat();
    })();
  };
  try {
    withGitMutationGuardOwned(context.database, () => {
      heartbeatOwned();
      sharedRepoStoreMutations(repo.store).configSetOwned(`remote.${remote}.url`, url);
      sharedRepoStoreMutations(repo.store).configSetOwned(
        `remote.${remote}.fetch`,
        `+refs/heads/*:refs/remotes/${remote}/*`,
      );
      heartbeatOwned();
    });

    const depth =
      options.depth !== undefined && options.depth > 0 && Number.isFinite(options.depth)
        ? options.depth
        : undefined;
    const singleBranch = options.singleBranch ?? depth !== undefined;
    const result = await fetchInto(
      context,
      repo,
      {
        remote,
        url,
        singleBranch,
        ...(options.noTags === true ? { tags: false } : singleBranch ? {} : { tags: true }),
        ...(options.ref === undefined ? {} : { ref: options.ref }),
        ...(depth === undefined ? {} : { depth }),
        ...(options.filter === undefined ? {} : { filter: options.filter }),
        ...(options.headers === undefined ? {} : { headers: options.headers }),
        ...(options.onAuth === undefined ? {} : { onAuth: options.onAuth }),
        ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
        ...(options.onMessage === undefined ? {} : { onMessage: options.onMessage }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      "clone: fetch",
      { checkpoint },
    );

    const branch = branchNameFor(options.ref, result.defaultBranch);
    const tip = result.fetchHead;
    if (tip === null) throw new GitError("EFETCHFAIL", "remote advertised no usable ref");

    withGitMutationGuardOwned(context.database, () => {
      throwIfAborted(options.signal);
      heartbeatOwned();
      repo.store.db.transactionSync(() => {
        repositoryMutations(repo).mutateRefsOwned(
          {
            puts: [{ name: `refs/heads/${branch}`, target: tip }],
            head: `ref: refs/heads/${branch}`,
          },
          operationRefLogMetadata(context, repo, "clone: checkout"),
        );
        sharedRepoStoreMutations(repo.store).configSetOwned(`branch.${branch}.remote`, remote);
        sharedRepoStoreMutations(repo.store).configSetOwned(
          `branch.${branch}.merge`,
          `refs/heads/${branch}`,
        );
      });
    });
    const afterLocalRefs = checkpoint();
    if (afterLocalRefs !== undefined) await afterLocalRefs;

    const tree = repo.readCommit(repo.peel(tip)).tree;
    if (options.filter !== undefined) {
      await hydrateTreeBlobs(context, repo, tree, options.paths, options);
    }
    const beforeMaterialization = checkpoint();
    if (beforeMaterialization !== undefined) await beforeMaterialization;
    const fallback = (): undefined => {
      requireCloneTargetsAbsent(context, repo, tree, options.paths);
      checkoutTree(repo, context.worktree, tree, {
        ...(options.paths === undefined ? {} : { paths: options.paths }),
      });
      return undefined;
    };
    try {
      throwIfAborted(options.signal);
      withGitMutationGuardOwned(context.database, () =>
        sqliteGitDatabaseMutations(context.database).publishProvisionalCloneOwned(
          owner,
          context.now(),
          () => {
            const initial = options.paths === undefined && tryInitialClone(context, repo, tree);
            if (!initial) return fallback();
            return undefined;
          },
        ),
      );
    } catch (error) {
      if (!isInitialCheckoutFallback(error)) throw error;
      throwIfAborted(options.signal);
      withGitMutationGuardOwned(context.database, () =>
        sqliteGitDatabaseMutations(context.database).publishProvisionalCloneOwned(
          owner,
          context.now(),
          fallback,
        ),
      );
    }
  } catch (error) {
    try {
      withGitMutationGuardOwned(context.database, () =>
        sqliteGitDatabaseMutations(context.database).discardProvisionalCloneOwned(
          owner,
          context.now(),
          cleanup,
        ),
      );
    } catch (discardError) {
      if (!hasErrorCode(discardError, "ESTALE")) throw discardError;
    }
    throw error;
  }
}

function branchNameFor(requested: string | undefined, defaultBranch: string | null): string {
  const source = requested ?? defaultBranch ?? "refs/heads/main";
  return source.startsWith("refs/heads/") ? source.slice("refs/heads/".length) : source;
}
