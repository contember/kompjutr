import { CorruptError, GitError, hasErrorCode, ObjectNotFoundError } from "../../common/errors.js";
import type { ObjectType } from "../../common/objects.js";
import type { Repository } from "../repository/repository.js";
import { connectedObjects, type FetchConnectivity } from "./network-reachability.js";
import { parseAuthenticatedTag, TAG_PEEL_HOPS } from "./network-tags.js";

const OBJECT_PAGE = 512;
const TAG_BATCH_BYTES = 4 * 1024 * 1024;

/**
 * Validate the fetched roots before refs publish (ADR-0029). Every pack of the
 * fetch resolved its references at ingest, so each root and tag-peel hop must
 * be in one of those packs or already reachable from the refs the fetch began
 * with. The caller holds the publication transaction until the refs are written.
 */
export function validateFetchedConnectivity(
  repo: Repository,
  roots: readonly string[],
  connectivity: FetchConnectivity,
): void {
  try {
    for (let start = 0; start < roots.length; start += OBJECT_PAGE) {
      let frontier: { oid: string; type?: ObjectType }[] = roots
        .slice(start, start + OBJECT_PAGE)
        .map((oid) => ({ oid }));
      for (let hop = 0; frontier.length > 0; hop++) {
        if (hop >= TAG_PEEL_HOPS)
          throw new CorruptError(`fetched tag exceeds ${TAG_PEEL_HOPS} peel hops`);
        const oids = frontier.map((entry) => entry.oid);
        const connected = connectedObjects(repo, connectivity, oids);
        for (const oid of oids) {
          if (!connected.has(oid)) throw new ObjectNotFoundError(oid);
        }
        const info = repo.store.objectInfo(oids);
        const types = new Map(info.map((entry) => [entry.oid, entry.type]));
        const sizes = new Map(info.map((entry) => [entry.oid, entry.size]));
        for (const entry of frontier) {
          if (entry.type !== undefined && types.get(entry.oid) !== entry.type) {
            throw new CorruptError(`fetched tag target ${entry.oid} has a mismatched type`);
          }
        }
        frontier = [];
        let pending = info.filter((entry) => entry.type === "tag").map((entry) => entry.oid);
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
