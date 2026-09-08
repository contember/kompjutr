import { isOid } from "../../common/bytes.js";
import { GitError } from "../../common/errors.js";
import { checkRefText, hasCanonicalRefSyntax } from "../../common/ref-name.js";
import type { PushPlanningUpdate } from "../refs/refspec.js";
import {
  ARRAY_SLOT_BYTES,
  CONTAINER_BASE_BYTES,
  MAX_PUSH_COMMITS,
  MAX_PUSH_OBJECTS,
  MAX_PUSH_UPDATES,
  NO_REMOTE_OIDS,
  type NormalizedPushPlanOptions,
  type PushPlanOptions,
  type PushRetainedTracker,
  pushPlanStringBytes,
  ROOT_ENTRY_BYTES,
  SET_ENTRY_BYTES,
} from "./push-plan-types.js";

/** Validate the three union-wide closure bounds before retaining the next item. */
export function validatePushPlanBounds(
  objectCount: number,
  newCommitCount: number,
  limits: NormalizedPushPlanOptions = {
    maxObjects: MAX_PUSH_OBJECTS,
    maxCommits: MAX_PUSH_COMMITS,
    remoteOids: NO_REMOTE_OIDS,
  },
): void {
  if (
    !Number.isSafeInteger(objectCount) ||
    !Number.isSafeInteger(newCommitCount) ||
    objectCount < 0 ||
    newCommitCount < 0
  ) {
    throw new GitError("EINVAL", "push plan bounds must be safe nonnegative integers");
  }
  if (objectCount > limits.maxObjects) {
    throw new GitError("E2BIG", `push closure exceeds ${limits.maxObjects} objects`);
  }
  if (newCommitCount > limits.maxCommits) {
    throw new GitError("E2BIG", `push exceeds ${limits.maxCommits} new commits`);
  }
}

export function normalizedOptions(options: PushPlanOptions): NormalizedPushPlanOptions {
  const requireLimit = (value: number, maximum: number, label: string): void => {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new GitError("EINVAL", `push ${label} limit must be an integer from 1 to ${maximum}`);
    }
  };
  requireLimit(options.maxObjects ?? MAX_PUSH_OBJECTS, MAX_PUSH_OBJECTS, "object");
  requireLimit(options.maxCommits ?? MAX_PUSH_COMMITS, MAX_PUSH_COMMITS, "commit");
  const remoteOids = options.remoteOids ?? NO_REMOTE_OIDS;
  if (!Array.isArray(remoteOids) || remoteOids.length > MAX_PUSH_OBJECTS) {
    throw new GitError("E2BIG", `push remote object list exceeds ${MAX_PUSH_OBJECTS} entries`);
  }
  for (const oid of remoteOids) {
    if (!isOid(oid))
      throw new GitError("EINVAL", "push remote object list contains an invalid oid");
  }
  return {
    maxObjects: options.maxObjects ?? MAX_PUSH_OBJECTS,
    maxCommits: options.maxCommits ?? MAX_PUSH_COMMITS,
    remoteOids,
  };
}

export function validatePlanningUpdates(
  updates: readonly PushPlanningUpdate[],
  tracker: PushRetainedTracker,
): void {
  if (!Array.isArray(updates)) throw new GitError("EINVAL", "push updates must be an array");
  if (updates.length === 0) throw new GitError("EINVAL", "push update list must not be empty");
  if (updates.length > MAX_PUSH_UPDATES) {
    throw new GitError("E2BIG", `push update list exceeds ${MAX_PUSH_UPDATES} commands`);
  }
  let updateBytes = CONTAINER_BASE_BYTES + updates.length * ARRAY_SLOT_BYTES;
  tracker.set("update-input", updateBytes);
  tracker.set("validation-destinations", CONTAINER_BASE_BYTES);
  try {
    const destinations = new Set<string>();
    for (let index = 0; index < updates.length; index++) {
      const update = updates[index];
      if (update === undefined || typeof update !== "object" || update === null) {
        throw new GitError("EINVAL", `push update ${index + 1} must be an object`);
      }
      if (
        typeof update.destination !== "string" ||
        checkRefText(update.destination).problem !== null ||
        !update.destination.startsWith("refs/") ||
        !hasCanonicalRefSyntax(update.destination)
      ) {
        throw new GitError("EINVALIDREF", `invalid push destination ${update.destination}`);
      }
      if (destinations.has(update.destination)) {
        throw new GitError("EINVAL", `duplicate push destination ${update.destination}`);
      }
      tracker.set(
        "validation-destinations",
        CONTAINER_BASE_BYTES + (destinations.size + 1) * SET_ENTRY_BYTES,
      );
      destinations.add(update.destination);
      if (!isOid(update.oldOid)) {
        throw new GitError("EINVAL", `push update ${index + 1} has an invalid old oid`);
      }
      if (typeof update.force !== "boolean") {
        throw new GitError("EINVAL", `push update ${index + 1} force must be boolean`);
      }
      if (update.source === null || update.oid === null) {
        if (update.source !== null || update.oid !== null || update.force) {
          throw new GitError("EINVAL", `push deletion ${index + 1} is malformed`);
        }
        updateBytes +=
          ROOT_ENTRY_BYTES +
          pushPlanStringBytes(update.destination) +
          pushPlanStringBytes(update.oldOid);
        tracker.set("update-input", updateBytes);
        continue;
      }
      if (typeof update.source !== "string" || !isOid(update.oid)) {
        throw new GitError("EINVAL", `push update ${index + 1} has a malformed source`);
      }
      if (isOid(update.source)) {
        if (update.source !== update.oid) {
          throw new GitError("EINVAL", `push update ${index + 1} object-id source changed`);
        }
      } else if (
        checkRefText(update.source).problem !== null ||
        !update.source.startsWith("refs/") ||
        !hasCanonicalRefSyntax(update.source)
      ) {
        throw new GitError("EINVALIDREF", `invalid push source ${update.source}`);
      }
      updateBytes +=
        ROOT_ENTRY_BYTES +
        pushPlanStringBytes(update.source) +
        pushPlanStringBytes(update.destination) +
        pushPlanStringBytes(update.oid) +
        pushPlanStringBytes(update.oldOid);
      tracker.set("update-input", updateBytes);
    }
  } finally {
    tracker.clear("validation-destinations");
  }
}
