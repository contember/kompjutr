import { CorruptError, hasErrorCode } from "../../common/errors.js";
import type { Repository } from "../repository/repository.js";

export function applyShallowResponse(
  boundary: Set<string>,
  source: { shallow: readonly string[]; unshallow: readonly string[] },
): void {
  for (const oid of source.unshallow) boundary.delete(oid);
  for (const oid of source.shallow) boundary.add(oid);
}

export function shallowMutation(
  baseline: readonly string[],
  proposed: ReadonlySet<string>,
): { add: string[]; remove: string[] } {
  const captured = new Set(baseline);
  return {
    add: [...proposed].filter((oid) => !captured.has(oid)),
    remove: baseline.filter((oid) => !proposed.has(oid)),
  };
}

export function authenticateShallowTransition(
  repo: Repository,
  captured: readonly string[],
  proposed: ReadonlySet<string>,
  fetchedRoots: Iterable<string>,
): void {
  const capturedSet = new Set(captured);
  const removed = captured.filter((oid) => !proposed.has(oid));
  const roots = new Set([...fetchedRoots, ...removed]);
  let reachable: Set<string>;
  try {
    reachable = repo.authenticateCommitGraphThroughBoundary(roots, proposed);
  } catch (error) {
    if (hasErrorCode(error, "ENOTFOUND")) {
      throw new CorruptError("shallow transition references a missing commit", { cause: error });
    }
    throw error;
  }
  for (const oid of proposed) {
    if (!capturedSet.has(oid) && !reachable.has(oid)) {
      throw new CorruptError(`shallow boundary ${oid} is not reachable from the fetched graph`);
    }
  }
}
