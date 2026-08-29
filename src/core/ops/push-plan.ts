// Bounded outbound closure and replayable full-object pack generation.

import { MAX_BLOB_BATCH_BYTES } from "../../sqlite/store.js";
import { isOid } from "../bytes.js";
import { CorruptError, GitError, hasErrorCode } from "../errors.js";
import {
  hashObject,
  type ObjectType,
  parseCommit,
  parseTag,
  parseTree,
  type RawObject,
} from "../objects.js";
import { streamFullObjectPack } from "../pack/full-object-stream.js";
import { ZERO_OID } from "../protocol/receive-pack.js";
import { checkRefText, hasCanonicalRefSyntax, MAX_REF_NAME_BYTES } from "../ref-name.js";
import type { Repository } from "../repository.js";
import { comparePaths } from "../streams.js";
import type { PushPlanningUpdate } from "./refspec.js";
import type { TransportOperationBudget } from "./transport-budget.js";

export const MAX_PUSH_COMMITS = 512;
export const MAX_PUSH_OBJECTS = 100_000;
export const MAX_PUSH_PLAN_BYTES = 16 * 1024 * 1024;
export const MAX_PUSH_BRANCH_TARGETS = 1_024;

const PUSH_PLAN_OBJECT_BYTES = 160;
const PUSH_PLAN_FIXED_BYTES = 256;
const OBJECT_PAGE = 4096;
const MAX_TAG_DEPTH = 16;
const MAX_PUSH_UPDATES = MAX_PUSH_BRANCH_TARGETS;
const PUSH_PLAN_MEMORY_PART = "push-plan";
const PUSH_AUTH_MEMORY_PART = "push-plan-auth";
const PUSH_BRANCH_AUTH_MEMORY_PART = "push-branch-target-auth";
const PUSH_BRANCH_AUTH_READ_MEMORY_PART = "push-branch-target-auth-read";
const PUSH_GRAPH_MEMORY_PART = "push-plan-graph";
const PUSH_PACK_PREFLIGHT_MEMORY_PART = "push-pack-preflight";
const PUSH_PACK_FIRST_MEMORY_PART = "push-pack-first-read";
const PUSH_PACK_REPLAY_MEMORY_PART = "push-pack-replay-read";
const CONTAINER_BASE_BYTES = 64;
const ARRAY_SLOT_BYTES = 16;
const SET_ENTRY_BYTES = 96;
const MAP_ENTRY_BYTES = 128;
const ROOT_ENTRY_BYTES = 256;
const TAG_ENTRY_BYTES = 192;
const COMMIT_ENTRY_BYTES = 512;
const COMMIT_PARENT_BYTES = 96;
const PACK_BATCH_ENTRY_BYTES = 192;
const PACK_STREAM_HEADROOM_BYTES = 256 * 1024;
const NO_REMOTE_OIDS: readonly string[] = Object.freeze([]);

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
  readonly maxRetainedBytes?: number;
  readonly remoteOids?: readonly string[];
}

interface PlannedCommit {
  oid: string;
  tree: string;
  parents: readonly string[];
}

interface ResolvedRoot {
  directType: ObjectType;
  finalOid: string;
  finalType: Exclude<ObjectType, "tag">;
  tags: readonly string[];
}

interface AuthenticationState {
  readonly types: Map<string, ObjectType>;
  readonly tags: Map<string, AuthenticatedTagTarget>;
}

interface AuthenticatedTagTarget {
  readonly object: string;
  readonly type: ObjectType;
}

interface PushPlanBudgetState {
  readonly budget: TransportOperationBudget | undefined;
  readonly objects: PushObject[];
  readonly packMemoryBytes: number;
  readonly retainedPeakBytes: number;
  openings: number;
  activeStreams: number;
  disposeRequested: boolean;
  disposed: boolean;
}

interface NormalizedPushPlanOptions {
  readonly maxObjects: number;
  readonly maxCommits: number;
  readonly maxRetainedBytes: number;
  readonly remoteOids: readonly string[];
}

class PushRetainedTracker {
  readonly #parts = new Map<string, number>();
  #total = 0;
  #peak = 0;

  constructor(
    private readonly budget: TransportOperationBudget | undefined,
    private readonly limit: number,
    private readonly memoryPart = PUSH_PLAN_MEMORY_PART,
  ) {}

  get total(): number {
    return this.#total;
  }

  get peak(): number {
    return this.#peak;
  }

  set(part: string, bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new GitError("EINVAL", "push retained byte charge must be a safe nonnegative integer");
    }
    const prior = this.#parts.get(part) ?? 0;
    const next = this.#total - prior + bytes;
    if (!Number.isSafeInteger(next) || next > this.limit) {
      throw new GitError("E2BIG", "push plan exceeds the retained-state limit");
    }
    this.budget?.setMemory(this.memoryPart, next);
    if (bytes === 0) this.#parts.delete(part);
    else this.#parts.set(part, bytes);
    this.#total = next;
    if (next > this.#peak) this.#peak = next;
  }

  transfer(from: string, fromBytes: number, to: string, toBytes: number): void {
    const currentFrom = this.#parts.get(from) ?? 0;
    const currentTo = this.#parts.get(to) ?? 0;
    if (fromBytes > currentFrom) throw new CorruptError("push retained transfer underflow");
    const next = this.#total - currentFrom - currentTo + (currentFrom - fromBytes) + toBytes;
    if (!Number.isSafeInteger(next) || next < 0 || next > this.limit) {
      throw new GitError("E2BIG", "push plan exceeds the retained-state limit");
    }
    this.budget?.setMemory(this.memoryPart, next);
    const nextFrom = currentFrom - fromBytes;
    if (nextFrom === 0) this.#parts.delete(from);
    else this.#parts.set(from, nextFrom);
    if (toBytes === 0) this.#parts.delete(to);
    else this.#parts.set(to, toBytes);
    this.#total = next;
    if (next > this.#peak) this.#peak = next;
  }

  clear(part: string): void {
    this.set(part, 0);
  }

  keepOnly(first: string, second: string): void {
    const firstBytes = this.#parts.get(first) ?? 0;
    const secondBytes = this.#parts.get(second) ?? 0;
    const next = firstBytes + secondBytes;
    this.budget?.setMemory(this.memoryPart, next);
    for (const part of this.#parts.keys()) {
      if (part !== first && part !== second) this.#parts.delete(part);
    }
    this.#total = next;
  }

  clearAll(): void {
    this.budget?.clearMemory(this.memoryPart);
    this.#parts.clear();
    this.#total = 0;
  }
}

const stateByPlan = new WeakMap<PushPlan, PushPlanBudgetState>();

/** Validate the three union-wide closure bounds before retaining the next item. */
function validatePushPlanBounds(
  objectCount: number,
  newCommitCount: number,
  retainedBytes: number,
  limits: NormalizedPushPlanOptions = {
    maxObjects: MAX_PUSH_OBJECTS,
    maxCommits: MAX_PUSH_COMMITS,
    maxRetainedBytes: MAX_PUSH_PLAN_BYTES,
    remoteOids: NO_REMOTE_OIDS,
  },
): void {
  if (
    !Number.isSafeInteger(objectCount) ||
    !Number.isSafeInteger(newCommitCount) ||
    !Number.isSafeInteger(retainedBytes) ||
    objectCount < 0 ||
    newCommitCount < 0 ||
    retainedBytes < 0
  ) {
    throw new GitError("EINVAL", "push plan bounds must be safe nonnegative integers");
  }
  if (objectCount > limits.maxObjects) {
    throw new GitError("E2BIG", `push closure exceeds ${limits.maxObjects} objects`);
  }
  if (newCommitCount > limits.maxCommits) {
    throw new GitError("E2BIG", `push exceeds ${limits.maxCommits} new commits`);
  }
  if (retainedBytes > limits.maxRetainedBytes) {
    throw new GitError("E2BIG", "push plan exceeds the retained-state limit");
  }
}

function normalizedOptions(options: PushPlanOptions): NormalizedPushPlanOptions {
  const requireLimit = (value: number, maximum: number, label: string): void => {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new GitError("EINVAL", `push ${label} limit must be an integer from 1 to ${maximum}`);
    }
  };
  requireLimit(options.maxObjects ?? MAX_PUSH_OBJECTS, MAX_PUSH_OBJECTS, "object");
  requireLimit(options.maxCommits ?? MAX_PUSH_COMMITS, MAX_PUSH_COMMITS, "commit");
  requireLimit(
    options.maxRetainedBytes ?? MAX_PUSH_PLAN_BYTES,
    MAX_PUSH_PLAN_BYTES,
    "retained byte",
  );
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
    maxRetainedBytes: options.maxRetainedBytes ?? MAX_PUSH_PLAN_BYTES,
    remoteOids,
  };
}

function addObject(
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
  validatePushPlanBounds(count, 0, tracker.total, limits);
  tracker.set("object-map", CONTAINER_BASE_BYTES + count * PUSH_PLAN_OBJECT_BYTES);
  objects.set(oid, type);
}

function excludedCommits(
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

function hydrateObjects(
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

function validateAuthenticatedObject(
  oid: string,
  object: RawObject,
): AuthenticatedTagTarget | null {
  if (hashObject(object.type, object.data) !== oid) {
    throw new CorruptError(`local object ${oid} does not match its bytes`);
  }
  if (object.type === "commit") parseCommit(object.data);
  else if (object.type === "tree") parseTree(object.data);
  else if (object.type === "tag") {
    const tag = parseTag(object.data);
    return { object: tag.object, type: tag.type };
  }
  return null;
}

function authenticateObjects(
  repo: Repository,
  oids: readonly string[],
  operationBudget: TransportOperationBudget | undefined,
  state: AuthenticationState,
  tracker: PushRetainedTracker,
  authMemoryPart = PUSH_AUTH_MEMORY_PART,
): void {
  tracker.set("root-auth-input", 2 * CONTAINER_BASE_BYTES + oids.length * 2 * SET_ENTRY_BYTES);
  let remaining = oids.filter((oid) => !state.types.has(oid));
  while (remaining.length > 0) {
    const info = repo.store.objectInfo(remaining);
    let selectedBytes = 0;
    let selected = 0;
    while (selected < info.length) {
      const object = info[selected];
      if (object === undefined) throw new CorruptError("push authentication lost object metadata");
      if (selectedBytes + object.size > MAX_BLOB_BATCH_BYTES) break;
      selectedBytes += object.size;
      selected++;
    }
    if (selected === 0) {
      const objectInfo = info[0];
      const oid = remaining[0];
      if (objectInfo === undefined || oid === undefined || objectInfo.oid !== oid) {
        throw new CorruptError("push authentication lost its oversized object");
      }
      operationBudget?.setMemory(authMemoryPart, objectInfo.size + 256);
      try {
        const object = repo.store.readAuthenticatedObject(oid, objectInfo.type);
        if (object === null) throw new CorruptError(`local push object ${oid} disappeared`);
        const tag = validateAuthenticatedObject(oid, object);
        tracker.set(
          "root-auth-state",
          (state.types.size + 1) * ROOT_ENTRY_BYTES +
            (state.tags.size + (tag === null ? 0 : 1)) * TAG_ENTRY_BYTES,
        );
        state.types.set(oid, object.type);
        if (tag !== null) state.tags.set(oid, tag);
      } finally {
        operationBudget?.clearMemory(authMemoryPart);
      }
      remaining = remaining.slice(1);
      continue;
    }
    operationBudget?.setMemory(authMemoryPart, selectedBytes + selected * 256);
    try {
      const batch = repo.readObjects(remaining, { budgetBytes: MAX_BLOB_BATCH_BYTES });
      if (batch.objects.size !== selected || batch.remaining.length >= remaining.length) {
        throw new CorruptError("push authentication made no progress");
      }
      for (const [oid, object] of batch.objects) {
        const tag = validateAuthenticatedObject(oid, object);
        tracker.set(
          "root-auth-state",
          (state.types.size + 1) * ROOT_ENTRY_BYTES +
            (state.tags.size + (tag === null ? 0 : 1)) * TAG_ENTRY_BYTES,
        );
        state.types.set(oid, object.type);
        if (tag !== null) state.tags.set(oid, tag);
      }
      remaining = batch.remaining;
    } finally {
      operationBudget?.clearMemory(authMemoryPart);
    }
  }
}

/** Hash and parse direct commit targets; callers must omit ZERO_OID deletions. */
export function authenticatePushBranchTargets(
  repo: Repository,
  targetOids: readonly string[],
  operationBudget: TransportOperationBudget,
): void {
  if (!Array.isArray(targetOids)) {
    throw new GitError("EINVAL", "push branch target list must be an array");
  }
  if (targetOids.length > MAX_PUSH_BRANCH_TARGETS) {
    throw new GitError(
      "E2BIG",
      `push branch target list exceeds ${MAX_PUSH_BRANCH_TARGETS} entries`,
    );
  }
  if (
    operationBudget.memory(PUSH_BRANCH_AUTH_MEMORY_PART) !== 0 ||
    operationBudget.memory(PUSH_BRANCH_AUTH_READ_MEMORY_PART) !== 0
  ) {
    throw new GitError("EINVAL", "push branch target authentication is already active");
  }

  const tracker = new PushRetainedTracker(
    operationBudget,
    MAX_PUSH_PLAN_BYTES,
    PUSH_BRANCH_AUTH_MEMORY_PART,
  );
  try {
    tracker.set(
      "target-input",
      2 * CONTAINER_BASE_BYTES + targetOids.length * (ARRAY_SLOT_BYTES + SET_ENTRY_BYTES),
    );
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const oid of targetOids) {
      if (!isOid(oid)) {
        throw new GitError("EINVAL", "push branch target list contains an invalid object id");
      }
      if (oid === ZERO_OID) {
        throw new GitError("EINVAL", "push branch target list must omit the zero object id");
      }
      if (seen.has(oid)) continue;
      seen.add(oid);
      unique.push(oid);
    }

    const state: AuthenticationState = { types: new Map(), tags: new Map() };
    authenticateObjects(
      repo,
      unique,
      operationBudget,
      state,
      tracker,
      PUSH_BRANCH_AUTH_READ_MEMORY_PART,
    );
    for (const oid of unique) {
      if (state.types.get(oid) !== "commit") {
        throw new GitError("EINVALIDREF", `push branch target ${oid} is not a direct commit`);
      }
    }
  } catch (error) {
    localPushError(error);
  } finally {
    operationBudget.clearMemory(PUSH_BRANCH_AUTH_READ_MEMORY_PART);
    tracker.clearAll();
  }
}

function resolveRoots(
  repo: Repository,
  oids: readonly string[],
  operationBudget: TransportOperationBudget | undefined,
  tracker: PushRetainedTracker,
  part: string,
): Map<string, ResolvedRoot> {
  const state: AuthenticationState = { types: new Map(), tags: new Map() };
  try {
    tracker.set("root-frontiers", 3 * CONTAINER_BASE_BYTES + oids.length * 3 * SET_ENTRY_BYTES);
    let frontier = [...new Set(oids)];
    for (let depth = 0; frontier.length > 0 && depth <= MAX_TAG_DEPTH; depth++) {
      authenticateObjects(repo, frontier, operationBudget, state, tracker);
      const next: string[] = [];
      for (const oid of frontier) {
        if (state.types.get(oid) !== "tag") continue;
        const tag = state.tags.get(oid);
        if (tag === undefined) throw new CorruptError(`authenticated tag ${oid} was not parsed`);
        if (!state.types.has(tag.object)) next.push(tag.object);
      }
      frontier = [...new Set(next)];
      if (depth === MAX_TAG_DEPTH && frontier.length > 0) {
        throw new CorruptError("local push tag chain is too deep");
      }
    }

    tracker.set(part, CONTAINER_BASE_BYTES);
    const resolved = new Map<string, ResolvedRoot>();
    for (const oid of oids) {
      const directType = state.types.get(oid);
      if (directType === undefined) throw new CorruptError(`local push object ${oid} disappeared`);
      let current = oid;
      tracker.set("root-chain", 2 * CONTAINER_BASE_BYTES);
      const tags: string[] = [];
      const seen = new Set<string>();
      while (state.types.get(current) === "tag") {
        if (seen.has(current)) throw new CorruptError(`tag chain from ${oid} contains a cycle`);
        tracker.set(
          "root-chain",
          2 * CONTAINER_BASE_BYTES +
            (seen.size + 1) * SET_ENTRY_BYTES +
            (tags.length + 1) * ARRAY_SLOT_BYTES,
        );
        seen.add(current);
        tags.push(current);
        const tag = state.tags.get(current);
        if (tag === undefined)
          throw new CorruptError(`authenticated tag ${current} was not parsed`);
        const targetType = state.types.get(tag.object);
        if (targetType === undefined) {
          throw new CorruptError(`tag ${current} references a missing local object`);
        }
        if (tag.type !== targetType) {
          throw new CorruptError(`tag ${current} declares ${tag.type} but targets ${targetType}`);
        }
        current = tag.object;
      }
      const finalType = state.types.get(current);
      if (finalType === undefined || finalType === "tag") {
        throw new CorruptError(`tag chain from ${oid} has no concrete target`);
      }
      tracker.set(
        part,
        CONTAINER_BASE_BYTES +
          (resolved.size + 1) * ROOT_ENTRY_BYTES +
          (resolvedRootBytes(resolved) - resolved.size * ROOT_ENTRY_BYTES) +
          tags.length * 80,
      );
      resolved.set(oid, { directType, finalOid: current, finalType, tags });
      tracker.clear("root-chain");
    }
    return resolved;
  } finally {
    tracker.clear("root-auth-input");
    tracker.clear("root-auth-state");
    tracker.clear("root-frontiers");
    tracker.clear("root-chain");
  }
}

function packGenerationMemoryBytes(objects: readonly PushObject[]): number {
  if (objects.length === 0) return PACK_STREAM_HEADROOM_BYTES;
  let peak =
    MAX_BLOB_BATCH_BYTES + OBJECT_PAGE * PACK_BATCH_ENTRY_BYTES + PACK_STREAM_HEADROOM_BYTES;
  for (const object of objects) {
    if (object.source !== "pack" || object.size <= MAX_BLOB_BATCH_BYTES) continue;
    const bytes = object.size + PACK_BATCH_ENTRY_BYTES + PACK_STREAM_HEADROOM_BYTES;
    if (!Number.isSafeInteger(bytes)) {
      throw new GitError("E2BIG", "push pack retained memory is not representable");
    }
    if (bytes > peak) peak = bytes;
  }
  return peak;
}

function validatePlanningUpdates(
  updates: readonly PushPlanningUpdate[],
  tracker: PushRetainedTracker,
): void {
  if (!Array.isArray(updates)) throw new GitError("EINVAL", "push updates must be an array");
  if (updates.length === 0) throw new GitError("EINVAL", "push update list must not be empty");
  if (updates.length > MAX_PUSH_UPDATES) {
    throw new GitError("E2BIG", `push update list exceeds ${MAX_PUSH_UPDATES} commands`);
  }
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
        checkRefText(update.destination, MAX_REF_NAME_BYTES).problem !== null ||
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
        checkRefText(update.source, MAX_REF_NAME_BYTES).problem !== null ||
        !update.source.startsWith("refs/") ||
        !hasCanonicalRefSyntax(update.source)
      ) {
        throw new GitError("EINVALIDREF", `invalid push source ${update.source}`);
      }
    }
  } finally {
    tracker.clear("validation-destinations");
  }
}

function sameCommit(left: PlannedCommit, tree: string, parents: readonly string[]): boolean {
  if (left.tree !== tree || left.parents.length !== parents.length) return false;
  for (let index = 0; index < left.parents.length; index++) {
    if (left.parents[index] !== parents[index]) return false;
  }
  return true;
}

function collectCommitGraphs(
  repo: Repository,
  roots: Iterable<string>,
  tracker: PushRetainedTracker,
): Map<string, PlannedCommit> {
  tracker.set("commit-map", CONTAINER_BASE_BYTES);
  const commits = new Map<string, PlannedCommit>();
  let retainedBytes = CONTAINER_BASE_BYTES;
  for (const root of roots) {
    for (const { oid, commit } of repo.walkIndexed(root, { maxBytes: MAX_PUSH_PLAN_BYTES })) {
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
  operationBudget: TransportOperationBudget | undefined,
  tracker: PushRetainedTracker,
): string | null {
  if (commits.has(oldOid)) return oldOid;
  try {
    const old = resolveRoots(repo, [oldOid], operationBudget, tracker, "remote-root").get(oldOid);
    if (old?.finalType !== "commit" || !commits.has(old.finalOid)) return null;
    return old.finalOid;
  } catch (error) {
    if (hasErrorCode(error, "E2BIG")) throw error;
    return null;
  } finally {
    tracker.clear("remote-root");
  }
}

function requireNamespaceKinds(
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

function resolvedRootBytes(roots: ReadonlyMap<string, ResolvedRoot>): number {
  let bytes = 0;
  for (const root of roots.values()) bytes += 256 + root.tags.length * 80;
  return bytes;
}

function requireNamespaceRules(
  repo: Repository,
  updates: readonly PushPlanningUpdate[],
  roots: ReadonlyMap<string, ResolvedRoot>,
  commits: ReadonlyMap<string, PlannedCommit>,
  operationBudget: TransportOperationBudget | undefined,
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
      const boundary = customBoundary(repo, update.oldOid, commits, operationBudget, tracker);
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

function localPushError(error: unknown): never {
  if (
    hasErrorCode(error, "E2BIG") ||
    hasErrorCode(error, "EINVAL") ||
    hasErrorCode(error, "EINVALIDREF") ||
    hasErrorCode(error, "ENONFASTFORWARD") ||
    hasErrorCode(error, "ETAGFAIL")
  ) {
    throw error;
  }
  throw new GitError("EPUSHLOCAL", "local push source or closure is incomplete", { cause: error });
}

function planUpdateSet(
  repo: Repository,
  updates: readonly PushPlanningUpdate[],
  operationBudget: TransportOperationBudget | undefined,
  requestedOptions: PushPlanOptions = {},
): PushPlan | null {
  const options = normalizedOptions(requestedOptions);
  const tracker = new PushRetainedTracker(operationBudget, options.maxRetainedBytes);
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
    tracker.set("verified-refs", CONTAINER_BASE_BYTES + nonDeletes.length * (MAP_ENTRY_BYTES + 80));
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
    const roots = resolveRoots(repo, uniqueSourceOids, operationBudget, tracker, "roots");
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

    // Repository graph-walk state is additive to the separate 16 MiB retained-plan limit.
    operationBudget?.setMemory(PUSH_GRAPH_MEMORY_PART, MAX_PUSH_PLAN_BYTES);
    const shallow = repo.shallow();
    const commits = collectCommitGraphs(repo, commitRootOids, tracker);
    commitRootOids.clear();
    tracker.clear("commit-roots");
    const boundaries = requireNamespaceRules(
      repo,
      ordered,
      roots,
      commits,
      operationBudget,
      tracker,
    );
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
      validatePushPlanBounds(0, wanted.length + 1, tracker.total, options);
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
    operationBudget?.clearMemory(PUSH_GRAPH_MEMORY_PART);
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
    validatePushPlanBounds(hydrated.length, newCommitCount, tracker.total, options);
    ordered.length = 0;
    nonDeletes.length = 0;
    tracker.clear("ordered");
    tracker.clear("non-deletes");
    tracker.set("plan-state", PUSH_PLAN_FIXED_BYTES);
    tracker.keepOnly("hydrated-plan", "plan-state");
    const packMemoryBytes = packGenerationMemoryBytes(hydrated);
    operationBudget?.setMemory(PUSH_PACK_PREFLIGHT_MEMORY_PART, packMemoryBytes);
    operationBudget?.clearMemory(PUSH_PACK_PREFLIGHT_MEMORY_PART);
    const plan: PushPlan = Object.freeze({ newCommits: newCommitCount });
    stateByPlan.set(plan, {
      budget: operationBudget,
      objects: hydrated,
      packMemoryBytes,
      retainedPeakBytes: tracker.peak,
      openings: 0,
      activeStreams: 0,
      disposeRequested: false,
      disposed: false,
    });
    return plan;
  } catch (error) {
    operationBudget?.clearMemory(PUSH_AUTH_MEMORY_PART);
    operationBudget?.clearMemory(PUSH_GRAPH_MEMORY_PART);
    operationBudget?.clearMemory(PUSH_PACK_PREFLIGHT_MEMORY_PART);
    tracker.clearAll();
    return localPushError(error);
  }
}

/** Plan one deterministic object closure for a validated multi-ref push. */
export function planPushUpdates(
  repo: Repository,
  updates: readonly PushPlanningUpdate[],
  operationBudget: TransportOperationBudget,
  options: PushPlanOptions = {},
): PushPlan | null {
  return planUpdateSet(repo, updates, operationBudget, options);
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
    undefined,
    { remoteOids },
  );
  if (plan === null) throw new CorruptError("legacy non-delete push produced no pack plan");
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
  let memoryPart: string | null = null;
  if (state.budget !== undefined) {
    memoryPart = state.openings === 0 ? PUSH_PACK_FIRST_MEMORY_PART : PUSH_PACK_REPLAY_MEMORY_PART;
    state.budget.setMemory(memoryPart, state.packMemoryBytes);
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
    if (memoryPart !== null) state.budget?.clearMemory(memoryPart);
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

function finalizePushPlanDisposal(state: PushPlanBudgetState): void {
  if (state.disposed) return;
  state.objects.length = 0;
  state.budget?.clearMemory(PUSH_PLAN_MEMORY_PART);
  state.disposed = true;
}

function requirePlanState(plan: PushPlan): PushPlanBudgetState {
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

/** Conservative retained-state high-water observed while building the plan. */
export function pushPlanRetainedPeakBytes(plan: PushPlan): number {
  return requirePlanState(plan).retainedPeakBytes;
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
          { budgetBytes: MAX_BLOB_BATCH_BYTES },
        ).objects,
      readChunks: (object) => repo.store.readChunks(object.oid),
    },
    {
      maxObjects: MAX_PUSH_OBJECTS,
      maxInflatedBytes: Number.MAX_SAFE_INTEGER,
      maxStoredBytes: Number.MAX_SAFE_INTEGER,
      readBatchBytes: MAX_BLOB_BATCH_BYTES,
      allowOversizedObject: true,
    },
  );
}
