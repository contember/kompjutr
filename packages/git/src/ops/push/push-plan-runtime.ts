import { isOid } from "../../common/bytes.js";
import { GitError, hasErrorCode } from "../../common/errors.js";
import { PACK_BLOB_BATCH_TARGET_BYTES } from "../../store/index.js";
import { streamFullObjectPack } from "../../store/pack/full-object-stream.js";
import type { Repository } from "../repository/repository.js";
import {
  MAX_PUSH_OBJECTS,
  type PushObject,
  type PushPlan,
  type PushPlanState,
} from "./push-plan-types.js";

const stateByPlan = new WeakMap<PushPlan, PushPlanState>();

export function registerPushPlan(objects: PushObject[], newCommits: number): PushPlan {
  const plan: PushPlan = Object.freeze({ newCommits });
  stateByPlan.set(plan, {
    objects,
    openings: 0,
    activeStreams: 0,
    disposeRequested: false,
    disposed: false,
  });
  return plan;
}

/** Open a fresh, byte-identical pack stream for an HTTP attempt. */
export async function* openPushPack(repo: Repository, plan: PushPlan): AsyncGenerator<Uint8Array> {
  const state = requirePlanState(plan);
  if (state.disposed || state.disposeRequested)
    throw new GitError("EINVAL", "push plan is disposed");
  if (state.openings >= 2) {
    throw new GitError("EPUSHLOCAL", "push pack may be opened at most twice");
  }
  state.openings++;
  state.activeStreams++;
  try {
    yield* generatePushPack(repo, state.objects);
  } catch (error) {
    if (hasErrorCode(error, "E2BIG")) throw error;
    throw new GitError("EPUSHLOCAL", "local object validation failed while streaming push", {
      cause: error,
    });
  } finally {
    state.activeStreams--;
    if (state.disposeRequested && state.activeStreams === 0) finalizePushPlanDisposal(state);
  }
}

/** Release retained planning state after push completion. */
export function disposePushPlan(plan: PushPlan): void {
  const state = stateByPlan.get(plan);
  if (state === undefined || state.disposed) return;
  state.disposeRequested = true;
  if (state.activeStreams === 0) finalizePushPlanDisposal(state);
}

function finalizePushPlanDisposal(state: PushPlanState): void {
  if (state.disposed) return;
  state.objects.length = 0;
  state.disposed = true;
}

function requirePlanState(plan: PushPlan): PushPlanState {
  const state = stateByPlan.get(plan);
  if (state === undefined) throw new GitError("EINVAL", "invalid push plan");
  if (state.disposed || state.disposeRequested)
    throw new GitError("EINVAL", "push plan is disposed");
  return state;
}

/** Number of objects retained by a live opaque push plan. */
export function pushPlanObjectCount(plan: PushPlan): number {
  return requirePlanState(plan).objects.length;
}

/** Whether a live opaque push plan contains one object id. */
export function pushPlanHasObject(plan: PushPlan, oid: string): boolean {
  if (!isOid(oid)) throw new GitError("EINVAL", "push plan query has an invalid object id");
  for (const object of requirePlanState(plan).objects) if (object.oid === oid) return true;
  return false;
}

/** Object id at one deterministic plan position, or null beyond the end. */
export function pushPlanObjectOidAt(plan: PushPlan, index: number): string | null {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new GitError("EINVAL", "push plan index must be a safe nonnegative integer");
  }
  return requirePlanState(plan).objects[index]?.oid ?? null;
}

async function* generatePushPack(
  repo: Repository,
  objects: readonly PushObject[],
): AsyncGenerator<Uint8Array> {
  yield* streamFullObjectPack(
    objects,
    {
      readBatch: (objects) =>
        repo.readObjects(
          objects.map((object) => object.oid),
          { budgetBytes: PACK_BLOB_BATCH_TARGET_BYTES },
        ).objects,
      readChunks: (object) => repo.store.readChunks(object.oid),
    },
    {
      maxObjects: MAX_PUSH_OBJECTS,
      maxInflatedBytes: Number.MAX_SAFE_INTEGER,
      maxStoredBytes: Number.MAX_SAFE_INTEGER,
      readBatchBytes: PACK_BLOB_BATCH_TARGET_BYTES,
      allowOversizedObject: true,
    },
  );
}
