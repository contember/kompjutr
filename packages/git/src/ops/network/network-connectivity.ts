import { CorruptError, GitError, hasErrorCode } from "../../common/errors.js";
import type { ObjectType } from "../../common/objects.js";
import { MAX_PROMISED_BLOB_LOOKUP_OIDS } from "../../store/fetch/promisor.js";
import { MAX_BLOB_BATCH_OIDS } from "../../store/objects/objects.js";
import { readCommitGraph } from "../../store/trees/commits.js";
import type { Repository } from "../repository/repository.js";
import { parseAuthenticatedTag, TAG_PEEL_HOPS } from "./network-tags.js";

const OBJECT_PAGE = 512;
const METADATA_PAGE = Math.min(MAX_BLOB_BATCH_OIDS, MAX_PROMISED_BLOB_LOOKUP_OIDS);
const TREE_CACHE = 128;
const TAG_BATCH_BYTES = 4 * 1024 * 1024;

interface RequiredObject {
  oid: string;
  type: ObjectType;
}

/** The caller holds the publication transaction until all validated refs are written. */
export function validateFetchedConnectivity(
  repo: Repository,
  roots: readonly string[],
  boundary: ReadonlySet<string>,
): void {
  const shallow = [...boundary];
  const checkedTrees = new Set<string>();
  let required: RequiredObject[] = [];
  const flush = (): void => {
    const promises = new Set(
      repo.store.promisedMissing(
        required.filter((entry) => entry.type === "blob").map((entry) => entry.oid),
      ),
    );
    const physical = required.filter((entry) => entry.type !== "blob" || !promises.has(entry.oid));
    const types = new Map(
      repo.store
        .objectInfo(physical.map((entry) => entry.oid))
        .map((entry) => [entry.oid, entry.type]),
    );
    for (const entry of physical) {
      if (types.get(entry.oid) !== entry.type) {
        throw new CorruptError(`fetched graph requires ${entry.oid} to be a ${entry.type}`);
      }
    }
    required = [];
  };
  const require = (entry: RequiredObject): void => {
    required.push(entry);
    if (required.length === METADATA_PAGE) flush();
  };
  const tree = (oid: string): void => {
    if (checkedTrees.has(oid)) return;
    for (const entry of repo.store.walkTreeDiffObjects(null, oid)) require(entry);
    if (checkedTrees.size === TREE_CACHE) {
      const oldest = checkedTrees.values().next();
      if (!oldest.done) checkedTrees.delete(oldest.value);
    }
    checkedTrees.add(oid);
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
        for (const entry of info) {
          if (entry.type === "tag") {
            tags.push(entry.oid);
            continue;
          }
          if (entry.type === "commit") {
            for (const commit of readCommitGraph(
              repo.store.db,
              repo.store.repoId,
              entry.oid,
              {},
              shallow,
            )) {
              require({ oid: commit.oid, type: "commit" });
              tree(commit.commit.tree);
            }
          } else if (entry.type === "tree") tree(entry.oid);
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
    if (required.length > 0) flush();
  } catch (error) {
    if (hasErrorCode(error, "ENOTFOUND")) {
      throw new GitError("EFETCHFAIL", "fetched graph references a missing object", {
        cause: error,
      });
    }
    throw error;
  }
}
