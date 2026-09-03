import { isOid } from "../common/bytes.js";
import { GitError } from "../common/errors.js";
import { comparePaths } from "../common/streams.js";
import {
  type ExpandedPushRefspec,
  MAX_PUSH_LEASES,
  type NormalizedPushLease,
  type PushLeaseExpectation,
} from "./refspec-types.js";
import { malformed, requireFullRef } from "./refspec-validation.js";

function normalizeLeaseDestination(value: string): string {
  const destination = value.startsWith("refs/") ? value : `refs/heads/${value}`;
  requireFullRef(destination, "push lease destination");
  return destination;
}

function pushLeaseExpectation(value: unknown, destination: string): PushLeaseExpectation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw malformed(`push lease for ${destination} must be an expectation object`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 1 || typeof keys[0] !== "string") {
    throw malformed(`push lease for ${destination} must contain exactly one expectation`);
  }
  if (keys[0] === "expected") {
    const expected = Reflect.get(value, "expected");
    if (expected !== null && (typeof expected !== "string" || !isOid(expected))) {
      throw malformed(`push lease for ${destination} expected must be an object id or null`);
    }
    return { expected };
  }
  if (keys[0] === "tracking" && Reflect.get(value, "tracking") === true) {
    return { tracking: true };
  }
  throw malformed(`push lease for ${destination} has an invalid expectation`);
}

/** Validate and bind caller lease keys to one completed destination expansion. */
export function normalizePushLeases(
  value: unknown,
  mappings: readonly ExpandedPushRefspec[],
): readonly NormalizedPushLease[] {
  if (value === undefined) return [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw malformed("push leases must be an object");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_PUSH_LEASES) {
    throw new GitError("E2BIG", `push lease set exceeds ${MAX_PUSH_LEASES} destinations`);
  }
  const destinations = new Set(mappings.map((mapping) => mapping.destination));
  const seen = new Set<string>();
  const leases: NormalizedPushLease[] = [];
  for (const key of keys) {
    if (typeof key !== "string") throw malformed("push lease keys must be strings");
    const destination = normalizeLeaseDestination(key);
    if (seen.has(destination)) {
      throw malformed(`push lease keys collide at destination ${destination}`);
    }
    seen.add(destination);
    if (!destinations.has(destination)) {
      throw malformed(`push lease destination is not used by this push: ${destination}`);
    }
    leases.push({
      destination,
      expectation: pushLeaseExpectation(Reflect.get(value, key), destination),
    });
  }
  leases.sort((left, right) => comparePaths(left.destination, right.destination));
  return leases;
}
