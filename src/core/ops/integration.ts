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
import { hashObject } from "../objects.js";
import type { Repository } from "../repository.js";
import {
  type ContentStructuralEntry,
  classifyIntegrationStructure,
  type IntegrationIdentity,
  type IntegrationStages,
  type StructuralConflictKind,
  type StructuralIntegrationEntry,
} from "./integration-structure.js";

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

const FIXED_CALLER_BYTES = 16 * 1024;
const STRUCTURAL_ENTRY_BYTES = 768;
const INTEGRATION_ENTRY_BYTES = 512;
const ID_VECTOR_ENTRY_BYTES = 192;
const BLOB_MAP_ENTRY_BYTES = 128;

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

function stableIdentityVector(entries: readonly ContentStructuralEntry[]): string[] {
  const seen = new Set<string>();
  const oids: string[] = [];
  for (const entry of entries) {
    for (const oid of [entry.base.oid, entry.current.oid, entry.incoming.oid]) {
      if (seen.has(oid)) continue;
      seen.add(oid);
      oids.push(oid);
    }
  }
  return oids;
}

function identityUseCounts(entries: readonly ContentStructuralEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    for (const oid of new Set(candidateOids(entry))) {
      counts.set(oid, (counts.get(oid) ?? 0) + 1);
    }
  }
  return counts;
}

function candidateOids(entry: ContentStructuralEntry): readonly string[] {
  return [entry.base.oid, entry.current.oid, entry.incoming.oid];
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

function resolveContentCandidate(
  entry: ContentStructuralEntry,
  loaded: ReadonlyMap<string, Uint8Array>,
  text: TextMergeOptions,
  reservation: MemoryReservation,
  retainedBytes: number,
  maxContentBytes: number,
): IntegrationEntry {
  const base = loaded.get(entry.base.oid);
  const current = loaded.get(entry.current.oid);
  const incoming = loaded.get(entry.incoming.oid);
  if (base === undefined || current === undefined || incoming === undefined) {
    throw new CorruptError("integration blob batch omitted a required candidate object");
  }
  const boundedText = boundTextOutput(text, maxContentBytes);
  const memory = estimateTextMergeMemory(base, current, incoming, boundedText);
  reservation.set("other", checkedAdd(retainedBytes, memory.peakBytes, "memory"));
  const merged = mergeText(base, current, incoming, boundedText);
  const stages = { base: entry.base, current: entry.current, incoming: entry.incoming };
  if (merged.kind === "binary") {
    if (current.length > maxContentBytes) {
      throw new GitError("E2BIG", `integration plan exceeds its retained content capacity`);
    }
    return { kind: "conflict", path: entry.path, conflict: "binary", stages, content: current };
  }
  if (merged.kind === "conflict") {
    return {
      kind: "conflict",
      path: entry.path,
      conflict: "content",
      stages,
      content: merged.content,
      conflicts: merged.conflicts,
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
    const candidates = structure.entries.filter(
      (entry): entry is ContentStructuralEntry => entry.kind === "content",
    );
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
    requireCallerHeadroom(staticBytes);

    const resolved = new Map<string, IntegrationEntry>();
    const loaded = new Map<string, Uint8Array>();
    let passthroughBytes = 0;
    for (const entry of structure.entries) {
      if (entry.kind !== "content") {
        passthroughBytes = checkedAdd(
          passthroughBytes,
          integrationEntryBytes(passThroughEntry(entry)),
          "plan",
        );
      }
    }
    if (passthroughBytes > limits.maxPlanBytes) {
      throw new GitError("E2BIG", `integration plan exceeds ${limits.maxPlanBytes} retained bytes`);
    }

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
    const finalArrayBytes = structure.entries.length * ID_VECTOR_ENTRY_BYTES;
    const finalPeak = checkedAdd(
      callerRetainedBytes(staticBytes, resolvedBytes, loaded),
      checkedAdd(finalArrayBytes, passthroughBytes, "final plan"),
      "final plan",
    );
    reservation.set("other", finalPeak);
    const entries: IntegrationEntry[] = [];
    for (const entry of structure.entries) {
      if (entry.kind !== "content") {
        entries.push(passThroughEntry(entry));
        continue;
      }
      const content = resolved.get(entry.path);
      if (content === undefined) throw new CorruptError("integration content result is missing");
      entries.push(content);
    }
    return {
      entries,
      sourceRows: structure.sourceRows,
      blobReadCalls,
      memoryHighWaterBytes: reservation.highWaterBytes,
    };
  } finally {
    reservation.dispose();
  }
}
