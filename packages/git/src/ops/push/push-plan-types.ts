import { CorruptError, GitError } from "../../common/errors.js";
import type { ObjectType } from "../../common/objects.js";

export const MAX_PUSH_COMMITS = 512;
export const MAX_PUSH_OBJECTS = 100_000;
export const MAX_PUSH_BRANCH_TARGETS = 1_024;

export const PUSH_PLAN_OBJECT_BYTES = 160;
export const PUSH_PLAN_FIXED_BYTES = 256;
export const OBJECT_PAGE = 4096;
export const MAX_TAG_DEPTH = 16;
export const MAX_PUSH_UPDATES = MAX_PUSH_BRANCH_TARGETS;
// An unbounded push plan otherwise grows with remote size until the isolate OOMs.
const MAX_PUSH_PLAN_BYTES = 64 * 1024 * 1024;

export function pushPlanStringBytes(value: string): number {
  return 48 + value.length * 2;
}
export const CONTAINER_BASE_BYTES = 64;
export const ARRAY_SLOT_BYTES = 16;
export const SET_ENTRY_BYTES = 96;
export const MAP_ENTRY_BYTES = 128;
export const ROOT_ENTRY_BYTES = 256;
export const TAG_ENTRY_BYTES = 192;
export const COMMIT_ENTRY_BYTES = 512;
export const COMMIT_PARENT_BYTES = 96;
export const NO_REMOTE_OIDS: readonly string[] = Object.freeze([]);

export interface PushObject {
  oid: string;
  type: ObjectType;
  size: number;
  source: "loose" | "pack";
}

export interface PushPlan {
  readonly newCommits: number;
}

export interface PushPlanOptions {
  readonly maxObjects?: number;
  readonly maxCommits?: number;
  readonly remoteOids?: readonly string[];
}

export interface PlannedCommit {
  oid: string;
  tree: string;
  parents: readonly string[];
}

export interface ResolvedRoot {
  directType: ObjectType;
  finalOid: string;
  finalType: Exclude<ObjectType, "tag">;
  tags: readonly string[];
}

export interface AuthenticationState {
  readonly types: Map<string, ObjectType>;
  readonly tags: Map<string, AuthenticatedTagTarget>;
}

export interface AuthenticatedTagTarget {
  readonly object: string;
  readonly type: ObjectType;
}

export interface PushPlanState {
  readonly objects: PushObject[];
  openings: number;
  activeStreams: number;
  disposeRequested: boolean;
  disposed: boolean;
}

export interface NormalizedPushPlanOptions {
  readonly maxObjects: number;
  readonly maxCommits: number;
  readonly remoteOids: readonly string[];
}

export class PushRetainedTracker {
  readonly #parts = new Map<string, number>();
  #total = 0;

  get total(): number {
    return this.#total;
  }

  get remainingBytes(): number {
    return MAX_PUSH_PLAN_BYTES - this.#total;
  }

  set(part: string, bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new GitError("EINVAL", "push retained byte charge must be a safe nonnegative integer");
    }
    const prior = this.#parts.get(part) ?? 0;
    const next = this.#total - prior + bytes;
    if (!Number.isSafeInteger(next) || next > MAX_PUSH_PLAN_BYTES) {
      throw new GitError("E2BIG", "push plan exceeds the operation memory limit");
    }
    if (bytes === 0) this.#parts.delete(part);
    else this.#parts.set(part, bytes);
    this.#total = next;
  }

  transfer(from: string, fromBytes: number, to: string, toBytes: number): void {
    const currentFrom = this.#parts.get(from) ?? 0;
    const currentTo = this.#parts.get(to) ?? 0;
    if (fromBytes > currentFrom) throw new CorruptError("push retained transfer underflow");
    const next = this.#total - currentFrom - currentTo + (currentFrom - fromBytes) + toBytes;
    if (!Number.isSafeInteger(next) || next < 0 || next > MAX_PUSH_PLAN_BYTES) {
      throw new GitError("E2BIG", "push plan exceeds the operation memory limit");
    }
    const nextFrom = currentFrom - fromBytes;
    if (nextFrom === 0) this.#parts.delete(from);
    else this.#parts.set(from, nextFrom);
    if (toBytes === 0) this.#parts.delete(to);
    else this.#parts.set(to, toBytes);
    this.#total = next;
  }

  clear(part: string): void {
    this.set(part, 0);
  }

  keepOnly(first: string, second: string): void {
    const firstBytes = this.#parts.get(first) ?? 0;
    const secondBytes = this.#parts.get(second) ?? 0;
    const next = firstBytes + secondBytes;
    for (const part of this.#parts.keys()) {
      if (part !== first && part !== second) this.#parts.delete(part);
    }
    this.#total = next;
  }

  clearAll(): void {
    this.#parts.clear();
    this.#total = 0;
  }
}
