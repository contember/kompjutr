import { CorruptError, GitError, hasErrorCode, PromisedObjectError } from "../common/errors.js";
import type { ObjectType } from "../common/objects.js";
import { ZERO_OID } from "../protocol/receive-pack.js";
import { resolveRoots } from "./push-plan-auth.js";
import {
  ARRAY_SLOT_BYTES,
  COMMIT_ENTRY_BYTES,
  COMMIT_PARENT_BYTES,
  CONTAINER_BASE_BYTES,
  type NormalizedPushPlanOptions,
  OBJECT_PAGE,
  type PlannedCommit,
  PUSH_PLAN_OBJECT_BYTES,
  type PushObject,
  type PushRetainedTracker,
  type ResolvedRoot,
  SET_ENTRY_BYTES,
} from "./push-plan-types.js";
import { validatePushPlanBounds } from "./push-plan-validation.js";
import type { PushPlanningUpdate } from "./refspec.js";
import { type Repository, walkIndexedOwned } from "./repository.js";

export function addObject(
  objects: Map<string, ObjectType>,
  oid: string,
  type: ObjectType,
  tracker: PushRetainedTracker,
  limits: NormalizedPushPlanOptions,
): void {
  const prior = objects.get(oid);
  if (prior !== undefined && prior !== type) {
    throw new CorruptError(`object ${oid} is indexed as both ${prior} and ${type}`);
  }
  if (prior !== undefined) return;
  const count = objects.size + 1;
  validatePushPlanBounds(count, 0, limits);
  tracker.set("object-map", CONTAINER_BASE_BYTES + count * PUSH_PLAN_OBJECT_BYTES);
  objects.set(oid, type);
}

export function excludedCommits(
  commits: ReadonlyMap<string, PlannedCommit>,
  remoteOids: Iterable<string>,
  tracker: PushRetainedTracker,
): Set<string> {
  tracker.set("excluded", CONTAINER_BASE_BYTES);
  tracker.set("exclude-pending", CONTAINER_BASE_BYTES);
  tracker.set("exclude-queued", CONTAINER_BASE_BYTES);
  const excluded = new Set<string>();
  const pending: string[] = [];
  const queued = new Set<string>();
  const enqueue = (oid: string): void => {
    if (oid === ZERO_OID || !commits.has(oid) || excluded.has(oid) || queued.has(oid)) return;
    tracker.set("exclude-pending", CONTAINER_BASE_BYTES + (pending.length + 1) * ARRAY_SLOT_BYTES);
    tracker.set("exclude-queued", CONTAINER_BASE_BYTES + (queued.size + 1) * SET_ENTRY_BYTES);
    pending.push(oid);
    queued.add(oid);
  };
  for (const oid of remoteOids) enqueue(oid);
  while (pending.length > 0) {
    const oid = pending.pop();
    if (oid === undefined) continue;
    tracker.set("exclude-pending", CONTAINER_BASE_BYTES + pending.length * ARRAY_SLOT_BYTES);
    queued.delete(oid);
    tracker.set("exclude-queued", CONTAINER_BASE_BYTES + queued.size * SET_ENTRY_BYTES);
    if (excluded.has(oid)) continue;
    tracker.set("excluded", CONTAINER_BASE_BYTES + (excluded.size + 1) * SET_ENTRY_BYTES);
    excluded.add(oid);
    const commit = commits.get(oid);
    if (commit === undefined) continue;
    for (const parent of commit.parents) enqueue(parent);
  }
  tracker.clear("exclude-pending");
  tracker.clear("exclude-queued");
  return excluded;
}

export function hydrateObjects(
  repo: Repository,
  objects: Map<string, ObjectType>,
  tracker: PushRetainedTracker,
): PushObject[] {
  tracker.set("hydrated-plan", CONTAINER_BASE_BYTES);
  const planned: PushObject[] = [];
  tracker.set("hydration-page", CONTAINER_BASE_BYTES);
  let page: ([string, ObjectType] | undefined)[] = [];
  const flush = (): void => {
    if (page.length === 0) return;
    tracker.set(
      "hydration-info",
      2 * CONTAINER_BASE_BYTES + page.length * (PUSH_PLAN_OBJECT_BYTES + ARRAY_SLOT_BYTES),
    );
    const oids: string[] = [];
    for (const entry of page) {
      if (entry === undefined) throw new CorruptError("push hydration page lost an entry");
      oids.push(entry[0]);
    }
    const promised = repo.store.promisedMissing(oids);
    if (promised.length > 0) throw new PromisedObjectError(promised);
    const info = repo.store.objectInfo(oids);
    for (let index = 0; index < page.length; index++) {
      const entry = page[index];
      const found = info[index];
      if (entry === undefined || found === undefined) {
        throw new CorruptError("push metadata lookup returned too few objects");
      }
      const [oid, type] = entry;
      if (found.oid !== oid || found.type !== type) {
        throw new CorruptError(`push metadata for ${oid} does not match its planned type`);
      }
      const nextPlanBytes = CONTAINER_BASE_BYTES + (planned.length + 1) * PUSH_PLAN_OBJECT_BYTES;
      tracker.transfer("hydration-page", PUSH_PLAN_OBJECT_BYTES, "hydrated-plan", nextPlanBytes);
      planned.push(found);
      page[index] = undefined;
    }
    tracker.clear("hydration-info");
    page = [];
    tracker.set("hydration-page", CONTAINER_BASE_BYTES);
  };
  for (const entry of objects) {
    const nextPageBytes = CONTAINER_BASE_BYTES + (page.length + 1) * PUSH_PLAN_OBJECT_BYTES;
    tracker.transfer("object-map", PUSH_PLAN_OBJECT_BYTES, "hydration-page", nextPageBytes);
    page.push(entry);
    objects.delete(entry[0]);
    if (page.length === OBJECT_PAGE) flush();
  }
  flush();
  tracker.clear("object-map");
  tracker.clear("hydration-page");
  return planned;
}

function sameCommit(left: PlannedCommit, tree: string, parents: readonly string[]): boolean {
  if (left.tree !== tree || left.parents.length !== parents.length) return false;
  for (let index = 0; index < left.parents.length; index++) {
    if (left.parents[index] !== parents[index]) return false;
  }
  return true;
}

export function collectCommitGraphs(
  repo: Repository,
  roots: Iterable<string>,
  tracker: PushRetainedTracker,
): Map<string, PlannedCommit> {
  tracker.set("commit-map", CONTAINER_BASE_BYTES);
  const commits = new Map<string, PlannedCommit>();
  let retainedBytes = CONTAINER_BASE_BYTES;
  for (const root of roots) {
    const graphBytes = tracker.remainingBytes;
    if (graphBytes < 1) {
      throw new GitError("E2BIG", "push commit graph has no operation memory capacity");
    }
    for (const { oid, commit } of walkIndexedOwned(repo, root, {
      maxBytes: graphBytes,
    })) {
      const prior = commits.get(oid);
      if (prior !== undefined) {
        if (!sameCommit(prior, commit.tree, commit.parent)) {
          throw new CorruptError(`commit ${oid} changed between push graph walks`);
        }
        continue;
      }
      retainedBytes += COMMIT_ENTRY_BYTES + commit.parent.length * COMMIT_PARENT_BYTES;
      tracker.set("commit-map", retainedBytes);
      const planned = { oid, tree: commit.tree, parents: commit.parent };
      commits.set(oid, planned);
    }
  }
  return commits;
}

function customBoundary(
  repo: Repository,
  oldOid: string,
  commits: ReadonlyMap<string, PlannedCommit>,
  tracker: PushRetainedTracker,
): string | null {
  if (commits.has(oldOid)) return oldOid;
  try {
    const old = resolveRoots(repo, [oldOid], tracker, "remote-root").get(oldOid);
    if (old?.finalType !== "commit" || !commits.has(old.finalOid)) return null;
    return old.finalOid;
  } catch (error) {
    if (hasErrorCode(error, "E2BIG")) throw error;
    return null;
  } finally {
    tracker.clear("remote-root");
  }
}

export function requireNamespaceKinds(
  updates: readonly PushPlanningUpdate[],
  roots: ReadonlyMap<string, ResolvedRoot>,
): void {
  for (const update of updates) {
    const oid = update.oid;
    if (oid === null) continue;
    const root = roots.get(oid);
    if (root === undefined) throw new CorruptError(`push source ${oid} was not resolved`);
    if (update.destination.startsWith("refs/heads/") && root.directType !== "commit") {
      throw new GitError("EINVALIDREF", `${update.destination} must point directly to a commit`);
    }
    if (
      update.destination.startsWith("refs/tags/") &&
      update.oldOid !== ZERO_OID &&
      update.oldOid !== oid &&
      !update.force
    ) {
      throw new GitError("ETAGFAIL", `push would replace existing tag ${update.destination}`);
    }
    if (
      !update.destination.startsWith("refs/heads/") &&
      !update.destination.startsWith("refs/tags/") &&
      update.oldOid !== ZERO_OID &&
      update.oldOid !== oid &&
      !update.force &&
      root.finalType !== "commit"
    ) {
      throw new GitError(
        "ENONFASTFORWARD",
        `${update.destination} requires force for a non-commit replacement`,
      );
    }
  }
}

export function requireNamespaceRules(
  repo: Repository,
  updates: readonly PushPlanningUpdate[],
  roots: ReadonlyMap<string, ResolvedRoot>,
  commits: ReadonlyMap<string, PlannedCommit>,
  tracker: PushRetainedTracker,
): Set<string> {
  tracker.set("boundaries", CONTAINER_BASE_BYTES);
  const boundaries = new Set<string>();
  const addBoundary = (oid: string): void => {
    if (boundaries.has(oid)) return;
    tracker.set("boundaries", CONTAINER_BASE_BYTES + (boundaries.size + 1) * SET_ENTRY_BYTES);
    boundaries.add(oid);
  };
  for (const update of updates) {
    const oid = update.oid;
    if (oid === null) continue;
    const root = roots.get(oid);
    if (root === undefined) throw new CorruptError(`push source ${oid} was not resolved`);
    if (update.destination.startsWith("refs/heads/") && root.directType !== "commit") {
      throw new GitError("EINVALIDREF", `${update.destination} must point directly to a commit`);
    }
    if (update.oldOid === oid) {
      if (root.finalType === "commit" && commits.has(root.finalOid)) {
        addBoundary(root.finalOid);
      }
      continue;
    }
    if (update.destination.startsWith("refs/heads/")) {
      if (update.oldOid !== ZERO_OID && !update.force) {
        if (!commits.has(update.oldOid)) {
          throw new GitError(
            "ENONFASTFORWARD",
            `${update.destination} is not an ancestor of its local source`,
          );
        }
        addBoundary(update.oldOid);
      } else if (commits.has(update.oldOid)) {
        addBoundary(update.oldOid);
      }
      continue;
    }
    if (update.destination.startsWith("refs/tags/")) {
      if (update.oldOid !== ZERO_OID && !update.force) {
        throw new GitError("ETAGFAIL", `push would replace existing tag ${update.destination}`);
      }
      continue;
    }
    if (update.oldOid === ZERO_OID) continue;
    if (!update.force) {
      if (root.finalType !== "commit") {
        throw new GitError(
          "ENONFASTFORWARD",
          `${update.destination} requires force for a non-commit replacement`,
        );
      }
      const boundary = customBoundary(repo, update.oldOid, commits, tracker);
      if (boundary === null) {
        throw new GitError(
          "ENONFASTFORWARD",
          `${update.destination} is not an ancestor of its local source`,
        );
      }
      addBoundary(boundary);
    } else if (commits.has(update.oldOid)) {
      addBoundary(update.oldOid);
    }
  }
  return boundaries;
}
