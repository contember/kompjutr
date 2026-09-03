import { isOid } from "../common/bytes.js";
import { CorruptError, GitError, PromisedObjectError } from "../common/errors.js";
import { hashObject, parseCommit, parseTag, parseTree, type RawObject } from "../common/objects.js";
import { ZERO_OID } from "../protocol/receive-pack.js";
import { PACK_BLOB_BATCH_TARGET_BYTES } from "../store/index.js";
import { localPushError } from "./push-plan-errors.js";
import {
  ARRAY_SLOT_BYTES,
  type AuthenticatedTagTarget,
  type AuthenticationState,
  CONTAINER_BASE_BYTES,
  MAX_PUSH_BRANCH_TARGETS,
  MAX_TAG_DEPTH,
  PushRetainedTracker,
  type ResolvedRoot,
  ROOT_ENTRY_BYTES,
  SET_ENTRY_BYTES,
  TAG_ENTRY_BYTES,
} from "./push-plan-types.js";
import type { Repository } from "./repository.js";

function validateAuthenticatedObject(
  oid: string,
  object: RawObject,
): AuthenticatedTagTarget | null {
  if (hashObject(object.type, object.data) !== oid) {
    throw new CorruptError(`local object ${oid} does not match its bytes`);
  }
  if (object.type === "commit") parseCommit(object.data);
  else if (object.type === "tree") parseTree(object.data);
  else if (object.type === "tag") {
    const tag = parseTag(object.data);
    return { object: tag.object, type: tag.type };
  }
  return null;
}

function authenticateObjects(
  repo: Repository,
  oids: readonly string[],
  state: AuthenticationState,
  tracker: PushRetainedTracker,
): void {
  tracker.set("root-auth-input", 2 * CONTAINER_BASE_BYTES + oids.length * 2 * SET_ENTRY_BYTES);
  let remaining = oids.filter((oid) => !state.types.has(oid));
  while (remaining.length > 0) {
    const promised = repo.store.promisedMissing(remaining);
    if (promised.length > 0) throw new PromisedObjectError(promised);
    const info = repo.store.objectInfo(remaining);
    let selectedBytes = 0;
    let selected = 0;
    while (selected < info.length) {
      const object = info[selected];
      if (object === undefined) throw new CorruptError("push authentication lost object metadata");
      if (selected > 0 && object.size > PACK_BLOB_BATCH_TARGET_BYTES - selectedBytes) {
        break;
      }
      selectedBytes += object.size;
      selected++;
    }
    const batch = repo.readObjects(remaining, { budgetBytes: Math.max(1, selectedBytes) });
    if (batch.objects.size !== selected || batch.remaining.length >= remaining.length) {
      throw new CorruptError("push authentication made no progress");
    }
    for (const [oid, object] of batch.objects) {
      const tag = validateAuthenticatedObject(oid, object);
      tracker.set(
        "root-auth-state",
        (state.types.size + 1) * ROOT_ENTRY_BYTES +
          (state.tags.size + (tag === null ? 0 : 1)) * TAG_ENTRY_BYTES,
      );
      state.types.set(oid, object.type);
      if (tag !== null) state.tags.set(oid, tag);
    }
    remaining = batch.remaining;
  }
}

/** Hash and parse direct commit targets; callers must omit ZERO_OID deletions. */
export function authenticatePushBranchTargets(
  repo: Repository,
  targetOids: readonly string[],
): void {
  if (!Array.isArray(targetOids)) {
    throw new GitError("EINVAL", "push branch target list must be an array");
  }
  if (targetOids.length > MAX_PUSH_BRANCH_TARGETS) {
    throw new GitError(
      "E2BIG",
      `push branch target list exceeds ${MAX_PUSH_BRANCH_TARGETS} entries`,
    );
  }
  const tracker = new PushRetainedTracker();
  try {
    tracker.set(
      "target-input",
      2 * CONTAINER_BASE_BYTES + targetOids.length * (ARRAY_SLOT_BYTES + SET_ENTRY_BYTES),
    );
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const oid of targetOids) {
      if (!isOid(oid)) {
        throw new GitError("EINVAL", "push branch target list contains an invalid object id");
      }
      if (oid === ZERO_OID) {
        throw new GitError("EINVAL", "push branch target list must omit the zero object id");
      }
      if (seen.has(oid)) continue;
      seen.add(oid);
      unique.push(oid);
    }

    const state: AuthenticationState = { types: new Map(), tags: new Map() };
    authenticateObjects(repo, unique, state, tracker);
    for (const oid of unique) {
      if (state.types.get(oid) !== "commit") {
        throw new GitError("EINVALIDREF", `push branch target ${oid} is not a direct commit`);
      }
    }
  } catch (error) {
    localPushError(error);
  } finally {
    tracker.clearAll();
  }
}

export function resolveRoots(
  repo: Repository,
  oids: readonly string[],
  tracker: PushRetainedTracker,
  part: string,
): Map<string, ResolvedRoot> {
  const state: AuthenticationState = { types: new Map(), tags: new Map() };
  try {
    tracker.set("root-frontiers", 3 * CONTAINER_BASE_BYTES + oids.length * 3 * SET_ENTRY_BYTES);
    let frontier = [...new Set(oids)];
    for (let depth = 0; frontier.length > 0 && depth <= MAX_TAG_DEPTH; depth++) {
      authenticateObjects(repo, frontier, state, tracker);
      const next: string[] = [];
      for (const oid of frontier) {
        if (state.types.get(oid) !== "tag") continue;
        const tag = state.tags.get(oid);
        if (tag === undefined) throw new CorruptError(`authenticated tag ${oid} was not parsed`);
        if (!state.types.has(tag.object)) next.push(tag.object);
      }
      frontier = [...new Set(next)];
      if (depth === MAX_TAG_DEPTH && frontier.length > 0) {
        throw new CorruptError("local push tag chain is too deep");
      }
    }

    tracker.set(part, CONTAINER_BASE_BYTES);
    const resolved = new Map<string, ResolvedRoot>();
    for (const oid of oids) {
      const directType = state.types.get(oid);
      if (directType === undefined) throw new CorruptError(`local push object ${oid} disappeared`);
      let current = oid;
      tracker.set("root-chain", 2 * CONTAINER_BASE_BYTES);
      const tags: string[] = [];
      const seen = new Set<string>();
      while (state.types.get(current) === "tag") {
        if (seen.has(current)) throw new CorruptError(`tag chain from ${oid} contains a cycle`);
        tracker.set(
          "root-chain",
          2 * CONTAINER_BASE_BYTES +
            (seen.size + 1) * SET_ENTRY_BYTES +
            (tags.length + 1) * ARRAY_SLOT_BYTES,
        );
        seen.add(current);
        tags.push(current);
        const tag = state.tags.get(current);
        if (tag === undefined)
          throw new CorruptError(`authenticated tag ${current} was not parsed`);
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
      tracker.set(
        part,
        CONTAINER_BASE_BYTES +
          (resolved.size + 1) * ROOT_ENTRY_BYTES +
          (resolvedRootBytes(resolved) - resolved.size * ROOT_ENTRY_BYTES) +
          tags.length * 80,
      );
      resolved.set(oid, { directType, finalOid: current, finalType, tags });
      tracker.clear("root-chain");
    }
    return resolved;
  } finally {
    tracker.clear("root-auth-input");
    tracker.clear("root-auth-state");
    tracker.clear("root-frontiers");
    tracker.clear("root-chain");
  }
}

function resolvedRootBytes(roots: ReadonlyMap<string, ResolvedRoot>): number {
  let bytes = 0;
  for (const root of roots.values()) bytes += 256 + root.tags.length * 80;
  return bytes;
}
