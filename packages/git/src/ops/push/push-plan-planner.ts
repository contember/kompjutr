import { isOid } from "../../common/bytes.js";
import { CorruptError } from "../../common/errors.js";
import type { ObjectType } from "../../common/objects.js";
import { comparePaths } from "../../common/streams.js";
import type { PushPlanningUpdate } from "../refs/refspec.js";
import type { Repository } from "../repository/repository.js";
import { resolveRoots } from "./push-plan-auth.js";
import { localPushError } from "./push-plan-errors.js";
import {
  addObject,
  collectCommitGraphs,
  excludedCommits,
  hydrateObjects,
  requireNamespaceKinds,
  requireNamespaceRules,
} from "./push-plan-graph.js";
import { registerPushPlan } from "./push-plan-runtime.js";
import {
  ARRAY_SLOT_BYTES,
  CONTAINER_BASE_BYTES,
  MAP_ENTRY_BYTES,
  type PlannedCommit,
  PUSH_PLAN_FIXED_BYTES,
  type PushPlan,
  type PushPlanOptions,
  PushRetainedTracker,
  SET_ENTRY_BYTES,
} from "./push-plan-types.js";
import {
  normalizedOptions,
  validatePlanningUpdates,
  validatePushPlanBounds,
} from "./push-plan-validation.js";

function planUpdateSet(
  repo: Repository,
  updates: readonly PushPlanningUpdate[],
  requestedOptions: PushPlanOptions = {},
): PushPlan | null {
  const options = normalizedOptions(requestedOptions);
  const tracker = new PushRetainedTracker();
  try {
    validatePlanningUpdates(updates, tracker);
    tracker.set("ordered", CONTAINER_BASE_BYTES + updates.length * ARRAY_SLOT_BYTES);
    const ordered = [...updates];
    ordered.sort((left, right) => comparePaths(left.destination, right.destination));
    let nonDeleteCount = 0;
    for (const update of ordered) if (update.oid !== null) nonDeleteCount++;
    tracker.set("non-deletes", CONTAINER_BASE_BYTES + nonDeleteCount * ARRAY_SLOT_BYTES);
    const nonDeletes: PushPlanningUpdate[] = [];
    for (const update of ordered) if (update.oid !== null) nonDeletes.push(update);
    if (nonDeletes.length === 0) {
      ordered.length = 0;
      nonDeletes.length = 0;
      tracker.clearAll();
      return null;
    }
    tracker.set("verified-refs", CONTAINER_BASE_BYTES + nonDeletes.length * MAP_ENTRY_BYTES);
    const verifiedRefs = new Map<string, string>();
    for (const update of nonDeletes) {
      const source = update.source;
      const oid = update.oid;
      if (source === null || oid === null || isOid(source)) continue;
      const verified = verifiedRefs.get(source);
      if (verified !== undefined) {
        if (verified !== oid) throw new CorruptError(`local ref ${source} has conflicting sources`);
        continue;
      }
      verifiedRefs.set(source, oid);
    }
    verifiedRefs.clear();
    tracker.clear("verified-refs");
    tracker.set("source-oids", CONTAINER_BASE_BYTES + nonDeletes.length * ARRAY_SLOT_BYTES);
    const sourceOids: string[] = [];
    for (const update of nonDeletes) {
      const oid = update.oid;
      if (oid === null) throw new CorruptError("non-delete push update lost its source oid");
      sourceOids.push(oid);
    }
    tracker.set(
      "unique-source-work",
      2 * CONTAINER_BASE_BYTES + sourceOids.length * (SET_ENTRY_BYTES + ARRAY_SLOT_BYTES),
    );
    const uniqueSourceOids = [...new Set(sourceOids)].sort(comparePaths);
    sourceOids.length = 0;
    tracker.clear("source-oids");
    const roots = resolveRoots(repo, uniqueSourceOids, tracker, "roots");
    uniqueSourceOids.length = 0;
    tracker.clear("unique-source-work");
    requireNamespaceKinds(ordered, roots);
    tracker.set("commit-roots", CONTAINER_BASE_BYTES);
    const commitRootOids = new Set<string>();
    for (const root of roots.values()) {
      if (root.finalType !== "commit" || commitRootOids.has(root.finalOid)) continue;
      tracker.set(
        "commit-roots",
        CONTAINER_BASE_BYTES + (commitRootOids.size + 1) * SET_ENTRY_BYTES,
      );
      commitRootOids.add(root.finalOid);
    }

    const shallow = repo.shallow();
    const commits = collectCommitGraphs(repo, commitRootOids, tracker);
    commitRootOids.clear();
    tracker.clear("commit-roots");
    const boundaries = requireNamespaceRules(repo, ordered, roots, commits, tracker);
    for (const oid of options.remoteOids) {
      if (!commits.has(oid) || boundaries.has(oid)) continue;
      tracker.set("boundaries", CONTAINER_BASE_BYTES + (boundaries.size + 1) * SET_ENTRY_BYTES);
      boundaries.add(oid);
    }
    const excluded = excludedCommits(commits, boundaries, tracker);
    tracker.set("wanted", CONTAINER_BASE_BYTES);
    const wanted: PlannedCommit[] = [];
    for (const commit of commits.values()) {
      if (excluded.has(commit.oid)) continue;
      validatePushPlanBounds(0, wanted.length + 1, options);
      tracker.set("wanted", CONTAINER_BASE_BYTES + (wanted.length + 1) * ARRAY_SLOT_BYTES);
      wanted.push(commit);
    }
    const newCommitCount = wanted.length;
    for (const commit of wanted) {
      if (shallow.has(commit.oid) && commit.parents.length > 0) {
        throw new CorruptError(`push closure reaches shallow boundary ${commit.oid}`);
      }
    }
    shallow.clear();
    boundaries.clear();
    excluded.clear();
    tracker.clear("boundaries");
    tracker.clear("excluded");

    tracker.set("object-map", CONTAINER_BASE_BYTES);
    const objects = new Map<string, ObjectType>();
    for (const commit of wanted) {
      addObject(objects, commit.oid, "commit", tracker, options);
      const firstParent = commit.parents[0];
      const parent = firstParent === undefined ? undefined : commits.get(firstParent);
      if (firstParent !== undefined && parent === undefined) {
        throw new CorruptError(`push commit ${commit.oid} has a missing parent ${firstParent}`);
      }
      for (const object of repo.walkTreeDiffObjects(parent?.tree ?? null, commit.tree)) {
        addObject(objects, object.oid, object.type, tracker, options);
      }
    }
    wanted.length = 0;
    commits.clear();
    tracker.clear("wanted");
    tracker.clear("commit-map");

    tracker.set("active-roots", CONTAINER_BASE_BYTES);
    const activeRoots = new Set<string>();
    for (const update of nonDeletes) {
      const oid = update.oid;
      if (oid === null || oid === update.oldOid || activeRoots.has(oid)) continue;
      tracker.set("active-roots", CONTAINER_BASE_BYTES + (activeRoots.size + 1) * SET_ENTRY_BYTES);
      activeRoots.add(oid);
    }
    tracker.set("sorted-active-roots", CONTAINER_BASE_BYTES + activeRoots.size * ARRAY_SLOT_BYTES);
    const sortedActiveRoots = [...activeRoots].sort(comparePaths);
    for (const oid of sortedActiveRoots) {
      const root = roots.get(oid);
      if (root === undefined) throw new CorruptError(`push source ${oid} was not resolved`);
      for (const tagOid of root.tags) addObject(objects, tagOid, "tag", tracker, options);
      if (root.finalType === "tree") {
        for (const object of repo.walkTreeDiffObjects(null, root.finalOid)) {
          addObject(objects, object.oid, object.type, tracker, options);
        }
      } else if (root.finalType === "blob") {
        addObject(objects, root.finalOid, "blob", tracker, options);
      }
    }
    activeRoots.clear();
    sortedActiveRoots.length = 0;
    roots.clear();
    tracker.clear("active-roots");
    tracker.clear("sorted-active-roots");
    tracker.clear("roots");

    const hydrated = hydrateObjects(repo, objects, tracker);
    validatePushPlanBounds(hydrated.length, newCommitCount, options);
    ordered.length = 0;
    nonDeletes.length = 0;
    tracker.clear("ordered");
    tracker.clear("non-deletes");
    tracker.clear("update-input");
    tracker.set("plan-state", PUSH_PLAN_FIXED_BYTES);
    tracker.keepOnly("hydrated-plan", "plan-state");
    return registerPushPlan(hydrated, newCommitCount);
  } catch (error) {
    tracker.clearAll();
    return localPushError(error);
  }
}

/** Plan one deterministic object closure for a validated multi-ref push. */
export function planPushUpdates(
  repo: Repository,
  updates: readonly PushPlanningUpdate[],
  options: PushPlanOptions = {},
): PushPlan | null {
  return planUpdateSet(repo, updates, options);
}

/** Plan every object absent from the advertised target branch ancestry. */
export function planPushObjects(
  repo: Repository,
  newOid: string,
  oldOid: string,
  force: boolean,
  remoteOids: readonly string[] = [oldOid],
): PushPlan {
  const plan = planUpdateSet(
    repo,
    [
      {
        source: newOid,
        destination: "refs/heads/legacy-push",
        oid: newOid,
        force,
        oldOid,
      },
    ],
    { remoteOids },
  );
  if (plan === null) throw new CorruptError("legacy non-delete push produced no pack plan");
  return plan;
}
