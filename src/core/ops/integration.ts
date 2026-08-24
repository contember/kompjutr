// Pure content resolution for a bounded three-tree integration plan.

import { MAX_OPERATION_MEMORY_BYTES, type MemoryReservation } from "../../sqlite/memory.js";
import { MAX_BLOB_BATCH_BYTES, PACK_BLOB_CALLER_HEADROOM_BYTES } from "../../sqlite/store.js";
import {
  DEFAULT_TEXT_MERGE_LIMITS,
  estimateTextMergeMemory,
  mergeText,
  type TextMergeOptions,
} from "../diff/xmerge.js";
import { CorruptError, GitError } from "../errors.js";
import { hashObject, MODE_COMMIT, MODE_EXECUTABLE, MODE_FILE, MODE_SYMLINK } from "../objects.js";
import type { Repository } from "../repository.js";
import { comparePaths } from "../streams.js";
import {
  type ConflictStructuralEntry,
  type ContentStructuralEntry,
  classifyIntegrationStructure,
  type IntegrationIdentity,
  type IntegrationStages,
  type StructuralConflictKind,
  type StructuralIntegrationEntry,
} from "./integration-structure.js";
import { treeStream } from "./tree-stream.js";

export const MAX_INTEGRATION_SOURCE_ROWS = 200_000;
export const MAX_INTEGRATION_PLAN_ENTRIES = 1_000;
export const MAX_INTEGRATION_STRUCTURE_BYTES = 4 * 1024 * 1024;
export const MAX_INTEGRATION_PLAN_BYTES = 32 * 1024 * 1024;
export const MAX_INTEGRATION_BLOB_READ_CALLS = 16;
export const MAX_INTEGRATION_TREE_STATEMENTS = 6;
export const MAX_INTEGRATION_STATEMENTS_PER_BLOB_READ = 8;
export const MAX_INTEGRATION_SQL_STATEMENTS =
  MAX_INTEGRATION_TREE_STATEMENTS +
  MAX_INTEGRATION_BLOB_READ_CALLS * MAX_INTEGRATION_STATEMENTS_PER_BLOB_READ;
if (MAX_INTEGRATION_SQL_STATEMENTS >= 1_000) {
  throw new Error("integration SQL model exceeds the operation statement limit");
}
export const MAX_VIRTUAL_ANCESTOR_TREE_STATEMENTS = 10;
export const MAX_VIRTUAL_ANCESTOR_SQL_STATEMENTS =
  MAX_VIRTUAL_ANCESTOR_TREE_STATEMENTS +
  MAX_INTEGRATION_BLOB_READ_CALLS * MAX_INTEGRATION_STATEMENTS_PER_BLOB_READ;
if (MAX_VIRTUAL_ANCESTOR_SQL_STATEMENTS >= 1_000) {
  throw new Error("virtual-ancestor integration SQL model exceeds the operation statement limit");
}

const FIXED_CALLER_BYTES = 16 * 1024;
const STRUCTURAL_ENTRY_BYTES = 768;
const INTEGRATION_ENTRY_BYTES = 512;
const ID_VECTOR_ENTRY_BYTES = 192;
const BLOB_MAP_ENTRY_BYTES = 128;
const EMPTY_BLOB = new Uint8Array();
const BASE_CONFLICT_MARKER_SIZE = 7;

export type IntegrationConflictKind = StructuralConflictKind | "content" | "binary";

export interface CleanIntegrationEntry {
  kind: "clean";
  path: string;
  before: IntegrationIdentity | null;
  result: IntegrationIdentity | null;
  /** Null reuses `result.oid`; bytes name a new content-addressed blob. */
  content: Uint8Array | null;
}

export interface ConflictIntegrationEntry {
  kind: "conflict";
  path: string;
  conflict: IntegrationConflictKind;
  stages: IntegrationStages;
  /** Worktree mode after independently resolving the mode dimension, when defined. */
  resultMode?: string;
  /** Conflict-marker bytes, or the current bytes for a binary conflict. */
  content: Uint8Array | null;
  conflicts?: number;
}

export type IntegrationEntry = CleanIntegrationEntry | ConflictIntegrationEntry;

export interface IntegrationPlan {
  /** A Git-path-ordered delta relative to the current tree. */
  entries: readonly IntegrationEntry[];
  sourceRows: number;
  blobReadCalls: number;
  /** Conservative bytes the caller must reserve while retaining this plan. */
  retainedBytes: number;
  memoryHighWaterBytes: number;
}

export interface IntegrationLimits {
  maxSourceRows?: number;
  maxEntries?: number;
  maxStructureBytes?: number;
  maxPlanBytes?: number;
  maxBlobReadCalls?: number;
}

export interface IntegrationInput {
  baseTreeOid: string | null;
  currentTreeOid: string | null;
  incomingTreeOid: string | null;
  text?: TextMergeOptions;
  limits?: IntegrationLimits;
}

export interface VirtualAncestorIntegrationInput extends IntegrationInput {
  labels: { current: string; incoming: string };
  /** Recursive merge depth. Git adds two marker bytes at every depth; defaults to one. */
  depth?: number;
}

interface ContentCandidate {
  path: string;
  base: IntegrationIdentity | null;
  current: IntegrationIdentity;
  incoming: IntegrationIdentity;
  resultMode: string;
  stages: IntegrationStages;
  forceAddAddConflict: boolean;
}

interface RelocationRequest {
  key: string;
  path: string;
  desired: string;
  side: "current" | "incoming";
  identity: IntegrationIdentity;
}

interface CollisionNamespace {
  occupied: Set<number>;
  blockedByAncestor: boolean;
}

class CollisionTrieNode {
  readonly children = new Map<string, CollisionTrieNode>();
  namespace: CollisionNamespace | null = null;
}

class RelocationAllocator {
  readonly #root = new CollisionTrieNode();
  readonly #namespaces = new Map<string, CollisionNamespace>();
  #retainedBytes = 256;

  constructor(
    requests: readonly RelocationRequest[],
    private readonly maxRetainedBytes: number,
  ) {
    for (const request of requests) this.#add(request.desired);
  }

  get retainedBytes(): number {
    return this.#retainedBytes;
  }

  observe(path: string): void {
    let node = this.#root;
    for (let index = 0; index <= path.length; index++) {
      const namespace = node.namespace;
      if (namespace !== null) {
        const suffix = path.slice(index);
        const ordinal = collisionOrdinal(suffix);
        if (ordinal !== null && !namespace.occupied.has(ordinal)) {
          this.#retain(64);
          namespace.occupied.add(ordinal);
        }
      }
      if (index === path.length) {
        const descendants = node.children.get("/");
        if (descendants !== undefined) this.#blockDescendantNamespaces(descendants);
        return;
      }
      const next = node.children.get(path[index]!);
      if (next === undefined) return;
      node = next;
    }
  }

  allocate(desired: string): string {
    const namespace = this.#namespaces.get(desired);
    if (namespace === undefined) throw new CorruptError("virtual relocation namespace is missing");
    if (namespace.blockedByAncestor) {
      throw new GitError("E2BIG", "virtual relocation path is below an occupied file");
    }
    if (!namespace.occupied.has(-1)) {
      validateRelocationPath(desired);
      this.observe(desired);
      return desired;
    }
    for (let ordinal = 0; ordinal < MAX_INTEGRATION_PLAN_ENTRIES - 1; ordinal++) {
      if (namespace.occupied.has(ordinal)) continue;
      const allocated = `${desired}_${ordinal}`;
      validateRelocationPath(allocated);
      this.observe(allocated);
      return allocated;
    }
    throw new GitError("E2BIG", "virtual relocation suffix space is exhausted");
  }

  #add(desired: string): void {
    if (this.#namespaces.has(desired)) return;
    const namespace: CollisionNamespace = { occupied: new Set(), blockedByAncestor: false };
    this.#retain(256 + desired.length * 2);
    this.#namespaces.set(desired, namespace);
    let node = this.#root;
    for (let index = 0; index < desired.length; index++) {
      const unit = desired[index]!;
      let next = node.children.get(unit);
      if (next === undefined) {
        this.#retain(128);
        next = new CollisionTrieNode();
        node.children.set(unit, next);
      }
      node = next;
    }
    node.namespace = namespace;
  }

  #blockDescendantNamespaces(root: CollisionTrieNode): void {
    const pending = [root];
    while (pending.length > 0) {
      const node = pending.pop();
      if (node === undefined) throw new CorruptError("virtual relocation trie is inconsistent");
      if (node.namespace !== null) node.namespace.blockedByAncestor = true;
      for (const child of node.children.values()) pending.push(child);
    }
  }

  #retain(bytes: number): void {
    if (bytes > this.maxRetainedBytes - this.#retainedBytes) {
      throw new GitError(
        "E2BIG",
        `virtual relocation state exceeds ${this.maxRetainedBytes} retained bytes`,
      );
    }
    this.#retainedBytes += bytes;
  }
}

function collisionOrdinal(suffix: string): number | null {
  if (suffix === "" || suffix.startsWith("/")) return -1;
  if (!suffix.startsWith("_") || suffix.length === 1) return null;
  const separator = suffix.indexOf("/", 1);
  const digits = suffix.slice(1, separator < 0 ? undefined : separator);
  if (digits.length === 0) return null;
  if (digits.length > 1 && digits.startsWith("0")) return null;
  for (const digit of digits) {
    if (digit < "0" || digit > "9") return null;
  }
  const ordinal = Number(digits);
  return Number.isSafeInteger(ordinal) && ordinal >= 0 ? ordinal : null;
}

function validateVirtualLabel(label: string, role: string): void {
  if (label.length > 256) throw new GitError("E2BIG", `virtual ${role} label exceeds 256 bytes`);
  const bytes = new TextEncoder().encode(label).length;
  if (label.length === 0 || label.includes("/") || label.includes("\0")) {
    throw new GitError("EINVAL", `virtual ${role} label is not a safe path segment`);
  }
  if (bytes > 256) throw new GitError("E2BIG", `virtual ${role} label exceeds 256 bytes`);
}

function virtualMarkerSize(depth: number | undefined): number {
  const resolved = depth ?? 1;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new GitError("EINVAL", "virtual integration depth must be a non-negative safe integer");
  }
  const markerSize = BASE_CONFLICT_MARKER_SIZE + resolved * 2;
  if (markerSize > DEFAULT_TEXT_MERGE_LIMITS.maxMarkerSize) {
    throw new GitError("E2BIG", "virtual integration depth exceeds the marker-size limit");
  }
  return markerSize;
}

function validateRelocationPath(path: string): void {
  if (new TextEncoder().encode(path).length > 2_200) {
    throw new GitError("E2BIG", "virtual relocation path exceeds 2200 bytes");
  }
}

function relocationKey(path: string, side: "current" | "incoming"): string {
  return `${path}\0${side}`;
}

function modeRank(mode: string): number {
  if (mode === MODE_FILE) return 1;
  if (mode === MODE_EXECUTABLE) return 2;
  if (mode === MODE_SYMLINK) return 3;
  if (mode === MODE_COMMIT) return 4;
  throw new CorruptError(`virtual integration has invalid mode ${mode}`);
}

function isDescendant(path: string, parent: string): boolean {
  return path.length > parent.length && path.startsWith(parent) && path[parent.length] === "/";
}

function relocationRequests(
  entries: readonly StructuralIntegrationEntry[],
  labels: { current: string; incoming: string },
): RelocationRequest[] {
  const requests: RelocationRequest[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry?.kind !== "conflict") continue;
    const current = entry.stages.current;
    const incoming = entry.stages.incoming;
    if (entry.conflict === "file/directory") {
      const next = entries[index + 1];
      if (next === undefined || !isDescendant(next.path, entry.path)) continue;
      if (current !== null && incoming === null) {
        validateRelocationPath(`${entry.path}~${labels.current}`);
        requests.push({
          key: relocationKey(entry.path, "current"),
          path: entry.path,
          desired: `${entry.path}~${labels.current}`,
          side: "current",
          identity: current,
        });
      } else if (incoming !== null && current === null) {
        validateRelocationPath(`${entry.path}~${labels.incoming}`);
        requests.push({
          key: relocationKey(entry.path, "incoming"),
          path: entry.path,
          desired: `${entry.path}~${labels.incoming}`,
          side: "incoming",
          identity: incoming,
        });
      }
      continue;
    }
    if (
      current === null ||
      incoming === null ||
      current.mode === incoming.mode ||
      (isRegularMode(current.mode) && isRegularMode(incoming.mode))
    ) {
      continue;
    }
    if (
      entry.conflict !== "add/add" &&
      entry.conflict !== "symlink" &&
      entry.conflict !== "gitlink"
    ) {
      continue;
    }
    const side = modeRank(current.mode) < modeRank(incoming.mode) ? "current" : "incoming";
    const identity = side === "current" ? current : incoming;
    const label = side === "current" ? labels.current : labels.incoming;
    validateRelocationPath(`${entry.path}~${label}`);
    requests.push({
      key: relocationKey(entry.path, side),
      path: entry.path,
      desired: `${entry.path}~${label}`,
      side,
      identity,
    });
  }
  return requests;
}

function allocateRelocations(
  repo: Repository,
  input: VirtualAncestorIntegrationInput,
  requests: readonly RelocationRequest[],
  limits: ResolvedIntegrationLimits,
): { names: Map<string, string>; retainedBytes: number } {
  if (requests.length === 0) return { names: new Map(), retainedBytes: 0 };
  const allocator = new RelocationAllocator(requests, limits.maxStructureBytes);
  let rows = 0;
  for (const treeOid of [input.currentTreeOid, input.incomingTreeOid]) {
    for (const entry of treeStream(repo, treeOid)) {
      if (rows >= limits.maxSourceRows * 2) {
        throw new GitError("E2BIG", "virtual relocation scan exceeds its source row limit");
      }
      rows++;
      allocator.observe(entry.path);
    }
  }
  const names = new Map<string, string>();
  for (const request of requests) names.set(request.key, allocator.allocate(request.desired));
  return { names, retainedBytes: allocator.retainedBytes };
}

interface ResolvedIntegrationLimits {
  maxSourceRows: number;
  maxEntries: number;
  maxStructureBytes: number;
  maxPlanBytes: number;
  maxBlobReadCalls: number;
}

function boundedLimit(value: number | undefined, ceiling: number, label: string): number {
  if (value === undefined) return ceiling;
  if (!Number.isSafeInteger(value) || value < 0 || value > ceiling) {
    throw new RangeError(`invalid integration ${label} limit`);
  }
  return value;
}

function resolveLimits(limits: IntegrationLimits | undefined): ResolvedIntegrationLimits {
  return {
    maxSourceRows: boundedLimit(limits?.maxSourceRows, MAX_INTEGRATION_SOURCE_ROWS, "source row"),
    maxEntries: boundedLimit(limits?.maxEntries, MAX_INTEGRATION_PLAN_ENTRIES, "entry"),
    maxStructureBytes: boundedLimit(
      limits?.maxStructureBytes,
      MAX_INTEGRATION_STRUCTURE_BYTES,
      "structure byte",
    ),
    maxPlanBytes: boundedLimit(limits?.maxPlanBytes, MAX_INTEGRATION_PLAN_BYTES, "plan byte"),
    maxBlobReadCalls: boundedLimit(
      limits?.maxBlobReadCalls,
      MAX_INTEGRATION_BLOB_READ_CALLS,
      "blob read call",
    ),
  };
}

function checkedAdd(left: number, right: number, label: string): number {
  if (
    !Number.isSafeInteger(left) ||
    !Number.isSafeInteger(right) ||
    right > Number.MAX_SAFE_INTEGER - left
  ) {
    throw new GitError("E2BIG", `integration ${label} accounting overflow`);
  }
  return left + right;
}

function pathBytes(path: string): number {
  return checkedAdd(64, path.length * 2, "path");
}

function structuralEntryBytes(entry: StructuralIntegrationEntry): number {
  return checkedAdd(STRUCTURAL_ENTRY_BYTES, pathBytes(entry.path), "structure");
}

function integrationEntryBytes(entry: IntegrationEntry): number {
  const contentBytes = entry.content?.length ?? 0;
  return checkedAdd(
    checkedAdd(INTEGRATION_ENTRY_BYTES, pathBytes(entry.path), "plan"),
    contentBytes,
    "plan",
  );
}

function integrationEntryOverhead(path: string): number {
  return checkedAdd(INTEGRATION_ENTRY_BYTES, pathBytes(path), "plan entry");
}

function remainingContentCapacity(
  maxPlanBytes: number,
  passthroughBytes: number,
  resolvedBytes: number,
  path: string,
): number {
  const retained = checkedAdd(passthroughBytes, resolvedBytes, "plan");
  const overhead = integrationEntryOverhead(path);
  if (retained > maxPlanBytes || overhead > maxPlanBytes - retained) {
    throw new GitError("E2BIG", `integration plan exceeds ${maxPlanBytes} retained bytes`);
  }
  return maxPlanBytes - retained - overhead;
}

function boundTextOutput(text: TextMergeOptions, maxOutputBytes: number): TextMergeOptions {
  const requested = text.limits?.maxOutputBytes;
  if (requested !== undefined) {
    if (!Number.isSafeInteger(requested) || requested < 0) {
      throw new GitError("EINVAL", "text merge maxOutputBytes must be a non-negative safe integer");
    }
    if (requested > DEFAULT_TEXT_MERGE_LIMITS.maxOutputBytes) {
      throw new GitError(
        "EINVAL",
        `text merge maxOutputBytes exceeds its hard ceiling of ${DEFAULT_TEXT_MERGE_LIMITS.maxOutputBytes}`,
      );
    }
  }
  return {
    ...text,
    limits: {
      ...text.limits,
      maxOutputBytes: Math.min(
        requested ?? DEFAULT_TEXT_MERGE_LIMITS.maxOutputBytes,
        maxOutputBytes,
      ),
    },
  };
}

function stableIdentityVector(entries: readonly ContentCandidate[]): string[] {
  const seen = new Set<string>();
  const oids: string[] = [];
  for (const entry of entries) {
    const identities =
      entry.base === null
        ? [entry.current, entry.incoming]
        : [entry.base, entry.current, entry.incoming];
    for (const identity of identities) {
      const oid = identity.oid;
      if (seen.has(oid)) continue;
      seen.add(oid);
      oids.push(oid);
    }
  }
  return oids;
}

function identityUseCounts(entries: readonly ContentCandidate[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    for (const oid of new Set(candidateOids(entry))) {
      counts.set(oid, (counts.get(oid) ?? 0) + 1);
    }
  }
  return counts;
}

function candidateOids(entry: ContentCandidate): readonly string[] {
  return entry.base === null
    ? [entry.current.oid, entry.incoming.oid]
    : [entry.base.oid, entry.current.oid, entry.incoming.oid];
}

function callerRetainedBytes(
  staticBytes: number,
  resolvedBytes: number,
  loaded: ReadonlyMap<string, Uint8Array>,
): number {
  let bytes = checkedAdd(staticBytes, resolvedBytes, "caller state");
  for (const blob of loaded.values()) {
    bytes = checkedAdd(bytes, BLOB_MAP_ENTRY_BYTES + blob.length, "caller state");
  }
  return bytes;
}

function requireCallerHeadroom(bytes: number): void {
  if (bytes > PACK_BLOB_CALLER_HEADROOM_BYTES) {
    throw new GitError(
      "E2BIG",
      `integration caller state exceeds the ${PACK_BLOB_CALLER_HEADROOM_BYTES}-byte packed-read headroom`,
    );
  }
}

function validateBlobBatch(
  requested: readonly string[],
  blobs: ReadonlyMap<string, Uint8Array>,
  remaining: readonly string[],
  reportedBytes: number,
): void {
  const returned = [...blobs.keys()];
  if (returned.length === 0 || returned.length + remaining.length !== requested.length) {
    throw new CorruptError("blob batch returned an invalid prefix length");
  }
  let bytes = 0;
  for (let index = 0; index < returned.length; index++) {
    const oid = returned[index]!;
    if (oid !== requested[index]) throw new CorruptError("blob batch returned reordered objects");
    const data = blobs.get(oid);
    if (data === undefined || hashObject("blob", data) !== oid) {
      throw new CorruptError(`blob ${oid} did not match its object id`);
    }
    bytes = checkedAdd(bytes, data.length, "blob batch");
  }
  for (let index = 0; index < remaining.length; index++) {
    if (remaining[index] !== requested[index + returned.length]) {
      throw new CorruptError("blob batch returned invalid remaining objects");
    }
  }
  if (bytes !== reportedBytes) throw new CorruptError("blob batch returned an invalid byte count");
}

function passThroughEntry(entry: StructuralIntegrationEntry): IntegrationEntry {
  if (entry.kind === "content") {
    throw new CorruptError("unresolved integration content escaped the content phase");
  }
  if (entry.kind === "clean") {
    return { ...entry, content: null };
  }
  return { ...entry, content: null };
}

function isRegularMode(mode: string): boolean {
  return mode === MODE_FILE || mode === MODE_EXECUTABLE;
}

function ordinaryContentCandidate(entry: ContentStructuralEntry): ContentCandidate {
  return {
    path: entry.path,
    base: entry.base,
    current: entry.current,
    incoming: entry.incoming,
    resultMode: entry.resultMode,
    stages: { base: entry.base, current: entry.current, incoming: entry.incoming },
    forceAddAddConflict: false,
  };
}

function virtualAddAddCandidate(entry: ConflictStructuralEntry): ContentCandidate | null {
  const current = entry.stages.current;
  const incoming = entry.stages.incoming;
  if (
    entry.conflict !== "add/add" ||
    current === null ||
    incoming === null ||
    !isRegularMode(current.mode) ||
    !isRegularMode(incoming.mode)
  ) {
    return null;
  }
  return {
    path: entry.path,
    base: null,
    current,
    incoming,
    resultMode: current.mode,
    stages: entry.stages,
    forceAddAddConflict: current.mode !== incoming.mode,
  };
}

function cleanIdentity(
  path: string,
  before: IntegrationIdentity | null,
  result: IntegrationIdentity | null,
): CleanIntegrationEntry | null {
  if (
    before?.mode === result?.mode &&
    before?.oid === result?.oid &&
    (before !== null || result !== null)
  ) {
    return null;
  }
  return { kind: "clean", path, before, result, content: null };
}

function relocatedEntry(
  request: RelocationRequest,
  names: ReadonlyMap<string, string>,
): CleanIntegrationEntry {
  const path = names.get(request.key);
  if (path === undefined) throw new CorruptError("virtual relocation path is missing");
  return { kind: "clean", path, before: null, result: request.identity, content: null };
}

function collapseVirtualConflict(
  entry: ConflictStructuralEntry,
  requests: ReadonlyMap<string, RelocationRequest>,
  names: ReadonlyMap<string, string>,
): CleanIntegrationEntry[] {
  const current = entry.stages.current;
  const incoming = entry.stages.incoming;
  const currentRequest = requests.get(relocationKey(entry.path, "current"));
  const incomingRequest = requests.get(relocationKey(entry.path, "incoming"));
  const request = currentRequest ?? incomingRequest;
  if (request !== undefined) {
    const result: CleanIntegrationEntry[] = [];
    if (request.side === "current") {
      const original = cleanIdentity(entry.path, current, incoming);
      if (original !== null) result.push(original);
    }
    if (request.side === "incoming" && current !== null && incoming !== null) {
      const original = cleanIdentity(entry.path, current, current);
      if (original !== null) result.push(original);
    } else if (request.side === "incoming" && current === null && incoming !== null) {
      // The original path is occupied by the current directory and remains implicit.
    }
    result.push(relocatedEntry(request, names));
    return result;
  }
  if (entry.conflict === "file/directory") {
    const clean = cleanIdentity(entry.path, current, current ?? incoming);
    return clean === null ? [] : [clean];
  }
  if (entry.conflict === "modify/delete") {
    const modified = current ?? incoming;
    const clean = cleanIdentity(entry.path, current, modified);
    return clean === null ? [] : [clean];
  }
  // Git keeps the current side for unresolved modes, symlinks and gitlinks.
  const clean = cleanIdentity(entry.path, current, current ?? incoming);
  return clean === null ? [] : [clean];
}

function resolveContentCandidate(
  entry: ContentCandidate,
  loaded: ReadonlyMap<string, Uint8Array>,
  text: TextMergeOptions,
  reservation: MemoryReservation,
  retainedBytes: number,
  maxContentBytes: number,
  virtualAncestor: boolean,
): IntegrationEntry {
  const base = entry.base === null ? EMPTY_BLOB : loaded.get(entry.base.oid);
  const current = loaded.get(entry.current.oid);
  const incoming = loaded.get(entry.incoming.oid);
  if (base === undefined || current === undefined || incoming === undefined) {
    throw new CorruptError("integration blob batch omitted a required candidate object");
  }
  const boundedText = boundTextOutput(text, maxContentBytes);
  const memory = estimateTextMergeMemory(base, current, incoming, boundedText);
  reservation.set("other", checkedAdd(retainedBytes, memory.peakBytes, "memory"));
  const merged = mergeText(base, current, incoming, boundedText);
  const stages = entry.stages;
  if (merged.kind === "binary") {
    if (current.length > maxContentBytes) {
      throw new GitError("E2BIG", `integration plan exceeds its retained content capacity`);
    }
    if (!virtualAncestor) {
      return {
        kind: "conflict",
        path: entry.path,
        conflict: "binary",
        stages,
        resultMode: entry.resultMode,
        content: current,
      };
    }
    return {
      kind: "clean",
      path: entry.path,
      before: entry.current,
      result: { mode: entry.resultMode, oid: entry.current.oid },
      content: current,
    };
  }
  if (merged.kind === "conflict") {
    if (virtualAncestor) {
      return {
        kind: "clean",
        path: entry.path,
        before: entry.current,
        result: { mode: entry.resultMode, oid: hashObject("blob", merged.content) },
        content: merged.content,
      };
    }
    return {
      kind: "conflict",
      path: entry.path,
      conflict: "content",
      stages,
      resultMode: entry.resultMode,
      content: merged.content,
      conflicts: merged.conflicts,
    };
  }
  if (!virtualAncestor && entry.forceAddAddConflict) {
    return {
      kind: "conflict",
      path: entry.path,
      conflict: "add/add",
      stages,
      resultMode: entry.resultMode,
      content: merged.content,
    };
  }
  return {
    kind: "clean",
    path: entry.path,
    before: entry.current,
    result: { mode: entry.resultMode, oid: hashObject("blob", merged.content) },
    content: merged.content,
  };
}

/** Build a deterministic integration delta without mutating repository state. */
export function planIntegration(repo: Repository, input: IntegrationInput): IntegrationPlan {
  return planIntegrationInternal(repo, input, null);
}

/** Collapse conflicts the way Git builds a temporary recursive merge-base tree. */
export function planVirtualAncestorIntegration(
  repo: Repository,
  input: VirtualAncestorIntegrationInput,
): IntegrationPlan {
  validateVirtualLabel(input.labels.current, "current");
  validateVirtualLabel(input.labels.incoming, "incoming");
  const markerSize = virtualMarkerSize(input.depth);
  if (input.text?.markerSize !== undefined && input.text.markerSize !== markerSize) {
    throw new GitError("EINVAL", "virtual integration marker size does not match its depth");
  }
  return planIntegrationInternal(
    repo,
    {
      ...input,
      text: {
        ...input.text,
        labels: {
          ...input.text?.labels,
          current: input.labels.current,
          incoming: input.labels.incoming,
        },
        markerSize,
      },
    },
    input.labels,
  );
}

function planIntegrationInternal(
  repo: Repository,
  input: IntegrationInput,
  virtualLabels: { current: string; incoming: string } | null,
): IntegrationPlan {
  const reservation = repo.store.reserveMemory();
  try {
    // Exclude yielded pack ingest before opening any tree cursor or retaining plan state.
    reservation.set("other", MAX_OPERATION_MEMORY_BYTES);
    const limits = resolveLimits(input.limits);
    const structure = classifyIntegrationStructure(repo, {
      baseTreeOid: input.baseTreeOid,
      currentTreeOid: input.currentTreeOid,
      incomingTreeOid: input.incomingTreeOid,
      limits: {
        maxRows: limits.maxSourceRows,
        maxEntries: limits.maxEntries,
        maxRetainedBytes: limits.maxStructureBytes,
      },
    });
    const candidates: ContentCandidate[] = [];
    for (const entry of structure.entries) {
      if (entry.kind === "content") {
        candidates.push(ordinaryContentCandidate(entry));
        continue;
      }
      if (entry.kind === "conflict") {
        const candidate = virtualAddAddCandidate(entry);
        if (candidate !== null) candidates.push(candidate);
      }
    }
    const candidatePaths = new Set(candidates.map((candidate) => candidate.path));
    const relocationList =
      virtualLabels === null ? [] : relocationRequests(structure.entries, virtualLabels);
    const relocations =
      virtualLabels === null
        ? { names: new Map<string, string>(), retainedBytes: 0 }
        : allocateRelocations(repo, { ...input, labels: virtualLabels }, relocationList, limits);
    const relocationByKey = new Map(relocationList.map((request) => [request.key, request]));
    const requestedOids = stableIdentityVector(candidates);
    const remainingUses = identityUseCounts(candidates);
    let staticBytes = FIXED_CALLER_BYTES;
    for (const entry of structure.entries) {
      staticBytes = checkedAdd(staticBytes, structuralEntryBytes(entry), "structure");
    }
    staticBytes = checkedAdd(
      staticBytes,
      (structure.entries.length + candidates.length + requestedOids.length * 3) *
        ID_VECTOR_ENTRY_BYTES,
      "identity vectors",
    );
    staticBytes = checkedAdd(staticBytes, relocations.retainedBytes, "virtual relocations");
    for (const request of relocationList) {
      const allocated = relocations.names.get(request.key);
      if (allocated === undefined) throw new CorruptError("virtual relocation path is missing");
      staticBytes = checkedAdd(
        staticBytes,
        checkedAdd(
          INTEGRATION_ENTRY_BYTES,
          checkedAdd(pathBytes(request.key), pathBytes(request.desired), "virtual relocation"),
          "virtual relocation",
        ),
        "virtual relocations",
      );
      staticBytes = checkedAdd(
        staticBytes,
        checkedAdd(ID_VECTOR_ENTRY_BYTES, pathBytes(allocated), "virtual relocation map"),
        "virtual relocation map",
      );
    }

    const resolved = new Map<string, IntegrationEntry>();
    const loaded = new Map<string, Uint8Array>();
    const staticEntries: IntegrationEntry[] = [];
    let passthroughBytes = 0;
    for (const entry of structure.entries) {
      if (candidatePaths.has(entry.path)) continue;
      const entries =
        virtualLabels !== null && entry.kind === "conflict"
          ? collapseVirtualConflict(entry, relocationByKey, relocations.names)
          : [passThroughEntry(entry)];
      for (const planned of entries) {
        staticEntries.push(planned);
        passthroughBytes = checkedAdd(passthroughBytes, integrationEntryBytes(planned), "plan");
      }
    }
    if (staticEntries.length + candidates.length > limits.maxEntries) {
      throw new GitError("E2BIG", `integration plan exceeds ${limits.maxEntries} entries`);
    }
    if (passthroughBytes > limits.maxPlanBytes) {
      throw new GitError("E2BIG", `integration plan exceeds ${limits.maxPlanBytes} retained bytes`);
    }
    staticBytes = checkedAdd(staticBytes, passthroughBytes, "static plan");
    staticBytes = checkedAdd(
      staticBytes,
      staticEntries.length * ID_VECTOR_ENTRY_BYTES,
      "static plan vector",
    );
    requireCallerHeadroom(staticBytes);

    let resolvedBytes = 0;
    let remaining = requestedOids;
    let nextCandidate = 0;
    let blobReadCalls = 0;
    reservation.set("other", callerRetainedBytes(staticBytes, resolvedBytes, loaded));
    while (nextCandidate < candidates.length) {
      const candidate = candidates[nextCandidate]!;
      const ready = candidateOids(candidate).every((oid) => loaded.has(oid));
      if (!ready) {
        if (remaining.length === 0) {
          throw new CorruptError("integration blob batches ended before all candidates resolved");
        }
        if (blobReadCalls >= limits.maxBlobReadCalls) {
          throw new GitError(
            "E2BIG",
            `integration exceeds ${limits.maxBlobReadCalls} blob read calls`,
          );
        }
        const beforeRead = callerRetainedBytes(staticBytes, resolvedBytes, loaded);
        requireCallerHeadroom(beforeRead);
        const mapHeadroom = Math.min(remaining.length, 4096) * BLOB_MAP_ENTRY_BYTES;
        const available = PACK_BLOB_CALLER_HEADROOM_BYTES - beforeRead - mapHeadroom;
        if (available <= 0) {
          throw new GitError("E2BIG", "integration has no caller headroom for another blob batch");
        }
        const budgetBytes = Math.min(MAX_BLOB_BATCH_BYTES, available);
        reservation.set("other", MAX_OPERATION_MEMORY_BYTES);
        const batch = repo.readBlobs(remaining, { budgetBytes });
        blobReadCalls++;
        validateBlobBatch(remaining, batch.blobs, batch.remaining, batch.bytes);
        for (const [oid, data] of batch.blobs) loaded.set(oid, data);
        remaining = batch.remaining;
        const afterRead = callerRetainedBytes(staticBytes, resolvedBytes, loaded);
        requireCallerHeadroom(afterRead);
        reservation.set("other", afterRead);
        continue;
      }

      const retained = callerRetainedBytes(staticBytes, resolvedBytes, loaded);
      const maxContentBytes = remainingContentCapacity(
        limits.maxPlanBytes,
        passthroughBytes,
        resolvedBytes,
        candidate.path,
      );
      const result = resolveContentCandidate(
        candidate,
        loaded,
        input.text ?? {},
        reservation,
        retained,
        maxContentBytes,
        virtualLabels !== null,
      );
      const entryBytes = integrationEntryBytes(result);
      const nextPlanBytes = checkedAdd(
        checkedAdd(passthroughBytes, resolvedBytes, "plan"),
        entryBytes,
        "plan",
      );
      if (nextPlanBytes > limits.maxPlanBytes) {
        throw new GitError(
          "E2BIG",
          `integration plan exceeds ${limits.maxPlanBytes} retained bytes`,
        );
      }
      resolved.set(candidate.path, result);
      resolvedBytes = checkedAdd(resolvedBytes, entryBytes, "resolved plan");
      for (const oid of new Set(candidateOids(candidate))) {
        const uses = remainingUses.get(oid);
        if (uses === undefined || uses <= 0) {
          throw new CorruptError("integration blob use accounting is inconsistent");
        }
        if (uses === 1) {
          remainingUses.delete(oid);
          loaded.delete(oid);
        } else {
          remainingUses.set(oid, uses - 1);
        }
      }
      nextCandidate++;
      reservation.set("other", callerRetainedBytes(staticBytes, resolvedBytes, loaded));
    }

    if (remaining.length !== 0 || loaded.size !== 0 || remainingUses.size !== 0) {
      throw new CorruptError("integration content phase retained unconsumed blob objects");
    }
    const finalArrayBytes = (staticEntries.length + resolved.size) * ID_VECTOR_ENTRY_BYTES;
    const finalPeak = checkedAdd(
      callerRetainedBytes(staticBytes, resolvedBytes, loaded),
      finalArrayBytes,
      "final plan",
    );
    reservation.set("other", finalPeak);
    const entries = [...staticEntries, ...resolved.values()].sort((left, right) =>
      comparePaths(left.path, right.path),
    );
    return {
      entries,
      sourceRows: structure.sourceRows,
      blobReadCalls,
      retainedBytes: finalPeak,
      memoryHighWaterBytes: reservation.highWaterBytes,
    };
  } finally {
    reservation.dispose();
  }
}
