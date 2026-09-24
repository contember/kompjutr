import { isOid } from "../../common/bytes.js";
import { CorruptError } from "../../common/errors.js";
import type { ObjectType } from "../../common/objects.js";
import { comparePaths } from "../../common/streams.js";
import type { PushPlanningUpdate } from "../refs/refspec.js";
import type { Repository } from "../repository/repository.js";
import { localPushError } from "./push-plan-errors.js";
import {
  addObject,
  collectCommitGraphs,
  excludedCommits,
  hydrateObjects,
  requireNamespaceKinds,
  requireNamespaceRules,
} from "./push-plan-graph.js";
import { resolveRoots } from "./push-plan-roots.js";
import type { PlannedCommit, PushPlan, PushPlanOptions } from "./push-plan-types.js";
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
  try {
    validatePlanningUpdates(updates);
    const ordered = [...updates];
    ordered.sort((left, right) => comparePaths(left.destination, right.destination));
    const nonDeletes: PushPlanningUpdate[] = [];
    for (const update of ordered) if (update.oid !== null) nonDeletes.push(update);
    if (nonDeletes.length === 0) return null;
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
    const sourceOids: string[] = [];
    for (const update of nonDeletes) {
      const oid = update.oid;
      if (oid === null) throw new CorruptError("non-delete push update lost its source oid");
      sourceOids.push(oid);
    }
    const uniqueSourceOids = [...new Set(sourceOids)].sort(comparePaths);
    sourceOids.length = 0;
    const roots = resolveRoots(repo, uniqueSourceOids);
    uniqueSourceOids.length = 0;
    requireNamespaceKinds(ordered, roots);
    const commitRootOids = new Set<string>();
    for (const root of roots.values()) {
      if (root.finalType !== "commit") continue;
      commitRootOids.add(root.finalOid);
    }

    const shallow = repo.shallow();
    const commits = collectCommitGraphs(repo, commitRootOids);
    commitRootOids.clear();
    const boundaries = requireNamespaceRules(repo, ordered, roots, commits);
    for (const oid of options.remoteOids) {
      if (commits.has(oid)) boundaries.add(oid);
    }
    const excluded = excludedCommits(commits, boundaries);
    const wanted: PlannedCommit[] = [];
    for (const commit of commits.values()) {
      if (excluded.has(commit.oid)) continue;
      validatePushPlanBounds(0, wanted.length + 1, options);
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

    const objects = new Map<string, ObjectType>();
    for (const commit of wanted) {
      addObject(objects, commit.oid, "commit", options);
      const firstParent = commit.parents[0];
      const parent = firstParent === undefined ? undefined : commits.get(firstParent);
      if (firstParent !== undefined && parent === undefined) {
        throw new CorruptError(`push commit ${commit.oid} has a missing parent ${firstParent}`);
      }
      for (const object of repo.walkTreeDiffObjects(parent?.tree ?? null, commit.tree)) {
        addObject(objects, object.oid, object.type, options);
      }
    }
    wanted.length = 0;
    commits.clear();

    const activeRoots = new Set<string>();
    for (const update of nonDeletes) {
      const oid = update.oid;
      if (oid === null || oid === update.oldOid) continue;
      activeRoots.add(oid);
    }
    const sortedActiveRoots = [...activeRoots].sort(comparePaths);
    for (const oid of sortedActiveRoots) {
      const root = roots.get(oid);
      if (root === undefined) throw new CorruptError(`push source ${oid} was not resolved`);
      for (const tagOid of root.tags) addObject(objects, tagOid, "tag", options);
      if (root.finalType === "tree") {
        for (const object of repo.walkTreeDiffObjects(null, root.finalOid)) {
          addObject(objects, object.oid, object.type, options);
        }
      } else if (root.finalType === "blob") {
        addObject(objects, root.finalOid, "blob", options);
      }
    }
    activeRoots.clear();
    sortedActiveRoots.length = 0;
    roots.clear();

    const hydrated = hydrateObjects(repo, objects);
    validatePushPlanBounds(hydrated.length, newCommitCount, options);
    ordered.length = 0;
    nonDeletes.length = 0;
    return { objects: hydrated, newCommits: newCommitCount };
  } catch (error) {
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
