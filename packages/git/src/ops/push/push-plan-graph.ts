import { CorruptError, GitError, hasErrorCode, PromisedObjectError } from "../../common/errors.js";
import type { ObjectType } from "../../common/objects.js";
import { ZERO_OID } from "../../protocol/receive-pack.js";
import type { PushPlanningUpdate } from "../refs/refspec.js";
import { type Repository, walkIndexedOwned } from "../repository/repository.js";
import { resolveRoots } from "./push-plan-roots.js";
import {
  type NormalizedPushPlanOptions,
  OBJECT_PAGE,
  type PlannedCommit,
  type PushObject,
  type ResolvedRoot,
} from "./push-plan-types.js";
import { validatePushPlanBounds } from "./push-plan-validation.js";

export function addObject(
  objects: Map<string, ObjectType>,
  oid: string,
  type: ObjectType,
  limits: NormalizedPushPlanOptions,
): void {
  const prior = objects.get(oid);
  if (prior !== undefined && prior !== type) {
    throw new CorruptError(`object ${oid} is indexed as both ${prior} and ${type}`);
  }
  if (prior !== undefined) return;
  validatePushPlanBounds(objects.size + 1, 0, limits);
  objects.set(oid, type);
}

export function excludedCommits(
  commits: ReadonlyMap<string, PlannedCommit>,
  remoteOids: Iterable<string>,
): Set<string> {
  const excluded = new Set<string>();
  const pending: string[] = [];
  const queued = new Set<string>();
  const enqueue = (oid: string): void => {
    if (oid === ZERO_OID || !commits.has(oid) || excluded.has(oid) || queued.has(oid)) return;
    pending.push(oid);
    queued.add(oid);
  };
  for (const oid of remoteOids) enqueue(oid);
  while (pending.length > 0) {
    const oid = pending.pop();
    if (oid === undefined) continue;
    queued.delete(oid);
    if (excluded.has(oid)) continue;
    excluded.add(oid);
    const commit = commits.get(oid);
    if (commit === undefined) continue;
    for (const parent of commit.parents) enqueue(parent);
  }
  return excluded;
}

export function hydrateObjects(repo: Repository, objects: Map<string, ObjectType>): PushObject[] {
  const planned: PushObject[] = [];
  let page: ([string, ObjectType] | undefined)[] = [];
  const flush = (): void => {
    if (page.length === 0) return;
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
      planned.push(found);
      page[index] = undefined;
    }
    page = [];
  };
  for (const entry of objects) {
    page.push(entry);
    objects.delete(entry[0]);
    if (page.length === OBJECT_PAGE) flush();
  }
  flush();
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
): Map<string, PlannedCommit> {
  const commits = new Map<string, PlannedCommit>();
  for (const root of roots) {
    for (const { oid, commit } of walkIndexedOwned(repo, root)) {
      const prior = commits.get(oid);
      if (prior !== undefined) {
        if (!sameCommit(prior, commit.tree, commit.parent)) {
          throw new CorruptError(`commit ${oid} changed between push graph walks`);
        }
        continue;
      }
      commits.set(oid, { oid, tree: commit.tree, parents: commit.parent });
    }
  }
  return commits;
}

function customBoundary(
  repo: Repository,
  oldOid: string,
  commits: ReadonlyMap<string, PlannedCommit>,
): string | null {
  if (commits.has(oldOid)) return oldOid;
  try {
    const old = resolveRoots(repo, [oldOid]).get(oldOid);
    if (old?.finalType !== "commit" || !commits.has(old.finalOid)) return null;
    return old.finalOid;
  } catch (error) {
    if (hasErrorCode(error, "E2BIG")) throw error;
    return null;
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
): Set<string> {
  const boundaries = new Set<string>();
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
        boundaries.add(root.finalOid);
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
        boundaries.add(update.oldOid);
      } else if (commits.has(update.oldOid)) {
        boundaries.add(update.oldOid);
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
      const boundary = customBoundary(repo, update.oldOid, commits);
      if (boundary === null) {
        throw new GitError(
          "ENONFASTFORWARD",
          `${update.destination} is not an ancestor of its local source`,
        );
      }
      boundaries.add(boundary);
    } else if (commits.has(update.oldOid)) {
      boundaries.add(update.oldOid);
    }
  }
  return boundaries;
}
