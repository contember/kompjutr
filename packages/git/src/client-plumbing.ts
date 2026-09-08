import { ownedBytes } from "@kompjutr/sqlite";
import type { GitClientServices } from "./client-services.js";
import type { Git, GitScratchIndex } from "./client-types.js";
import { GitError } from "./common/errors.js";
import { withPromisorHydration } from "./ops/network/network.js";
import { replaySnapshotOwned as replaySnapshotOp } from "./ops/replay/replay.js";
import {
  catFile as catFileOp,
  commitTreeOwned as commitTreeOp,
  hashObjectOwned as hashObjectOp,
  readTreeOwned as readTreeOp,
  updateRefOwned as updateRefOp,
  writeTreeOwned as writeTreeOp,
} from "./ops/repository/plumbing.js";
import { catFile as catFileRead } from "./ops/repository/reads.js";
import { add as addOp } from "./ops/staging/staging.js";
import { sharedRepoStoreMutations } from "./store/repository/shared.js";

type PlumbingMethods = Pick<
  Git,
  | "hashObject"
  | "catFile"
  | "readTree"
  | "writeTree"
  | "commitTree"
  | "withScratchIndex"
  | "updateRef"
>;

export function createGitClientPlumbingMethods(services: GitClientServices): PlumbingMethods {
  const { context, at, excludeRoots, mutate } = services;
  return {
    async hashObject(input) {
      return mutate(() => hashObjectOp(at(input.dir), input));
    },
    async catFile(input) {
      const repo = at(input.dir);
      const result = await withPromisorHydration(context, repo, () =>
        input.filepath === undefined
          ? catFileOp(repo, input)
          : catFileRead(repo, input.oid, input.filepath),
      );
      // Public bytes leave the store's ownership; a cached object must not alias them.
      return { oid: result.oid, bytes: ownedBytes(result.bytes) };
    },
    async readTree(input) {
      mutate(() => {
        const { dir, ...readOptions } = input;
        readTreeOp(at(dir), context.worktree, readOptions);
      });
    },
    async writeTree(input = {}) {
      return mutate(() => writeTreeOp(at(input.dir)));
    },
    async commitTree(input) {
      return mutate(() => {
        const { dir, ...commitOptions } = input;
        return commitTreeOp(context, at(dir), commitOptions);
      });
    },
    async withScratchIndex(input, body) {
      return mutate(() => {
        const repo = at(input.dir);
        return sharedRepoStoreMutations(repo.store).withScratchIndexOwned(input.name, (index) => {
          let active = true;
          const requireActive = (): void => {
            if (!active) throw new GitError("EINVAL", "scratch index session is no longer active");
          };
          const scratch: GitScratchIndex = {
            readTree(readOptions) {
              requireActive();
              readTreeOp(repo, context.worktree, readOptions, index);
            },
            add(addOptions) {
              requireActive();
              addOp(
                repo,
                context.worktree,
                { ...addOptions, excludeRoots: excludeRoots(repo) },
                context,
                index,
              );
            },
            writeTree() {
              requireActive();
              return writeTreeOp(repo, index);
            },
            commitTree(commitOptions) {
              requireActive();
              return commitTreeOp(context, repo, commitOptions);
            },
            replaySnapshot(replayOptions) {
              requireActive();
              return replaySnapshotOp(repo, index, replayOptions);
            },
          };
          try {
            return body(scratch);
          } finally {
            active = false;
          }
        });
      });
    },
    async updateRef(input) {
      mutate(() => {
        const repo = at(input.dir);
        repo.checkout.requireNoOperationState();
        updateRefOp(context, repo, input);
      });
    },
  };
}
