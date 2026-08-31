// Pure content resolution for a bounded three-tree integration plan.

import { PACK_BLOB_BATCH_TARGET_BYTES } from "../../sqlite/store.js";
import { DEFAULT_TEXT_MERGE_LIMITS, mergeText, type TextMergeOptions } from "../diff/xmerge.js";
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

const INTEGRATION_ENTRY_BYTES = 512;
const BLOB_READ_PAGE = 4_096;
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
}

export interface IntegrationLimits {
  maxSourceRows?: number;
  maxEntries?: number;
  maxStructureBytes?: number;
  maxPlanBytes?: number;
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

  constructor(requests: readonly RelocationRequest[]) {
    for (const request of requests) this.#add(request.desired);
  }

  observe(path: string): void {
    let node = this.#root;
    for (let index = 0; index <= path.length; index++) {
      const namespace = node.namespace;
      if (namespace !== null) {
        const suffix = path.slice(index);
        const ordinal = collisionOrdinal(suffix);
        if (ordinal !== null && !namespace.occupied.has(ordinal)) {
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
      this.observe(desired);
      return desired;
    }
    for (let ordinal = 0; ordinal < MAX_INTEGRATION_PLAN_ENTRIES - 1; ordinal++) {
      if (namespace.occupied.has(ordinal)) continue;
      const allocated = `${desired}_${ordinal}`;
      this.observe(allocated);
      return allocated;
    }
    throw new GitError("E2BIG", "virtual relocation suffix space is exhausted");
  }

  #add(desired: string): void {
    if (this.#namespaces.has(desired)) return;
    const namespace: CollisionNamespace = { occupied: new Set(), blockedByAncestor: false };
    this.#namespaces.set(desired, namespace);
    let node = this.#root;
    for (let index = 0; index < desired.length; index++) {
      const unit = desired[index]!;
      let next = node.children.get(unit);
      if (next === undefined) {
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
  if (label.length === 0 || label.includes("/") || label.includes("\0")) {
    throw new GitError("EINVAL", `virtual ${role} label is not a safe path segment`);
  }
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

function visitRelocationRequests(
  entries: readonly StructuralIntegrationEntry[],
  labels: { current: string; incoming: string },
  visit: (
    path: string,
    side: "current" | "incoming",
    label: string,
    identity: IntegrationIdentity,
  ) => void,
): void {
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry?.kind !== "conflict") continue;
    const current = entry.stages.current;
    const incoming = entry.stages.incoming;
    if (entry.conflict === "file/directory") {
      const next = entries[index + 1];
      if (next === undefined || !isDescendant(next.path, entry.path)) continue;
      if (current !== null && incoming === null) {
        visit(entry.path, "current", labels.current, current);
      } else if (incoming !== null && current === null) {
        visit(entry.path, "incoming", labels.incoming, incoming);
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
    visit(entry.path, side, label, identity);
  }
}

function relocationRequests(
  entries: readonly StructuralIntegrationEntry[],
  labels: { current: string; incoming: string },
): RelocationRequest[] {
  const requests: RelocationRequest[] = [];
  visitRelocationRequests(entries, labels, (path, side, label, identity) => {
    requests.push({
      key: relocationKey(path, side),
      path,
      desired: `${path}~${label}`,
      side,
      identity,
    });
  });
  return requests;
}

function allocateRelocations(
  repo: Repository,
  input: VirtualAncestorIntegrationInput,
  requests: readonly RelocationRequest[],
  limits: ResolvedIntegrationLimits,
): Map<string, string> {
  if (requests.length === 0) return new Map();
  const allocator = new RelocationAllocator(requests);
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
  return names;
}

interface ResolvedIntegrationLimits {
  maxSourceRows: number;
  maxEntries: number;
  maxStructureBytes: number | undefined;
  maxPlanBytes: number | undefined;
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
    maxStructureBytes: optionalLimit(limits?.maxStructureBytes, "structure byte"),
    maxPlanBytes: optionalLimit(limits?.maxPlanBytes, "plan byte"),
  };
}

function optionalLimit(value: number | undefined, label: string): number | undefined {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError(`invalid integration ${label} limit`);
  }
  return value;
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
  return pathUnitsBytes(path.length);
}

function pathUnitsBytes(units: number): number {
  return checkedAdd(64, units * 2, "path");
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
  maxPlanBytes: number | undefined,
  passthroughBytes: number,
  resolvedBytes: number,
  path: string,
): number {
  if (maxPlanBytes === undefined) return DEFAULT_TEXT_MERGE_LIMITS.maxOutputBytes;
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
  return planIntegrationInternal(repo, input, null, undefined);
}

/** Collapse conflicts the way Git builds a temporary recursive merge-base tree. */
export function planVirtualAncestorIntegration(
  repo: Repository,
  input: VirtualAncestorIntegrationInput,
): IntegrationPlan {
  return planIntegrationInternal(repo, input, input.labels, input.depth);
}

function planIntegrationInternal(
  repo: Repository,
  input: IntegrationInput,
  virtualLabels: { current: string; incoming: string } | null,
  virtualDepth: number | undefined,
): IntegrationPlan {
  const limits = resolveLimits(input.limits);
  let text = input.text ?? {};
  if (virtualLabels !== null) {
    validateVirtualLabel(virtualLabels.current, "current");
    validateVirtualLabel(virtualLabels.incoming, "incoming");
    const markerSize = virtualMarkerSize(virtualDepth);
    if (input.text?.markerSize !== undefined && input.text.markerSize !== markerSize) {
      throw new GitError("EINVAL", "virtual integration marker size does not match its depth");
    }
    text = {
      ...input.text,
      labels: {
        ...input.text?.labels,
        current: virtualLabels.current,
        incoming: virtualLabels.incoming,
      },
      markerSize,
    };
  }
  const structure = classifyIntegrationStructure(repo, {
    baseTreeOid: input.baseTreeOid,
    currentTreeOid: input.currentTreeOid,
    incomingTreeOid: input.incomingTreeOid,
    limits: {
      maxRows: limits.maxSourceRows,
      maxEntries: limits.maxEntries,
      ...(limits.maxStructureBytes === undefined
        ? {}
        : { maxRetainedBytes: limits.maxStructureBytes }),
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
      ? new Map<string, string>()
      : allocateRelocations(repo, { ...input, labels: virtualLabels }, relocationList, limits);
  const relocationByKey = new Map(relocationList.map((request) => [request.key, request]));
  const requestedOids = stableIdentityVector(candidates);
  const remainingUses = identityUseCounts(candidates);
  for (const request of relocationList) {
    const allocated = relocations.get(request.key);
    if (allocated === undefined) throw new CorruptError("virtual relocation path is missing");
  }

  const resolved = new Map<string, IntegrationEntry>();
  const loaded = new Map<string, Uint8Array>();
  const staticEntries: IntegrationEntry[] = [];
  let passthroughBytes = 0;
  for (const entry of structure.entries) {
    if (candidatePaths.has(entry.path)) continue;
    const entries =
      virtualLabels !== null && entry.kind === "conflict"
        ? collapseVirtualConflict(entry, relocationByKey, relocations)
        : [passThroughEntry(entry)];
    for (const planned of entries) {
      staticEntries.push(planned);
      passthroughBytes = checkedAdd(passthroughBytes, integrationEntryBytes(planned), "plan");
    }
  }
  if (staticEntries.length + candidates.length > limits.maxEntries) {
    throw new GitError("E2BIG", `integration plan exceeds ${limits.maxEntries} entries`);
  }
  if (limits.maxPlanBytes !== undefined && passthroughBytes > limits.maxPlanBytes) {
    throw new GitError("E2BIG", `integration plan exceeds ${limits.maxPlanBytes} retained bytes`);
  }
  let resolvedBytes = 0;
  let remaining = requestedOids;
  let nextCandidate = 0;
  while (nextCandidate < candidates.length) {
    const candidate = candidates[nextCandidate]!;
    const ready = candidateOids(candidate).every((oid) => loaded.has(oid));
    if (!ready) {
      if (remaining.length === 0) {
        throw new CorruptError("integration blob batches ended before all candidates resolved");
      }
      const page = remaining.slice(0, BLOB_READ_PAGE);
      const info = repo.store.objectInfo(page);
      let selected = 0;
      let selectedBytes = 0;
      while (selected < info.length) {
        const object = info[selected];
        const oid = page[selected];
        if (object === undefined || oid === undefined || object.oid !== oid) {
          throw new CorruptError("integration blob metadata is incomplete");
        }
        if (object.type !== "blob") {
          throw new CorruptError(`integration object ${oid} is not a blob`);
        }
        if (selected > 0 && object.size > PACK_BLOB_BATCH_TARGET_BYTES - selectedBytes) {
          break;
        }
        selectedBytes = checkedAdd(selectedBytes, object.size, "blob read payload");
        selected++;
      }
      const selectedOids = page.slice(0, selected);
      const batch = repo.readBlobs(selectedOids, { budgetBytes: Math.max(1, selectedBytes) });
      validateBlobBatch(selectedOids, batch.blobs, batch.remaining, batch.bytes);
      for (const [oid, data] of batch.blobs) loaded.set(oid, data);
      remaining = [...batch.remaining, ...remaining.slice(selected)];
      continue;
    }

    const maxContentBytes = remainingContentCapacity(
      limits.maxPlanBytes,
      passthroughBytes,
      resolvedBytes,
      candidate.path,
    );
    const result = resolveContentCandidate(
      candidate,
      loaded,
      text,
      maxContentBytes,
      virtualLabels !== null,
    );
    const entryBytes = integrationEntryBytes(result);
    const nextPlanBytes = checkedAdd(
      checkedAdd(passthroughBytes, resolvedBytes, "plan"),
      entryBytes,
      "plan",
    );
    if (limits.maxPlanBytes !== undefined && nextPlanBytes > limits.maxPlanBytes) {
      throw new GitError("E2BIG", `integration plan exceeds ${limits.maxPlanBytes} retained bytes`);
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
  }

  if (remaining.length !== 0 || loaded.size !== 0 || remainingUses.size !== 0) {
    throw new CorruptError("integration content phase retained unconsumed blob objects");
  }
  const entries = [...staticEntries, ...resolved.values()].sort((left, right) =>
    comparePaths(left.path, right.path),
  );
  return { entries, sourceRows: structure.sourceRows };
}
