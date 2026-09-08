// Pure content resolution for a bounded three-tree integration plan.

import { CorruptError, GitError } from "../../common/errors.js";
import { comparePaths } from "../../common/streams.js";
import { PACK_BLOB_BATCH_TARGET_BYTES } from "../../store/index.js";
import type { Repository } from "../repository/repository.js";
import {
  candidateOids,
  identityUseCounts,
  ordinaryContentCandidate,
  passThroughEntry,
  resolveContentCandidate,
  stableIdentityVector,
  validateBlobBatch,
  virtualAddAddCandidate,
} from "./integration-content.js";
import {
  checkedAdd,
  integrationEntryBytes,
  remainingContentCapacity,
  resolveLimits,
} from "./integration-limits.js";
import {
  allocateRelocations,
  collapseVirtualConflict,
  relocationRequests,
  validateVirtualLabel,
  virtualMarkerSize,
} from "./integration-relocation.js";
import { classifyIntegrationStructure } from "./integration-structure.js";
import type {
  ContentCandidate,
  IntegrationEntry,
  IntegrationInput,
  IntegrationPlan,
  VirtualAncestorIntegrationInput,
} from "./integration-types.js";

const BLOB_READ_PAGE = 4_096;

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
