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
import { validateVirtualLabel, virtualMarkerSize } from "./integration-relocation.js";
import { prepareVirtualRelocations } from "./integration-relocation-owned.js";
import { classifyIntegrationStructureOwned } from "./integration-structure-owned.js";
import type {
  ContentCandidate,
  IntegrationEntry,
  IntegrationInput,
  VirtualAncestorIntegrationInput,
} from "./integration-types.js";
import { MAX_INTEGRATION_SOURCE_ROWS } from "./integration-types.js";

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
  const structure = classifyIntegrationStructureOwned(workspace, input, {
    maxRows: MAX_INTEGRATION_SOURCE_ROWS,
  });
  const collapse =
    labels === null
      ? null
      : prepareVirtualRelocations(workspace, structure, input, labels, MAX_INTEGRATION_SOURCE_ROWS);
  const output = workspace.resolvedPlan();
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
  function persist(entry: IntegrationEntry): StoredIntegrationEntry {
    count++;
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
      yield persist(resolveContentCandidate(candidate, loaded, input.text ?? {}, labels !== null));
    }
  }
  output.entries.write(entries());
  output.finish(structure.sourceRows, count);
  return output;
}
