import { CorruptError, hasErrorCode } from "../../common/errors.js";
import type { RemoteRef } from "../../protocol/remote.js";
import type { Repository } from "../repository/repository.js";
import type { ShallowRequest } from "./network-types.js";

const PROTOCOL_UNSHALLOW_DEPTH = 0x7fffffff;

/** A positive depth, deepen, or unshallow moves the boundary and must authenticate it. */
export function requestsBoundary(request: ShallowRequest | undefined): boolean {
  if (request === undefined) return false;
  return request.kind !== "depth" || request.depth > 0;
}

/**
 * Whether every root is wanted even when held. An unproven depth request must
 * renegotiate boundaries even when a prior failed publication already left the
 * advertised tip object complete.
 */
export function wantsHeldRoots(
  request: ShallowRequest | undefined,
  roots: readonly RemoteRef[],
  published: readonly string[],
): boolean {
  if (request === undefined) return false;
  if (request.kind !== "depth") return true;
  if (!(request.depth > 0)) return false;
  if (request.depth !== 1) return true;
  const heads = roots.filter((ref) => ref.name.startsWith("refs/heads/"));
  const boundary = new Set(published);
  return heads.length === 0 || !heads.every((ref) => boundary.has(ref.oid));
}

export function shallowTransfer(request: ShallowRequest | undefined): {
  depth?: number;
  deepenRelative?: true;
} {
  if (request === undefined) return {};
  if (request.kind === "deepen") return { depth: request.deepen, deepenRelative: true };
  if (request.kind === "unshallow") return { depth: PROTOCOL_UNSHALLOW_DEPTH };
  return { depth: request.depth };
}

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
