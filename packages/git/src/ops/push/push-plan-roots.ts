import { CorruptError, PromisedObjectError } from "../../common/errors.js";
import { parseTag } from "../../common/objects.js";
import { PACK_BLOB_BATCH_TARGET_BYTES } from "../../store/index.js";
import type { Repository } from "../repository/repository.js";
import {
  MAX_TAG_DEPTH,
  OBJECT_PAGE,
  type ResolvedRoot,
  type RootResolutionState,
} from "./push-plan-types.js";

// Stored objects were hashed at ingest or write (ADR-0004): types come from
// metadata, and only tag bodies are read, to follow their targets.
function recordObjects(
  repo: Repository,
  oids: readonly string[],
  state: RootResolutionState,
): void {
  const unknown = oids.filter((oid) => !state.types.has(oid));
  for (let offset = 0; offset < unknown.length; offset += OBJECT_PAGE) {
    const page = unknown.slice(offset, offset + OBJECT_PAGE);
    const promised = repo.store.promisedMissing(page);
    if (promised.length > 0) throw new PromisedObjectError(promised);
    let tags: string[] = [];
    for (const info of repo.store.objectInfo(page)) {
      state.types.set(info.oid, info.type);
      if (info.type === "tag") tags.push(info.oid);
    }
    while (tags.length > 0) {
      const batch = repo.readObjects(tags, { budgetBytes: PACK_BLOB_BATCH_TARGET_BYTES });
      for (const [oid, object] of batch.objects) {
        const tag = parseTag(object.data);
        state.tags.set(oid, { object: tag.object, type: tag.type });
      }
      tags = batch.remaining;
    }
  }
}

export function resolveRoots(repo: Repository, oids: readonly string[]): Map<string, ResolvedRoot> {
  const state: RootResolutionState = { types: new Map(), tags: new Map() };
  let frontier = [...new Set(oids)];
  for (let depth = 0; frontier.length > 0 && depth <= MAX_TAG_DEPTH; depth++) {
    recordObjects(repo, frontier, state);
    const next: string[] = [];
    for (const oid of frontier) {
      if (state.types.get(oid) !== "tag") continue;
      const tag = state.tags.get(oid);
      if (tag === undefined) throw new CorruptError(`tag ${oid} was not read`);
      if (!state.types.has(tag.object)) next.push(tag.object);
    }
    frontier = [...new Set(next)];
    if (depth === MAX_TAG_DEPTH && frontier.length > 0) {
      throw new CorruptError("local push tag chain is too deep");
    }
  }

  const resolved = new Map<string, ResolvedRoot>();
  for (const oid of oids) {
    const directType = state.types.get(oid);
    if (directType === undefined) throw new CorruptError(`local push object ${oid} disappeared`);
    let current = oid;
    const tags: string[] = [];
    const seen = new Set<string>();
    while (state.types.get(current) === "tag") {
      if (seen.has(current)) throw new CorruptError(`tag chain from ${oid} contains a cycle`);
      seen.add(current);
      tags.push(current);
      const tag = state.tags.get(current);
      if (tag === undefined) throw new CorruptError(`tag ${current} was not read`);
      const targetType = state.types.get(tag.object);
      if (targetType === undefined) {
        throw new CorruptError(`tag ${current} references a missing local object`);
      }
      if (tag.type !== targetType) {
        throw new CorruptError(`tag ${current} declares ${tag.type} but targets ${targetType}`);
      }
      current = tag.object;
    }
    const finalType = state.types.get(current);
    if (finalType === undefined || finalType === "tag") {
      throw new CorruptError(`tag chain from ${oid} has no concrete target`);
    }
    resolved.set(oid, { directType, finalOid: current, finalType, tags });
  }
  return resolved;
}
