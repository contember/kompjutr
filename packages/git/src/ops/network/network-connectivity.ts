import { CorruptError, GitError, hasErrorCode, ObjectNotFoundError } from "../../common/errors.js";
import type { ObjectType } from "../../common/objects.js";
import { MAX_BLOB_BATCH_OIDS } from "../../store/objects/objects.js";
import { readCommitTreeRoots } from "../../store/trees/commits.js";
import { readConnectivityFailures } from "../../store/trees/connectivity.js";
import type { Repository } from "../repository/repository.js";
import { parseAuthenticatedTag, TAG_PEEL_HOPS } from "./network-tags.js";

const OBJECT_PAGE = 512;
const TAG_BATCH_BYTES = 4 * 1024 * 1024;

/** The caller holds the publication transaction until all validated refs are written. */
export function validateFetchedConnectivity(
  repo: Repository,
  roots: readonly string[],
  boundary: ReadonlySet<string>,
): void {
  const shallow = [...boundary];
  let commits: string[] = [];
  const flushCommits = (): void => {
    for (const entry of repo.store.objectInfo(commits)) {
      if (entry.type !== "commit") {
        throw new CorruptError(`fetched graph requires ${entry.oid} to be a commit`);
      }
    }
    commits = [];
  };
  try {
    for (let start = 0; start < roots.length; start += OBJECT_PAGE) {
      let frontier: { oid: string; type?: ObjectType }[] = roots
        .slice(start, start + OBJECT_PAGE)
        .map((oid) => ({ oid }));
      for (let hop = 0; frontier.length > 0; hop++) {
        if (hop >= TAG_PEEL_HOPS)
          throw new CorruptError(`fetched tag exceeds ${TAG_PEEL_HOPS} peel hops`);
        const info = repo.store.objectInfo(frontier.map((entry) => entry.oid));
        const types = new Map(info.map((entry) => [entry.oid, entry.type]));
        const sizes = new Map(info.map((entry) => [entry.oid, entry.size]));
        for (const entry of frontier) {
          if (entry.type !== undefined && types.get(entry.oid) !== entry.type) {
            throw new CorruptError(`fetched tag target ${entry.oid} has a mismatched type`);
          }
        }
        const tags: string[] = [];
        const treeRoots: { oid: string; type: "commit" | "tree" }[] = [];
        for (const entry of info) {
          if (entry.type === "tag") {
            tags.push(entry.oid);
            continue;
          }
          if (entry.type === "commit") {
            for (const commit of readCommitTreeRoots(
              repo.store.db,
              repo.store.repoId,
              entry.oid,
              shallow,
            )) {
              commits.push(commit.oid);
              if (commits.length === MAX_BLOB_BATCH_OIDS) flushCommits();
            }
          }
          if (entry.type === "commit" || entry.type === "tree") {
            treeRoots.push({ oid: entry.oid, type: entry.type });
          }
        }
        const [failure] = readConnectivityFailures(
          repo.store.db,
          repo.store.repoId,
          treeRoots,
          shallow,
          1,
        );
        // Failures rank globally and deterministically: sourceless tree, commits, missing,
        // wrong type. The former code ranked per 4,096-entry flush; both reject the same graphs.
        if (failure?.kind === "source") {
          throw new CorruptError(`tree ${failure.oid} has no complete parsed source`);
        }
        if (commits.length > 0) flushCommits();
        if (failure?.kind === "missing") throw new ObjectNotFoundError(failure.oid);
        if (failure?.kind === "type") {
          throw new CorruptError(
            `fetched graph requires ${failure.oid} to be a ${failure.expected}`,
          );
        }
        frontier = [];
        let pending = tags;
        while (pending.length > 0) {
          const first = pending[0];
          const size = first === undefined ? undefined : sizes.get(first);
          if (size === undefined) throw new CorruptError("tag metadata is incomplete");
          const batch = repo.readObjects(pending, { budgetBytes: Math.max(TAG_BATCH_BYTES, size) });
          if (batch.objects.size === 0) throw new CorruptError("tag connectivity made no progress");
          for (const [oid, object] of batch.objects) {
            const tag = parseAuthenticatedTag(oid, object.data);
            frontier.push({ oid: tag.object, type: tag.type });
          }
          pending = batch.remaining;
        }
      }
    }
  } catch (error) {
    if (hasErrorCode(error, "ENOTFOUND")) {
      throw new GitError("EFETCHFAIL", "fetched graph references a missing object", {
        cause: error,
      });
    }
    throw error;
  }
}
