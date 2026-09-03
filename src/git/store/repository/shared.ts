// The repository registry and the per-repository store: objects, refs,
// config and the index, all as rows.

import type { SqlDatabase } from "../../../db/db.js";
import { CorruptError, GitError } from "../../common/errors.js";
import type { ByteLru } from "../../common/lru.js";
import type { RawObject } from "../../common/objects.js";
import type {
  IndexStore,
  ObjectBatch,
  ObjectBatchOptions,
  OwnedObjectBatch,
  StoreOptions,
} from "../core/contracts.js";
import { isThenableResult, requireBooleanProbe } from "../core/json-pages.js";
import { withGitMutationGuard } from "../core/mutation-guard.js";
import { requireScratchIndexName } from "../database/lifecycle.js";
import { ScratchIndexStore } from "../indexes/index-table.js";
import type { Clock } from "../refs/reflog.js";
import { MAX_SCRATCH_INDEXES_PER_REPOSITORY } from "../schema/schema.js";
import { SharedRepoRefStore } from "./shared-refs.js";
import {
  getSharedRepoStoreMutations,
  registerSharedRepoStoreMutations,
  type SharedRepoStoreMutations,
} from "./shared-support.js";

/** Canonical resources shared by every checkout view of one Git store. */
export class SharedRepoStore extends SharedRepoRefStore {
  constructor(
    db: SqlDatabase,
    repoId: number,
    storeGeneration: number,
    objects: ByteLru<string, RawObject>,
    packRows: ByteLru<string, Uint8Array>,
    clock: Clock,
    options: StoreOptions,
  ) {
    super(db, repoId, storeGeneration, objects, packRows, clock, options);
    registerSharedRepoStoreMutations(this, {
      upsertBlobIdsOwned: (mappings) => this.upsertBlobIdsOwned(mappings),
      registerPromisorRemoteOwned: (remoteName, url) =>
        this.registerPromisorRemoteOwned(remoteName, url),
      addPromisedBlobsOwned: (remoteName, oids) => this.addPromisedBlobsOwned(remoteName, oids),
      addPromisedBlobsFromPackTreesOwned: (remoteName, packId) =>
        this.addPromisedBlobsFromPackTreesOwned(remoteName, packId),
      writeOwned: (type, data) => this.writeOwned(type, data),
      writeStreamOwned: (type, size, chunks) => this.writeStreamOwned(type, size, chunks),
      writeBatchOwned: (batchOptions) => this.writeBatchOwned(batchOptions),
      objectTableOwned: () => this.objectTableOwned(),
      withScratchIndexOwned: (name, body) => this.withScratchIndexOwned(name, body),
      setRefOwned: (name, target) => this.setRefOwned(name, target),
      updateRefExpectedOwned: (name, expectedOid, targetOid) =>
        this.updateRefExpectedOwned(name, expectedOid, targetOid),
      deleteRefOwned: (name) => this.deleteRefOwned(name),
      updateRefsOwned: (puts, deletes) => this.updateRefsOwned(puts, deletes),
      mutateSharedRefsOwned: (mutation, metadata) => this.mutateSharedRefsOwned(mutation, metadata),
      mutateRefsOwned: (headOwner, mutation, metadata) =>
        this.mutateRefsOwned(headOwner, mutation, metadata),
      publishTrackingRefOwned: (token, target, metadata) =>
        this.publishTrackingRefOwned(token, target, metadata),
      publishFetchRefsOwned: (token, plan, metadata) =>
        this.publishFetchRefsOwned(token, plan, metadata),
      configSetOwned: (path, value) => this.configSetOwned(path, value),
      configAddOwned: (path, value) => this.configAddOwned(path, value),
      configUnsetOwned: (path) => this.configUnsetOwned(path),
      configMoveSectionOwned: (sourcePrefix, destinationPrefix) =>
        this.configMoveSectionOwned(sourcePrefix, destinationPrefix),
      cacheCommitOwned: (oid, data) => this.cacheCommitOwned(oid, data),
      cacheCommitsOwned: (entries) => this.cacheCommitsOwned(entries),
      setShallowOwned: (add, remove) => this.setShallowOwned(add, remove),
      destroyOwned: () => this.destroyOwned(),
    });
  }

  /** Run one named scratch index as an isolated public Git mutation. */
  withScratchIndex<T>(name: string, body: (index: IndexStore) => T): T {
    return withGitMutationGuard(this.db, () => this.withScratchIndexOwned(name, body));
  }

  /** Run one named scratch index while the caller owns the mutation guard. */
  protected withScratchIndexOwned<T>(name: string, body: (index: IndexStore) => T): T {
    const checkedName = requireScratchIndexName(name);
    const scratchTransactions = this.scratchTransactionCoordinator();
    const outermost = scratchTransactions.enter();
    let opened = false;
    try {
      const result = this.db.transactionSync(() => {
        scratchTransactions.requireHealthy();
        const existing = requireBooleanProbe(
          this.db.scalar<unknown>(
            `SELECT EXISTS(
               SELECT 1 FROM git_scratch_indexes WHERE repo_id = ? AND name = ? LIMIT 1
             )`,
            this.repoId,
            checkedName,
          ),
          "scratch index existence probe",
        );
        if (existing) {
          throw new GitError("EEXIST", `scratch index ${checkedName} is already active`);
        }
        const storedCount = this.db.scalar<unknown>(
          `SELECT count(*) FROM (
             SELECT 1 FROM git_scratch_indexes WHERE repo_id = ?
             LIMIT ${MAX_SCRATCH_INDEXES_PER_REPOSITORY + 1}
           )`,
          this.repoId,
        );
        if (
          typeof storedCount !== "number" ||
          !Number.isSafeInteger(storedCount) ||
          storedCount < 0 ||
          storedCount > MAX_SCRATCH_INDEXES_PER_REPOSITORY
        ) {
          throw new CorruptError("scratch index count is invalid");
        }
        if (storedCount >= MAX_SCRATCH_INDEXES_PER_REPOSITORY) {
          throw new GitError(
            "E2BIG",
            `repository already has ${MAX_SCRATCH_INDEXES_PER_REPOSITORY} active scratch indexes`,
          );
        }
        this.db.run(
          "INSERT INTO git_scratch_indexes (repo_id, name) VALUES (?, ?)",
          this.repoId,
          checkedName,
        );
        opened = true;
        const scratch = new ScratchIndexStore(this, checkedName);
        try {
          const result = body(scratch);
          if (isThenableResult(result)) {
            void Promise.resolve(result).catch(() => {});
            throw new GitError("EINVAL", "scratch index callback must be synchronous");
          }
          scratchTransactions.requireHealthy();
          const deleted = this.db.one<Record<string, unknown>>(
            `DELETE FROM git_scratch_indexes WHERE repo_id = ? AND name = ?
             RETURNING repo_id, name`,
            this.repoId,
            checkedName,
          );
          if (deleted?.repo_id !== this.repoId || deleted.name !== checkedName) {
            throw new CorruptError("scratch index ownership changed before cleanup");
          }
          return result;
        } finally {
          scratch.revoke();
        }
      });
      scratchTransactions.leave();
      if (outermost) scratchTransactions.finish();
      return result;
    } catch (error) {
      if (opened) scratchTransactions.fail(error);
      scratchTransactions.leave();
      if (!outermost) throw error;
      const outcome = scratchTransactions.finish();
      for (const store of outcome.storageWrites) store.revalidateStorageCaches();
      if (outcome.failed) throw outcome.failure;
      throw error;
    }
  }
}

/** Internal mutation capability; intentionally absent from the package facade. */
export function sharedRepoStoreMutations(store: SharedRepoStore): SharedRepoStoreMutations {
  return getSharedRepoStoreMutations(store);
}

/** Internal object-batch capability for composition under an existing mutation guard. */
export function writeBatchOwned(
  store: SharedRepoStore,
  options: ObjectBatchOptions = {},
): OwnedObjectBatch {
  return sharedRepoStoreMutations(store).writeBatchOwned(options);
}

/** Internal scoped object writer for composition under an existing mutation guard. */
export function writeObjectsOwned<T>(
  store: SharedRepoStore,
  body: (batch: ObjectBatch) => T,
  options: ObjectBatchOptions = {},
): T {
  const batch = writeBatchOwned(store, options);
  try {
    const result = body(batch);
    if (isThenableResult(result)) {
      void Promise.resolve(result).catch(() => {});
      throw new GitError("EINVAL", "object batch callback must be synchronous");
    }
    batch.flush();
    return result;
  } finally {
    batch.dispose();
  }
}
