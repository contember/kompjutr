import { CorruptError, GitError } from "../../common/errors.js";
import type { IntegrationEntry as StoredIntegrationEntry } from "../../store/operations/integration-workspace/descriptors.js";
import type { IntegrationPlanHandle } from "../../store/operations/integration-workspace/storage.js";
import type { IntegrationWorkspace } from "../../store/operations/integration-workspace/workspace.js";
import {
  ordinaryContentCandidate,
  passThroughEntry,
  resolveContentCandidate,
  virtualAddAddCandidate,
} from "./integration-content.js";
import { integrationInputs } from "./integration-inputs.js";
import {
  checkedAdd,
  integrationEntryBytes,
  remainingContentCapacity,
  resolveLimits,
} from "./integration-limits.js";
import { validateVirtualLabel, virtualMarkerSize } from "./integration-relocation.js";
import { prepareVirtualRelocations } from "./integration-relocation-owned.js";
import { classifyIntegrationStructureOwned } from "./integration-structure-owned.js";
import type {
  ContentCandidate,
  IntegrationEntry,
  IntegrationInput,
  VirtualAncestorIntegrationInput,
} from "./integration-types.js";

export function planIntegrationOwned(
  workspace: IntegrationWorkspace,
  input: IntegrationInput,
): IntegrationPlanHandle<StoredIntegrationEntry> {
  return plan(workspace, input, null);
}

export function planVirtualAncestorIntegrationOwned(
  workspace: IntegrationWorkspace,
  input: VirtualAncestorIntegrationInput,
): IntegrationPlanHandle<StoredIntegrationEntry> {
  validateVirtualLabel(input.labels.current, "current");
  validateVirtualLabel(input.labels.incoming, "incoming");
  const markerSize = virtualMarkerSize(input.depth);
  if (input.text?.markerSize !== undefined && input.text.markerSize !== markerSize)
    throw new GitError("EINVAL", "virtual integration marker size does not match its depth");
  return plan(
    workspace,
    {
      ...input,
      text: { ...input.text, labels: { ...input.text?.labels, ...input.labels }, markerSize },
    },
    input.labels,
  );
}

function plan(
  workspace: IntegrationWorkspace,
  input: IntegrationInput,
  labels: { current: string; incoming: string } | null,
): IntegrationPlanHandle<StoredIntegrationEntry> {
  const requested = resolveLimits(input.limits);
  const maxEntries = input.limits?.maxEntries ?? Number.MAX_SAFE_INTEGER;
  const structure = classifyIntegrationStructureOwned(workspace, input, {
    maxRows: requested.maxSourceRows,
    maxEntries,
    maxRetainedBytes: requested.maxStructureBytes,
  });
  const collapse =
    labels === null
      ? null
      : prepareVirtualRelocations(workspace, structure, input, labels, requested.maxSourceRows);
  const output = workspace.resolvedPlan();
  let passthroughBytes = 0;
  let count = 0;
  function* staticEntries(): Generator<IntegrationEntry> {
    for (const entry of structure.entries) {
      if (
        entry.kind === "content" ||
        (entry.kind === "conflict" && virtualAddAddCandidate(entry) !== null)
      )
        continue;
      const entries =
        collapse !== null && entry.kind === "conflict"
          ? collapse(entry)
          : [passThroughEntry(entry)];
      yield* entries;
    }
  }
  for (const entry of staticEntries()) {
    count++;
    passthroughBytes = checkedAdd(passthroughBytes, integrationEntryBytes(entry), "plan");
  }
  for (const entry of structure.entries) {
    if (
      entry.kind === "content" ||
      (entry.kind === "conflict" && virtualAddAddCandidate(entry) !== null)
    )
      count++;
  }
  if (count > maxEntries)
    throw new GitError("E2BIG", `integration plan exceeds ${maxEntries} entries`);
  if (requested.maxPlanBytes !== undefined && passthroughBytes > requested.maxPlanBytes)
    throw new GitError(
      "E2BIG",
      `integration plan exceeds ${requested.maxPlanBytes} retained bytes`,
    );
  let resolvedBytes = 0;
  function persist(entry: IntegrationEntry): StoredIntegrationEntry {
    const bytes = entry.content;
    if (bytes === null) return { ...entry, content: null };
    const oid =
      entry.kind === "conflict" && entry.conflict === "binary"
        ? entry.stages.current?.oid
        : workspace.source.write("blob", bytes);
    if (oid === undefined)
      throw new CorruptError("binary integration result lost its current identity");
    return { ...entry, content: { oid, size: bytes.length } };
  }
  function* candidates(): Generator<ContentCandidate> {
    for (const entry of structure.entries) {
      const candidate =
        entry.kind === "content"
          ? ordinaryContentCandidate(entry)
          : entry.kind === "conflict"
            ? virtualAddAddCandidate(entry)
            : null;
      if (candidate !== null) yield candidate;
    }
  }
  function* entries(): Generator<StoredIntegrationEntry> {
    for (const entry of staticEntries()) yield persist(entry);
    for (const { candidate, loaded } of integrationInputs(workspace.source, candidates())) {
      const result = resolveContentCandidate(
        candidate,
        loaded,
        input.text ?? {},
        remainingContentCapacity(
          requested.maxPlanBytes,
          passthroughBytes,
          resolvedBytes,
          candidate.path,
        ),
        labels !== null,
      );
      const size = integrationEntryBytes(result);
      resolvedBytes = checkedAdd(resolvedBytes, size, "resolved plan");
      if (
        requested.maxPlanBytes !== undefined &&
        checkedAdd(passthroughBytes, resolvedBytes, "plan") > requested.maxPlanBytes
      )
        throw new GitError(
          "E2BIG",
          `integration plan exceeds ${requested.maxPlanBytes} retained bytes`,
        );
      yield persist(result);
    }
  }
  output.entries.write(entries());
  output.finish(structure.sourceRows, count);
  return output;
}
